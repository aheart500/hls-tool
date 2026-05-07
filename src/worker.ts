#!/usr/bin/env node
/**
 * Worker entrypoint used in AWS deployments.
 *
 * Two modes:
 *
 *   1. BATCH mode (default when JOB_INPUT_BUCKET / JOB_INPUT_KEY env vars are
 *      set, or when AWS_BATCH_JOB_ID is present): process exactly one job
 *      described by env vars, then exit. This is the model AWS Batch expects.
 *
 *   2. SQS mode (when SQS_QUEUE_URL is set and no inline job spec): long-poll
 *      an SQS queue forever, process each message, delete on success. This is
 *      the model an ECS service would use.
 *
 * Job message shape (SQS body or inline JSON via JOB_SPEC env var):
 *   {
 *     "inputBucket":  "uploads-bucket",
 *     "inputKey":     "videos/<uuid>/source.mp4",
 *     "outputBucket": "hls-bucket",
 *     "outputPrefix": "hls/<uuid>/",
 *     "sourceResolution": "1080p",   // optional; falls back to ffprobe
 *     "videoFileId":  123,           // optional; for DB status update
 *     "jobId":        "abc-123"      // optional; recorded in DB
 *   }
 *
 * Required IAM:
 *   - s3:GetObject on input bucket
 *   - s3:PutObject on output bucket
 *   - sqs:ReceiveMessage / DeleteMessage / ChangeMessageVisibility (SQS mode)
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import type { Readable } from "node:stream";

import { convertToHls } from "./index.js";
import { RESOLUTION_MAP } from "./renditions.js";

interface JobSpec {
  inputBucket: string;
  inputKey: string;
  outputBucket: string;
  outputPrefix: string;
  sourceResolution?: keyof typeof RESOLUTION_MAP;
  /** Force the playlist/segment base name (default: input filename without ext). */
  baseName?: string;
  videoFileId?: number;
  jobId?: string;
}

const region = process.env.AWS_REGION ?? "us-east-1";
// AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL let us point S3 at LocalStack or MinIO
// for local testing. forcePathStyle is required by both.
const s3CustomEndpoint =
  process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL;
const s3 = new S3Client({
  region,
  ...(s3CustomEndpoint
    ? { endpoint: s3CustomEndpoint, forcePathStyle: true }
    : {}),
});

async function main(): Promise<void> {
  const inlineSpec = readInlineJobSpec();
  if (inlineSpec) {
    await processJob(inlineSpec);
    return;
  }

  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    throw new Error(
      "No job source configured. Set JOB_SPEC / JOB_INPUT_BUCKET+KEY env " +
        "(Batch mode) or SQS_QUEUE_URL (SQS mode).",
    );
  }
  await runSqsLoop(queueUrl);
}

/** Read a job spec from env vars (used by AWS Batch). */
function readInlineJobSpec(): JobSpec | null {
  if (process.env.JOB_SPEC) {
    return JSON.parse(process.env.JOB_SPEC) as JobSpec;
  }
  if (process.env.JOB_INPUT_BUCKET && process.env.JOB_INPUT_KEY) {
    return {
      inputBucket: process.env.JOB_INPUT_BUCKET,
      inputKey: process.env.JOB_INPUT_KEY,
      outputBucket:
        process.env.JOB_OUTPUT_BUCKET ?? process.env.JOB_INPUT_BUCKET,
      outputPrefix: process.env.JOB_OUTPUT_PREFIX ?? "hls/",
      sourceResolution: process.env.JOB_SOURCE_RESOLUTION as
        | keyof typeof RESOLUTION_MAP
        | undefined,
      baseName: process.env.JOB_BASE_NAME,
      videoFileId: process.env.JOB_VIDEO_FILE_ID
        ? Number(process.env.JOB_VIDEO_FILE_ID)
        : undefined,
      jobId: process.env.JOB_ID,
    };
  }
  return null;
}

