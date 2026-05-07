/**
 * Batch Job State Change -> VideoFile status update.
 *
 * Drop-in replacement for the original MediaConvert "complete" Lambda. It is
 * triggered by EventBridge when a Batch job in our queue transitions to a
 * terminal state (SUCCEEDED or FAILED), and updates the matching VideoFile
 * row with the final status and the public HLS URL.
 *
 * Event shape (AWS Batch Job State Change):
 *   {
 *     "source": "aws.batch",
 *     "detail-type": "Batch Job State Change",
 *     "detail": {
 *       "jobId": "...",
 *       "jobName": "...",
 *       "status": "SUCCEEDED" | "FAILED" | ...,
 *       "tags": { "fileKey": "...", "isProduction": "true"|"false", "bucket": "..." }
 *     }
 *   }
 *
 * Required env vars:
 *   RDS_ENDPOINT             Postgres connection string (non-prod)
 *   RDS_ENDPOINT_PRODUCTION  Postgres connection string (prod)
 *   PRODUCTION_BUCKET        Bucket name considered "production" (default "medc")
 */
import type { EventBridgeEvent } from "aws-lambda";
import { Client } from "pg";

const PRODUCTION_BUCKET = process.env.PRODUCTION_BUCKET ?? "medc";

interface BatchJobStateChangeDetail {
  jobId: string;
  jobName?: string;
  jobQueue?: string;
  status: string;
  statusReason?: string;
  tags?: Record<string, string>;
}

export async function handler(
  event: EventBridgeEvent<"Batch Job State Change", BatchJobStateChangeDetail>,
): Promise<{ statusCode: number; body: string }> {
  const detail = event.detail;
  const jobId = detail.jobId;
  const status = mapStatus(detail.status);

  // We only act on terminal states. The EventBridge rule should already
  // filter for these, but guard here too in case the rule is widened.
  if (!status) {
    console.log(`ignoring non-terminal status ${detail.status} for ${jobId}`);
    return { statusCode: 200, body: "ignored: non-terminal" };
  }

  const tags = detail.tags ?? {};
  const isProduction =
    tags.isProduction === "true" && tags.bucket === PRODUCTION_BUCKET;

  const cs = isProduction
    ? process.env.RDS_ENDPOINT_PRODUCTION
    : process.env.RDS_ENDPOINT;
  if (!cs) {
    throw new Error(
      `Missing ${isProduction ? "RDS_ENDPOINT_PRODUCTION" : "RDS_ENDPOINT"}`,
    );
  }

  const client = new Client({
    connectionString: cs,
    ssl: pgSslOption(),
  });

  try {
    await client.connect();

    const videos = await client.query<{ id: number; key: string }>(
      `SELECT id, key FROM "VideoFile" WHERE "jobId" = $1 LIMIT 1`,
      [jobId],
    );

    if (videos.rows.length === 0) {
      console.log(`no VideoFile row for jobId=${jobId} -- skipping`);
      return { statusCode: 200, body: "no matching VideoFile" };
    }

    const video = videos.rows[0];
    const folderUuid = video.key.split("/").slice(-2, -1)[0];
    const dest = `hls/${folderUuid}/video.m3u8`;

    if (status === "COMPLETED") {
      await client.query(
        `UPDATE "VideoFile" SET url = $1, status = $2 WHERE id = $3`,
        [dest, status, video.id],
      );
    } else {
      // On failure leave url null and just record FAILED status.
      await client.query(`UPDATE "VideoFile" SET status = $1 WHERE id = $2`, [
        status,
        video.id,
      ]);
    }

    console.log(
      `updated VideoFile id=${video.id} jobId=${jobId} -> ${status}` +
        (status === "COMPLETED" ? ` url=${dest}` : ""),
    );
    return { statusCode: 200, body: "ok" };
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

function mapStatus(batchStatus: string): "COMPLETED" | "FAILED" | null {
  if (batchStatus === "SUCCEEDED") return "COMPLETED";
  if (batchStatus === "FAILED") return "FAILED";
  return null;
}
