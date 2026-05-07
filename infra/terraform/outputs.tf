output "ecr_repository_url" {
  description = "Push the worker image to this ECR URL with tag ':latest'."
  value       = aws_ecr_repository.worker.repository_url
}

output "batch_job_queue_arn" {
  value = aws_batch_job_queue.this.arn
}

output "batch_job_definition_arn" {
  value = aws_batch_job_definition.this.arn
}

output "output_bucket" {
  value = local.output_bucket_name
}

output "trigger_lambda_name" {
  value = aws_lambda_function.trigger.function_name
}
