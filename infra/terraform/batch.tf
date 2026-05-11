# Security group for Fargate tasks. Outbound only -- they need to reach S3,
# ECR, CloudWatch Logs and (optionally) RDS.
resource "aws_security_group" "tasks" {
  name        = "${var.name_prefix}-tasks"
  description = "HLS worker Fargate tasks"
  vpc_id      = var.vpc_id

  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/batch/${var.name_prefix}-worker"
  retention_in_days = 30
}

resource "aws_batch_compute_environment" "this" {
  compute_environment_name = "${var.name_prefix}-ce"
  type                     = "MANAGED"
  service_role             = aws_iam_role.batch_service.arn

  compute_resources {
    type               = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    max_vcpus          = var.max_vcpus
    subnets            = var.subnet_ids
    security_group_ids = [aws_security_group.tasks.id]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_batch_job_queue" "this" {
  name     = "${var.name_prefix}-queue"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.this.arn
  }
}

resource "aws_batch_job_definition" "this" {
  name = "${var.name_prefix}-jobdef"
  type = "container"

  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image      = "${aws_ecr_repository.worker.repository_url}:latest"
    jobRoleArn = aws_iam_role.task.arn
    executionRoleArn = aws_iam_role.task_execution.arn
    networkConfiguration = {
      assignPublicIp = var.assign_public_ip ? "ENABLED" : "DISABLED"
    }
    fargatePlatformConfiguration = {
      platformVersion = "LATEST"
    }
    resourceRequirements = [
      { type = "VCPU",   value = tostring(var.job_vcpu) },
      { type = "MEMORY", value = tostring(var.job_memory_mib) },
    ]
    ephemeralStorage = {
      sizeInGiB = var.job_ephemeral_storage_gib
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "worker"
      }
    }
    environment = [
      { name = "AWS_REGION", value = var.region },
    ]
  })

  retry_strategy {
    attempts = 2
    evaluate_on_exit {
      action           = "RETRY"
      on_status_reason = "Host EC2*"
    }
    evaluate_on_exit {
      action           = "RETRY"
      on_status_reason = "Your Spot Task was interrupted*"
    }
    evaluate_on_exit {
      action    = "EXIT"
      on_reason = "*"
    }
  }

  timeout {
    attempt_duration_seconds = 6 * 60 * 60
  }
}
