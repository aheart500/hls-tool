# Reference to the existing uploads bucket; we only need to attach a notification.
data "aws_s3_bucket" "uploads" {
  bucket = var.uploads_bucket_name
}

# When uploads_bucket_name == output_bucket_name we treat them as the same
# bucket and skip creating a separate output bucket. Otherwise we create one.
locals {
  same_bucket = var.uploads_bucket_name == var.output_bucket_name

  output_bucket_name = local.same_bucket ? data.aws_s3_bucket.uploads.bucket : aws_s3_bucket.output[0].bucket
  output_bucket_arn  = local.same_bucket ? data.aws_s3_bucket.uploads.arn : aws_s3_bucket.output[0].arn
}

resource "aws_s3_bucket" "output" {
  count         = local.same_bucket ? 0 : 1
  bucket        = var.output_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "output" {
  count                   = local.same_bucket ? 0 : 1
  bucket                  = aws_s3_bucket.output[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "output" {
  count  = local.same_bucket ? 0 : 1
  bucket = aws_s3_bucket.output[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_notification" "uploads" {
  bucket = data.aws_s3_bucket.uploads.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.trigger.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "videos/"
  }

  depends_on = [aws_lambda_permission.allow_s3]
}