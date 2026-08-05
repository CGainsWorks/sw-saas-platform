variable "name" {
  description = "Name prefix."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Data-tier subnet ids. Must span at least two AZs."
  type        = list(string)
}

variable "allowed_security_group_id" {
  description = "Security group permitted to reach port 5432 — the EKS node group."
  type        = string
}

variable "engine_version" {
  description = "PostgreSQL major.minor. Row-level security needs nothing exotic; 16 is current LTS-ish."
  type        = string
  default     = "16.4"
}

variable "instance_class" {
  description = "RDS instance class. db.t4g.micro is the cheapest that runs the demo."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Initial storage in GB."
  type        = number
  default     = 20
}

variable "max_allocated_storage" {
  description = "Autoscaling ceiling in GB. Set equal to allocated_storage to disable growth."
  type        = number
  default     = 100
}

variable "database_name" {
  type    = string
  default = "saas"
}

variable "master_username" {
  description = "Master user. Runs migrations only — the application connects as app_user."
  type        = string
  default     = "saas_admin"
}

variable "multi_az" {
  description = "Standby in a second AZ. Roughly doubles the instance cost."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Automated backup retention. 0 disables backups and point-in-time recovery."
  type        = number
  default     = 7
}

variable "statement_timeout_ms" {
  description = "Server-side statement timeout. A backstop under the API's own setting."
  type        = number
  default     = 30000
}

variable "deletion_protection" {
  description = "Block deletion. Leave on in production; teardown requires turning it off first."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. True for dev, false for anything real."
  type        = bool
  default     = false
}

variable "performance_insights_enabled" {
  description = "Performance Insights. Free at 7-day retention on supported classes."
  type        = bool
  default     = true
}

variable "apply_immediately" {
  description = "Apply changes now rather than in the maintenance window. Can cause downtime."
  type        = bool
  default     = false
}

variable "kms_key_arn" {
  description = "KMS key for storage encryption. Null uses the AWS-managed key."
  type        = string
  default     = null
}

variable "secret_recovery_window_days" {
  description = <<-EOT
    Secrets Manager recovery window. 0 deletes immediately.

    Non-zero leaves the secret NAME reserved after destroy, so recreating the stack fails
    with a name collision. Set to 0 in dev where the stack is torn down and rebuilt often.
  EOT
  type        = number
  default     = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}
