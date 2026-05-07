/**
 * End-to-end local test of the AWS pipeline -- without AWS.
 *
 * It exercises the same code paths the cloud will run, against:
 *   - LocalStack S3 (endpoint http://localhost:4566)
 *   - Postgres in Docker (port 5433, db "hls")
 *
 * Steps:
 *   1. Seed an input video into LocalStack S3 under videos/<uuid>/<file>.
 *   2. Insert a VideoFile row matching that key.
 *   3. Run the WORKER directly (skipping Batch -- we just want to validate
 *      that the encode + S3 upload pipeline works against the LocalStack
 *      bucket).
 *   4. Synthesise a "Batch Job State Change SUCCEEDED" event and invoke the
 *      completion Lambda handler in-process.
 *   5. Assert that the DB row is COMPLETED and url points at video.m3u8.
 *
 * Run with:
 *   docker compose -f test/docker-compose.yml up -d
 *   tsx test/run-local-flow.ts ./eman.mp4
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Client } from "pg";

const ENDPOINT = "http://localhost:4566";
const REGION = "us-east-1";
const UPLOAD_BUCKET = "uploads";
const OUTPUT_BUCKET = "hls-output";
const PG = "postgres://hls:hls@localhost:5433/hls";

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile || !existsSync(inputFile)) {
    console.error("Usage: tsx test/run-local-flow.ts <path-to-source-video>");
    process.exit(2);
  }

  const uuid = randomUUID();
  const filename = path.basename(inputFile);
  const key = `videos/${uuid}/${filename}`;

  console.log(`==> uuid=${uuid}`);

  // ---- 1. ensure buckets exist ----
  await ensureBucket(UPLOAD_BUCKET);
  await ensureBucket(OUTPUT_BUCKET);

  // ---- 2. upload source ----
  const fileSize = (await stat(inputFile)).size;
  console.log(
    `==> uploading ${filename} (${fileSize} bytes) to s3://${UPLOAD_BUCKET}/${key}`,
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: UPLOAD_BUCKET,
      Key: key,
      Body: createReadStream(inputFile),
      ContentLength: fileSize,
    }),
  );

  // ---- 3. seed VideoFile row ----
  const fakeJobId = `local-${uuid}`;
  await withDb(async (db) => {
    await db.query(`DELETE FROM "VideoFile" WHERE key = $1`, [key]);
    await db.query(
      `INSERT INTO "VideoFile" (key, original_resoultion, status, "jobId")
       VALUES ($1, $2, 'PROCESSING', $3)`,
      [key, "1080p", fakeJobId],
    );
  });
  console.log(`==> seeded VideoFile row with jobId=${fakeJobId}`);

  // ---- 4. run the worker as a child process ----
  console.log(`==> running worker...`);
  await runWorker({
    JOB_INPUT_BUCKET: UPLOAD_BUCKET,
    JOB_INPUT_KEY: key,
    JOB_OUTPUT_BUCKET: OUTPUT_BUCKET,
    JOB_OUTPUT_PREFIX: `hls/${uuid}/`,
    JOB_BASE_NAME: "video",
    JOB_SOURCE_RESOLUTION: "1080p",
    AWS_REGION: REGION,
    AWS_ENDPOINT_URL_S3: ENDPOINT,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
  });

  // ---- 5. verify outputs landed in S3 ----
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: OUTPUT_BUCKET,
      Prefix: `hls/${uuid}/`,
    }),
  );
  const keys = (listed.Contents ?? []).map((o) => o.Key!).sort();
  console.log(`==> ${keys.length} objects uploaded:`);
  for (const k of keys.slice(0, 5)) console.log(`     ${k}`);
  if (keys.length > 5) console.log(`     ...`);
  assert(
    keys.includes(`hls/${uuid}/video.m3u8`),
    "master playlist video.m3u8 not found",
  );

  // ---- 6. invoke completion Lambda in-process ----
  console.log(`==> invoking completion Lambda...`);
  process.env.RDS_ENDPOINT = PG;
  process.env.RDS_ENDPOINT_PRODUCTION = PG;
  process.env.PRODUCTION_BUCKET = "medc"; // doesn't match -> isProduction=false branch
  process.env.PGSSL = "disable"; // local Postgres container has no SSL
  const completion =
    await import("../infra/completion-lambda/src/index.js").catch(
      () =>
        // fallback for tsx running .ts directly
        import("../infra/completion-lambda/src/index.ts" as string),
    );
  await completion.handler({
    version: "0",
    id: "test",
    "detail-type": "Batch Job State Change",
    source: "aws.batch",
    account: "000000000000",
    time: new Date().toISOString(),
    region: REGION,
    resources: [],
    detail: {
      jobId: fakeJobId,
      status: "SUCCEEDED",
      tags: {
        fileKey: key,
        bucket: UPLOAD_BUCKET,
        isProduction: "false",
      },
    },
  } as any);

  // ---- 7. verify DB ----
  await withDb(async (db) => {
    const r = await db.query(
      `SELECT status, url FROM "VideoFile" WHERE "jobId" = $1`,
      [fakeJobId],
    );
    console.log(`==> DB row:`, r.rows[0]);
    assert(r.rows[0]?.status === "COMPLETED", "status should be COMPLETED");
    assert(
      r.rows[0]?.url === `hls/${uuid}/video.m3u8`,
      "url should point at master playlist",
    );
  });

  console.log("\nLocal flow PASSED.");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function ensureBucket(name: string): Promise<void> {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") {
      throw err;
    }
  }
}

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: PG });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function runWorker(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/worker.js"], {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`worker exited with code ${code}`)),
    );
  });
}

main().catch((err) => {
  console.error("\nLocal flow FAILED:", err);
  process.exit(1);
});
