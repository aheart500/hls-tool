# hls-tool

Local, cross-platform CLI that produces HLS output identical in structure and settings to the AWS MediaConvert job from the original Lambda. Runs anywhere FFmpeg runs (Windows, Linux, macOS).

## What it does

- Takes a single input video and emits a multi-bitrate HLS package.
- Generates a master `.m3u8` plus one `.m3u8` and matching `.ts` segments per rendition (1080p / 720p / 480p), all in a single output directory (matches MediaConvert `DirectoryStructure: SINGLE_DIRECTORY`).
- Selects which renditions to emit using the same resolution map as the Lambda.
- Encodes once: a single FFmpeg invocation decodes the source one time and emits all renditions in parallel.

## Install

### 1. Install FFmpeg (must be on PATH)

| OS                   | Command                       |
| -------------------- | ----------------------------- |
| macOS (Homebrew)     | `brew install ffmpeg`         |
| Windows (winget)     | `winget install Gyan.FFmpeg`  |
| Windows (Chocolatey) | `choco install ffmpeg`        |
| Debian / Ubuntu      | `sudo apt-get install ffmpeg` |
| Fedora               | `sudo dnf install ffmpeg`     |
| Arch                 | `sudo pacman -S ffmpeg`       |

Verify: `ffmpeg -version` and `ffprobe -version`.

### 2. Install the tool

```bash
npm install
npm run build
```

## Usage

Run from source during development (no build step):

```bash
npm run dev -- --input ./sample.mp4 --output ./out
```

Or, after `npm run build`:

```bash
node dist/cli.js --input ./sample.mp4 --output ./out
```

Or link globally:

```bash
npm link
hls-tool --input ./sample.mp4 --output ./out
```

### Options

```
-i, --input <file>           Path to input video file (required)
-o, --output <dir>           Output directory (required)
-r, --resolution <label>     Override source resolution label
                             (2160p|1440p|1080p|720p|480p|360p|240p|144p)
-n, --name <basename>        Base name for playlists/segments
                             (defaults to input filename without extension)
    --ffmpeg <path>          Custom ffmpeg path
    --ffprobe <path>         Custom ffprobe path
    --preset <preset>        x264 preset (ultrafast..placebo). Default: medium
    --quiet                  Suppress progress output
```

### Examples

```bash
# Auto-detect source resolution; emit appropriate renditions
hls-tool -i ./video.mp4 -o ./hls/abc-uuid

# Force resolution map (matches Lambda's DB-driven behaviour)
hls-tool -i ./video.mp4 -o ./hls/abc-uuid --resolution 1080p

# Faster encode for previews
hls-tool -i ./video.mp4 -o ./hls/abc-uuid --preset veryfast
```

### Output layout

For an input named `video.mp4`, the output directory will contain:

```
video.m3u8                  # master playlist
video_1080p.m3u8            # rendition playlists
video_720p.m3u8
video_480p.m3u8
video_1080p_00000.ts        # segments (single directory)
video_1080p_00001.ts
...
video_720p_00000.ts
...
video_480p_00000.ts
...
```

This mirrors the MediaConvert HLS group with `SINGLE_DIRECTORY` + per-output `NameModifier`.

## Programmatic use

```ts
import { convertToHls } from "hls-tool";

await convertToHls({
  inputPath: "./video.mp4",
  outputDir: "./out",
  sourceResolution: "1080p", // optional, auto-detected if omitted
  onProgress: (p) => console.log(`${(p * 100).toFixed(1)}%`),
});
```

## How AWS MediaConvert settings map to FFmpeg

| MediaConvert setting                                                        | FFmpeg equivalent                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Codec: H_264`, `CodecProfile: HIGH`                                        | `-c:v libx264 -profile:v high`                                      |
| `RateControlMode: QVBR` + `QvbrQualityLevel`                                | `-crf` (quality-based), level 9→19, 7→21, 5→23                      |
| `MaxBitrate`                                                                | `-maxrate <N> -bufsize <2N>`                                        |
| `GopSize: 90`                                                               | `-g 90 -keyint_min 90`                                              |
| `GopBReference: ENABLED`                                                    | `-bf 3 -x264opts b-pyramid=normal`                                  |
| `SceneChangeDetect: TRANSITION_DETECTION`                                   | x264 default `-sc_threshold 40`                                     |
| `FramerateControl: INITIALIZE_FROM_SOURCE`                                  | no `-r` flag (inherits source)                                      |
| `Codec: AAC`, `Bitrate`, `SampleRate: 48000`, `CodingMode: CODING_MODE_2_0` | `-c:a aac -b:a <N> -ar 48000 -ac 2`                                 |
| `SegmentLength: 4`                                                          | `-hls_time 4`                                                       |
| `DirectoryStructure: SINGLE_DIRECTORY`                                      | flat naming via `-var_stream_map name:` and `-hls_segment_filename` |
| `OutputSelection: MANIFESTS_AND_SEGMENTS`                                   | HLS muxer default                                                   |
| `NameModifier: _1080p` etc.                                                 | `name:1080p` in `-var_stream_map`, used to substitute `%v`          |

### CRF vs. QVBR

QVBR is a proprietary quality-targeted rate control. FFmpeg's closest equivalent is CRF. The CRF values chosen produce visually comparable results at the configured `MaxBitrate` ceilings; tweak in [`src/renditions.ts`](src/renditions.ts) if you need to match a specific output.

## Differences from the Lambda

This tool replaces only the transcoding part of the Lambda. The S3 trigger, Postgres status updates, and AWS credentials handling are out of scope — wrap the CLI or import `convertToHls()` from your own pipeline if you need those.

## AWS deployment (S3 → Batch → S3)

The repo also ships an end-to-end deployment that swaps MediaConvert for the same FFmpeg pipeline running on AWS Batch (Fargate Spot). Architecture:

```
S3 upload (videos/<uuid>/file.mp4)
        │
        ▼
