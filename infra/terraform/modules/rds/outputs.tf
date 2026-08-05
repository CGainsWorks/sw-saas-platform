output "endpoint" {
  description = "host:port."
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "Hostname only."
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "database_name" {
  value = aws_db_instance.this.db_name
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "master_username" {
  value = aws_db_instance.this.username
}

output "master_password" {
  description = "Generated master password. Sensitive — reaches the cluster only via Secrets Manager."
  value       = random_password.master.result
  sensitive   = true
}

output "master_secret_arn" {
  description = "Secrets Manager ARN holding the master credentials. Used by the migration job only."
  value       = aws_secretsmanager_secret.master.arn
}

output "instance_id" {
  value = aws_db_instance.this.id
}
