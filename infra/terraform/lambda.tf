# Lambda zips are built outside Terraform (see infra/scripts/build-lambda.sh).
locals {
  trigger_lambda_zip    = "${path.module}/../trigger-lambda/trigger-lambda.zip"
  completion_lambda_zip = "${path.module}/../completion-lambda/completion-lambda.zip"
}

resource "aws_lambda_function" "trigger" {
  function_name    = "${var.name_prefix}-trigger"
  role             = aws_iam_role.lambda_trigger.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = local.trigger_lambda_zip
  source_code_hash = filebase64sha256(local.trigger_lambda_zip)
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      BATCH_JOB_QUEUE         = aws_batch_job_queue.this.arn
      BATCH_JOB_DEFINITION    = aws_batch_job_definition.this.arn
      OUTPUT_BUCKET           = local.output_bucket_name
      OUTPUT_PREFIX           = "hls/"
      PRODUCTION_BUCKET       = var.production_bucket_name
      RDS_ENDPOINT            = var.rds_endpoint
      RDS_ENDPOINT_PRODUCTION = var.rds_endpoint_production
    }
  }

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.lambda_subnet_ids
      security_group_ids = var.lambda_security_group_ids
    }
  }
}

resource "aws_lambda_permission" "allow_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.trigger.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = data.aws_s3_bucket.uploads.arn
}

# ---------- Completion Lambda (Batch state change -> DB update) ----------
resource "aws_lambda_function" "completion" {
  function_name    = "${var.name_prefix}-completion"
  role             = aws_iam_role.lambda_completion.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = local.completion_lambda_zip
  source_code_hash = filebase64sha256(local.completion_lambda_zip)
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      PRODUCTION_BUCKET       = var.production_bucket_name
      RDS_ENDPOINT            = var.rds_endpoint
      RDS_ENDPOINT_PRODUCTION = var.rds_endpoint_production
    }
  }

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.lambda_subnet_ids
      security_group_ids = var.lambda_security_group_ids
    }
  }
}

# Fire on terminal Batch states only, scoped to our queue, so we don't
# get noise from any other Batch jobs in the account.
resource "aws_cloudwatch_event_rule" "batch_terminal" {
  name        = "${var.name_prefix}-batch-terminal"
  description = "Trigger completion Lambda on terminal Batch job states for the HLS queue."

  event_pattern = jsonencode({
    "source"      = ["aws.batch"]
    "detail-type" = ["Batch Job State Change"]
    "detail" = {
      "status"   = ["SUCCEEDED", "FAILED"]
      "jobQueue" = [aws_batch_job_queue.this.arn]
    }
  })
}

resource "aws_cloudwatch_event_target" "completion" {
  rule      = aws_cloudwatch_event_rule.batch_terminal.name
  target_id = "completion-lambda"
  arn       = aws_lambda_function.completion.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.completion.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.batch_terminal.arn
}