S3 ObjectCreated event
        │
        ▼
Trigger Lambda  ── reads original_resoultion from Postgres
        │           updates VideoFile to PROCESSING
        │           tags Batch job with fileKey/bucket/isProduction
        ▼
AWS Batch SubmitJob
        │
        ▼
Fargate Spot task (this repo's Docker image)
        │           downloads source from S3
        │           runs convertToHls() (= ffmpeg)
        ▼           uploads renditions to output bucket
S3 (hls/<uuid>/video.m3u8 + renditions)
        │
        ▼ (Batch Job State Change event)
        │
        ▼
Completion Lambda ── updates VideoFile to COMPLETED/FAILED
                     sets url = "hls/<uuid>/video.m3u8"
        │
        ▼
CloudFront (recommended)
```

### Files

| Path                                                               | Purpose                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [Dockerfile](Dockerfile)                                           | Container image (Node 20 + ffmpeg + the worker)                                                     |
| [src/worker.ts](src/worker.ts)                                     | Worker entrypoint. Runs once per Batch job, or polls SQS in a loop                                  |
| [infra/trigger-lambda/](infra/trigger-lambda/)                     | Lambda that receives S3 events, looks up resolution in Postgres, and submits Batch jobs             |
| [infra/completion-lambda/](infra/completion-lambda/)               | Lambda fired by EventBridge on terminal Batch state, sets VideoFile.status = COMPLETED/FAILED + url |
| [infra/terraform/](infra/terraform/)                               | Terraform for S3 / ECR / Batch / IAM / Lambdas / EventBridge                                        |
| [infra/scripts/build-and-push.sh](infra/scripts/build-and-push.sh) | Build & push the worker image to ECR                                                                |
| [infra/scripts/build-lambda.sh](infra/scripts/build-lambda.sh)     | Bundle both Lambda zips Terraform consumes                                                          |

### Deploy

```bash
# 1. Build both Lambda zips (Terraform expects them to exist)
./infra/scripts/build-lambda.sh

# 2. Provision infrastructure
cd infra/terraform
cat > terraform.tfvars <<EOF
region                 = "us-east-1"
uploads_bucket_name    = "medc"
output_bucket_name     = "medc"
production_bucket_name = "medc"
rds_endpoint           = "postgresql://..."
rds_endpoint_production= "postgresql://..."
vpc_id                 = "vpc-xxxx"
subnet_ids             = ["subnet-xxx", "subnet-xxx"]   # private + NAT, OR public
assign_public_ip       = true                          # true if using public subnets
EOF
terraform init
terraform apply

# 3. Build & push the worker image to the ECR repo Terraform created
ECR_URL=$(terraform output -raw ecr_repository_url) \
AWS_REGION=us-east-1 \
  ../scripts/build-and-push.sh

# 4. (Re-deploy Lambda code if you change it)
cd ../.. && ./infra/scripts/build-lambda.sh
cd infra/terraform && terraform apply
```

After this, any object uploaded under `s3://<uploads-bucket>/videos/<uuid>/<file>` will trigger the chain end-to-end:

1. **Trigger Lambda** marks the row `PROCESSING` and submits a Batch job tagged with the row's `key`, `bucket`, and `isProduction` flag.
2. **Batch / Fargate** runs the worker; output lands at `s3://<output-bucket>/hls/<uuid>/video.m3u8` (+ rendition playlists/segments).
3. **Completion Lambda** receives the EventBridge "Batch Job State Change" event, looks up the row by `jobId`, and sets `status = COMPLETED` + `url = hls/<uuid>/video.m3u8` (or `FAILED` on a failed job).

### Cost notes

- **Fargate Spot** is enabled by default (`use_fargate_spot = true`). Expect ~70% savings vs. on-demand Fargate. Jobs are retried once on Spot interruption.
- Default sizing is **4 vCPU / 8 GB / 50 GB ephemeral**. Bump for 4K sources via `job_vcpu`, `job_memory_mib`, `job_ephemeral_storage_gib`.
- For ~50 × 1-hour 1080p videos/month with 3 renditions, expect **~$5–10/month** in compute (Spot) or **~$15–28** on-demand. CloudFront egress to viewers is the larger ongoing cost regardless of transcoder.
- ECR lifecycle policy keeps only the last 10 images.

### Operational tips

- **Tune the x264 preset** in `src/renditions.ts` / via the CLI. Default `medium` is closest to MediaConvert quality; `veryfast` roughly halves compute cost with a small quality hit.
- **Logs** go to `/aws/batch/<prefix>-worker` in CloudWatch Logs (30-day retention).
- **Failed jobs** stay in Batch's failed queue with full ffmpeg stderr in CloudWatch — much easier to debug than MediaConvert's opaque error codes.
- **Long videos**: the job timeout is 6h. Raise `attempt_duration_seconds` if needed.
- **DB security**: the trigger Lambda uses parameterized queries (the original Lambda interpolated `key` into SQL — a SQL injection risk that's fixed here).

## Local testing of the AWS pipeline

You don't need an AWS account to validate the full pipeline before deploying. Each layer can be tested independently; the final integration test wires them together against LocalStack S3 + a Postgres container.

### Layer 1 — the encoder itself

Already covered above:

```bash
node dist/cli.js -i ./eman.mp4 -o ./out
ffplay ./out/eman.m3u8       # or open in VLC / Safari
```

This is the same code path the worker runs in AWS. If output looks right here, the encoding part of the pipeline is good.

### Layer 2 — the worker against LocalStack S3

The worker honours `AWS_ENDPOINT_URL_S3`, so you can point it at LocalStack:

```bash
docker run --rm -p 4566:4566 -e SERVICES=s3 localstack/localstack:3 &

aws --endpoint-url=http://localhost:4566 s3 mb s3://uploads
aws --endpoint-url=http://localhost:4566 s3 mb s3://hls-output
aws --endpoint-url=http://localhost:4566 s3 cp ./eman.mp4 s3://uploads/videos/abc/eman.mp4

AWS_REGION=us-east-1 \
AWS_ENDPOINT_URL_S3=http://localhost:4566 \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
JOB_INPUT_BUCKET=uploads \
JOB_INPUT_KEY=videos/abc/eman.mp4 \
JOB_OUTPUT_BUCKET=hls-output \
JOB_OUTPUT_PREFIX=hls/abc/ \
JOB_BASE_NAME=video \
JOB_SOURCE_RESOLUTION=1080p \
  node dist/worker.js

aws --endpoint-url=http://localhost:4566 s3 ls s3://hls-output/hls/abc/
```

### Layer 3 — the trigger / completion Lambdas

Both Lambda handlers are plain TypeScript functions; you can invoke them directly with synthetic events. For the trigger Lambda, point `BATCH_JOB_QUEUE` and `BATCH_JOB_DEFINITION` at any string and pass `--no-network` AWS calls to a stub, **or** just run the integration test below which avoids that.

### Layer 4 — full end-to-end (recommended)

A scripted run is provided. It spins up LocalStack S3 + Postgres in Docker, seeds a `VideoFile` row, runs the worker against LocalStack, then invokes the completion Lambda in-process and verifies the DB is updated.

```bash
# one-time: start LocalStack + Postgres
npm run test:stack:up

# run the flow against a real video
npm run test:flow -- ./eman.mp4

# tear down when done
npm run test:stack:down
```

Files involved:

| Path                                               | Purpose                                             |
| -------------------------------------------------- | --------------------------------------------------- |
| [test/docker-compose.yml](test/docker-compose.yml) | LocalStack S3 + Postgres                            |
| [test/init.sql](test/init.sql)                     | Minimal `VideoFile` schema                          |
| [test/run-local-flow.ts](test/run-local-flow.ts)   | Orchestrator: upload → worker → completion → assert |

What it asserts:

1. The worker uploads `hls/<uuid>/video.m3u8` plus rendition playlists and segments to LocalStack.
2. The completion Lambda finds the `VideoFile` row by `jobId` and sets `status = COMPLETED`, `url = hls/<uuid>/video.m3u8`.

### What you cannot test locally

- **AWS Batch scheduling / Fargate Spot interruptions.** The integration test runs the worker as a local process; it doesn't model Batch's queueing, retries, or Spot. The Batch piece is small and Terraform-managed — easiest to verify in a sandbox AWS account once the encoding/IAM pieces are validated locally.
- **EventBridge filtering.** The completion Lambda is invoked directly with a synthetic event; the EventBridge rule pattern in `infra/terraform/lambda.tf` is best validated by submitting a real Batch job in a sandbox account.

### Recommended pre-deploy checklist

1. `npm run build` && `node dist/cli.js -i sample.mp4 -o ./out` plays correctly.
2. `npm run test:stack:up && npm run test:flow -- sample.mp4` passes.
3. `./infra/scripts/build-lambda.sh` produces both zips with no errors.
4. `terraform plan` in a non-prod account shows the expected resources.
5. Push to a sandbox account, drop one real video into the uploads bucket, watch CloudWatch Logs end-to-end.