async function runSqsLoop(queueUrl: string): Promise<void> {
  const sqs = new SQSClient({ region });
  log("info", `SQS worker started, polling ${queueUrl}`);

  // graceful shutdown for ECS task stops
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      log("info", `received ${sig}, finishing current message then exiting`);
      shuttingDown = true;
    });
  }

  while (!shuttingDown) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20, // long-poll
        VisibilityTimeout: 60 * 60 * 4, // 4h ceiling; we also extend below
      }),
    );

    const msg = res.Messages?.[0];
    if (!msg?.Body || !msg.ReceiptHandle) continue;

    const spec = JSON.parse(msg.Body) as JobSpec;

    // Periodically extend visibility while encoding so a slow job isn't
    // re-delivered to another worker.
    const heartbeat = setInterval(
      () => {
        sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle!,
              VisibilityTimeout: 60 * 30, // keep pushing 30 min ahead
            }),
          )
          .catch((err) => log("warn", `heartbeat failed: ${err.message}`));
      },
      60 * 1000 * 10,
    );

    try {
      await processJob(spec);
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
      log("info", `job complete: ${spec.inputKey}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", `job failed: ${spec.inputKey}: ${message}`);
      // do NOT delete; SQS will redrive after visibility timeout. After
      // maxReceiveCount the message goes to the DLQ.
    } finally {
      clearInterval(heartbeat);
    }
  }
}

async function processJob(spec: JobSpec): Promise<void> {
  validateSpec(spec);

  const workDir = await mkdtemp(path.join(tmpdir(), "hls-"));
  const inputDir = path.join(workDir, "in");
  const outputDir = path.join(workDir, "out");

  try {
    log(
      "info",
      `start: s3://${spec.inputBucket}/${spec.inputKey} -> ` +
        `s3://${spec.outputBucket}/${spec.outputPrefix}`,
    );

    const localInput = path.join(
      inputDir,
      sanitizeFilename(path.basename(spec.inputKey)),
    );
    await downloadFromS3(spec.inputBucket, spec.inputKey, localInput);

    const baseName =
      spec.baseName ?? stripExtension(path.basename(spec.inputKey));

    let lastLogged = -10;
    const result = await convertToHls({
      inputPath: localInput,
      outputDir,
      sourceResolution: spec.sourceResolution,
      baseName,
      onProgress: (p) => {
        const pct = Math.floor(p * 100);
        // Log every 10% to avoid log spam in CloudWatch.
        if (pct >= lastLogged + 10) {
          lastLogged = pct;
          log("info", `progress ${pct}%`);
        }
      },
    });

    log(
      "info",
      `encoded ${result.renditions.length} renditions ` +
        `(source=${result.sourceResolution}); uploading...`,
    );

    await uploadDirToS3(outputDir, spec.outputBucket, spec.outputPrefix);
    log("info", `upload complete`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validateSpec(spec: JobSpec): void {
  for (const field of [
    "inputBucket",
    "inputKey",
    "outputBucket",
    "outputPrefix",
  ] as const) {
    if (!spec[field] || typeof spec[field] !== "string") {
      throw new Error(`Invalid job spec: missing "${field}"`);
    }
  }
}

async function downloadFromS3(
  bucket: string,
  key: string,
  destPath: string,
): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(destPath), { recursive: true });

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) {
    throw new Error(`Empty response body from S3 for ${bucket}/${key}`);
  }

  await pipeline(res.Body as Readable, createWriteStream(destPath));
  const s = await stat(destPath);
  log("info", `downloaded ${s.size} bytes -> ${destPath}`);
}

async function uploadDirToS3(
  localDir: string,
  bucket: string,
  prefix: string,
): Promise<void> {
  const cleanPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const files = await readdir(localDir);

  // Upload in small parallel batches to keep memory predictable.
  const concurrency = 4;
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < files.length) {
        const idx = i++;
        const file = files[idx];
        const localPath = path.join(localDir, file);
        const key = `${cleanPrefix}${file}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: createReadStream(localPath),
            ContentType: contentTypeFor(file),
            CacheControl: cacheControlFor(file),
          }),
        );
      }
    }),
  );
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filename.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

function cacheControlFor(filename: string): string {
  // Manifests change as new segments are added (not in VOD, but be safe).
  // Segments are immutable once written.
  if (filename.endsWith(".m3u8")) return "public, max-age=60";
  return "public, max-age=31536000, immutable";
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_") || "input";
}

function log(level: "info" | "warn" | "error", msg: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

main().catch((err) => {
  log("error", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
