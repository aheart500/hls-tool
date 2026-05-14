/**
 * S3 -> Batch trigger Lambda.
 *
 * Drop-in replacement for the original MediaConvert Lambda. On each S3
 * `videos/<uuid>/<file>` upload it:
 *   1. Looks up `original_resoultion` for the video in Postgres.
 *   2. Submits an AWS Batch job that runs the hls-tool container.
 *   3. Updates the VideoFile row to PROCESSING with the Batch jobId.
 *
 * The DB calls use parameterized queries (the original Lambda did string
 * interpolation, which is a SQL injection risk).
 *
 * Required env vars:
 *   BATCH_JOB_QUEUE          ARN or name of the Batch job queue
 *   BATCH_JOB_DEFINITION     ARN or name of the Batch job definition
 *   OUTPUT_BUCKET            S3 bucket for HLS output
 *   OUTPUT_PREFIX            Optional, default "hls/"
 *   RDS_ENDPOINT             Postgres connection string (non-prod)
 *   RDS_ENDPOINT_PRODUCTION  Postgres connection string (prod)
 *   PRODUCTION_BUCKET        Bucket name considered "production" (default "medc")
 */
import {
  BatchClient,
  SubmitJobCommand,
  type SubmitJobCommandInput,
} from "@aws-sdk/client-batch";
import type { S3Event } from "aws-lambda";
import { Client } from "pg";

const batch = new BatchClient({});

const PRODUCTION_BUCKET = process.env.PRODUCTION_BUCKET ?? "medc";

export async function handler(
  event: S3Event,
): Promise<{ statusCode: number; body: string }> {
  const required = ["BATCH_JOB_QUEUE", "BATCH_JOB_DEFINITION", "OUTPUT_BUCKET"];
  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing env var: ${k}`);
  }

  const results: Array<{ key: string; status: string; jobId?: string }> = [];

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const isProduction = bucket === PRODUCTION_BUCKET;

    if (!key.startsWith("videos/")) {
      console.log(`skip: ${key} not in videos/`);
      results.push({ key, status: "skipped" });
      continue;
    }

    const folderUuid = key.split("/").slice(-2, -1)[0];
    if (!folderUuid) {
      console.log(`skip: ${key} has no <uuid> folder`);
      results.push({ key, status: "skipped" });
      continue;
    }

    try {
      const sourceResolution = await getOriginalResolution(key, isProduction);

      const submit: SubmitJobCommandInput = {
        jobName: `hls-${folderUuid}-${Date.now()}`.slice(0, 128),
        jobQueue: process.env.BATCH_JOB_QUEUE,
        jobDefinition: process.env.BATCH_JOB_DEFINITION,
        // Pass the job spec as container env vars; worker.ts reads these.
        containerOverrides: {
          environment: [
            { name: "JOB_INPUT_BUCKET", value: bucket },
            { name: "JOB_INPUT_KEY", value: key },
            { name: "JOB_OUTPUT_BUCKET", value: process.env.OUTPUT_BUCKET! },
            {
              name: "JOB_OUTPUT_PREFIX",
              value: `${process.env.OUTPUT_PREFIX ?? "hls/"}${folderUuid}/`,
            },
            // Force the master playlist filename to "video.m3u8" so the
            // resulting URL matches what the DB expects:
            //   hls/<uuid>/video.m3u8
            { name: "JOB_BASE_NAME", value: "video" },
            ...(sourceResolution
              ? [{ name: "JOB_SOURCE_RESOLUTION", value: sourceResolution }]
              : []),
          ],
        },
        // Tags are surfaced in the Batch Job State Change EventBridge event
        // and are how the completion Lambda identifies the affected video.
        propagateTags: false,
        tags: {
          fileKey: key,
          isProduction: isProduction ? "true" : "false",
          bucket,
        },
        // Retry once on infrastructure errors (Spot interruption etc.) but
        // not on application errors.
        retryStrategy: {
          attempts: 2,
          evaluateOnExit: [
            { onStatusReason: "Host EC2*", action: "RETRY" },
            {
              onStatusReason: "Your Spot Task was interrupted*",
              action: "RETRY",
            },
            { onReason: "*", action: "EXIT" },
          ],
        },
        // 6h ceiling - tune to your longest expected video.
        timeout: { attemptDurationSeconds: 6 * 60 * 60 },
      };

      const res = await batch.send(new SubmitJobCommand(submit));
      console.log(`submitted batch job ${res.jobId} for ${key}`);

      if (res.jobId) {
        await updateVideoFileStatus(key, res.jobId, isProduction);
      }

      results.push({ key, status: "submitted", jobId: res.jobId });
    } catch (err) {
      console.error(`failed to submit job for ${key}:`, err);
      results.push({
        key,
        status: "error",
      });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ results }),
  };
}

function pickConnectionString(isProduction: boolean): string {
  const cs = isProduction
    ? process.env.RDS_ENDPOINT_PRODUCTION
    : process.env.RDS_ENDPOINT;
  if (!cs) {
    throw new Error(
      `Missing ${isProduction ? "RDS_ENDPOINT_PRODUCTION" : "RDS_ENDPOINT"}`,
    );
  }
  return cs;
}

async function getOriginalResolution(
  key: string,
  isProduction: boolean,
): Promise<string | undefined> {
  const client = new Client({
    connectionString: pickConnectionString(isProduction),
    ssl: pgSslOption(),
  });
  try {
    await client.connect();
    const res = await client.query<{ original_resoultion: string | null }>(
      `SELECT original_resoultion FROM "VideoFile" WHERE key = $1 LIMIT 1`,
      [key],
    );
    if (res.rows.length === 0) {
      console.log(`video not in DB: ${key}`);
      return undefined;
    }
    return res.rows[0].original_resoultion ?? undefined;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function updateVideoFileStatus(
  key: string,
  jobId: string,
  isProduction: boolean,
): Promise<void> {
  const client = new Client({
    connectionString: pickConnectionString(isProduction),
    ssl: pgSslOption(),
  });
  try {
    await client.connect();
    await client.query(
      `UPDATE "VideoFile" SET status = 'PROCESSING', "jobId" = $1 WHERE key = $2`,
      [jobId, key],
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Postgres SSL option. Defaults to `{ rejectUnauthorized: false }` for RDS,
 * but set `PGSSL=disable` to turn SSL off entirely (e.g. when running against
 * a local Postgres container in tests).
 */
function pgSslOption(): false | { rejectUnauthorized: boolean } {
  if ((process.env.PGSSL ?? "").toLowerCase() === "disable") return false;
  return { rejectUnauthorized: false };
}
