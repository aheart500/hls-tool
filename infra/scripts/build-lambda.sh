#!/usr/bin/env bash
# Bundle both Lambdas into zip files Terraform consumes:
#   infra/trigger-lambda/trigger-lambda.zip       (S3 -> Batch SubmitJob)
#   infra/completion-lambda/completion-lambda.zip (Batch state -> DB update)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

build_lambda() {
  local dir="$1"
  local zip_name="$2"

  echo "==> Building $dir"
  cd "$ROOT_DIR/$dir"
  npm install
  npm run build

  rm -f "$zip_name"
  ( cd dist && zip -q -r "../$zip_name" index.mjs )
  echo "    -> $ROOT_DIR/$dir/$zip_name"
}

build_lambda "infra/trigger-lambda"    "trigger-lambda.zip"
build_lambda "infra/completion-lambda" "completion-lambda.zip"
