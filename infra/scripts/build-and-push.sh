#!/usr/bin/env bash
# Build the worker container image and push it to ECR.
#
# Usage:
#   AWS_REGION=us-east-1 ECR_URL=<account>.dkr.ecr.us-east-1.amazonaws.com/hls-worker \
#     ./infra/scripts/build-and-push.sh
#
# Defaults to tag :latest. Override with TAG=v1.
set -euo pipefail

: "${ECR_URL:?ECR_URL is required (terraform output ecr_repository_url)}"
: "${AWS_REGION:?AWS_REGION is required}"
TAG="${TAG:-latest}"

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

echo "Logging in to ECR ($AWS_REGION)..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"

# Use buildx for cross-arch builds; Fargate runs linux/amd64.
echo "Building image $ECR_URL:$TAG ..."
docker buildx build \
  --platform linux/amd64 \
  -t "$ECR_URL:$TAG" \
  --push \
  .

echo "Done."
