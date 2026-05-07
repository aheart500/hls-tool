variable "region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Name prefix for all created resources."
  type        = string
  default     = "hls"
}

variable "uploads_bucket_name" {
  description = "Existing S3 bucket where source videos are uploaded under videos/<uuid>/<file>."
  type        = string
}

variable "output_bucket_name" {
  description = "S3 bucket where HLS output is written. Created by this module."
  type        = string
}

variable "production_bucket_name" {
  description = "Bucket name considered 'production' by the trigger Lambda (matches original code: 'medc')."
  type        = string
  default     = "medc"
}

variable "rds_endpoint" {
  description = "Postgres connection string for non-prod environments."
  type        = string
  sensitive   = true
}

variable "rds_endpoint_production" {
  description = "Postgres connection string for production."
  type        = string
  sensitive   = true
}

variable "vpc_id" {
  description = "VPC for the Batch Fargate compute environment."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets for the Batch Fargate compute environment. Use private subnets with a NAT gateway, or public subnets with assign_public_ip=true."
  type        = list(string)
}

variable "assign_public_ip" {
  description = "Whether to assign public IPs to Fargate tasks (use true with public subnets, false with private subnets behind a NAT)."
  type        = bool
  default     = false
}

variable "max_vcpus" {
  description = "Max vCPUs the Batch compute environment can scale to."
  type        = number
  default     = 32
}

variable "use_fargate_spot" {
  description = "Use FARGATE_SPOT for ~70% cost savings. Jobs may be interrupted; retryStrategy in the job submission handles this."
  type        = bool
  default     = true
}

variable "job_vcpu" {
  description = "vCPUs per Batch job (Fargate supports 0.25, 0.5, 1, 2, 4, 8, 16)."
  type        = number
  default     = 4
}

variable "job_memory_mib" {
  description = "Memory per Batch job in MiB. Must be valid for the chosen vCPU."
  type        = number
  default     = 8192
}

variable "job_ephemeral_storage_gib" {
  description = "Ephemeral storage per Fargate task (GiB, 21..200). Must fit your largest source plus all rendition outputs."
  type        = number
  default     = 50
}

variable "lambda_subnet_ids" {
  description = "Subnets for the trigger Lambda (must reach Postgres). Leave empty if your RDS is publicly reachable."
  type        = list(string)
  default     = []
}

variable "lambda_security_group_ids" {
  description = "Security groups attached to the trigger Lambda when run in a VPC."
  type        = list(string)
  default     = []
}
