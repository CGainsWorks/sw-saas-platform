output "primary_endpoint" {
  description = "Primary endpoint hostname."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "reader_endpoint" {
  description = "Reader endpoint. Null when there are no replicas."
  value       = var.replica_count > 0 ? aws_elasticache_replication_group.this.reader_endpoint_address : null
}

output "port" {
  value = aws_elasticache_replication_group.this.port
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "connection_url_template" {
  description = "REDIS_URL shape. rediss:// (two s) because transit encryption is on."
  value       = "rediss://:AUTH_TOKEN@${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}
