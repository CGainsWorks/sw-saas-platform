output "cluster_name" {
  value = module.eks.cluster_name
}

output "kubeconfig_command" {
  description = "Run this to point kubectl at the cluster."
  value       = module.eks.kubeconfig_command
}

output "api_irsa_role_arn" {
  description = "Annotate the saas-api service account with this."
  value       = module.eks.api_role_arn
}

output "rds_address" {
  value = module.rds.address
}

output "redis_endpoint" {
  value = module.redis.primary_endpoint
}

output "app_secret_arn" {
  description = "Secrets Manager entry that External Secrets syncs into the cluster."
  value       = aws_secretsmanager_secret.app.arn
}

output "rds_master_secret_arn" {
  description = "Master credentials, used by the migration job only."
  value       = module.rds.master_secret_arn
}

output "nat_gateway_count" {
  description = "Each NAT gateway is roughly $32/month before data processing."
  value       = module.vpc.nat_gateway_count
}

output "cost_warning" {
  value = <<-EOT

    This environment bills continuously whether or not it is being used.
    The EKS control plane alone is ~$73/month and cannot be paused.

    Estimated total: ~$260/month. Breakdown: docs/cost.md
    To stop paying:  docs/teardown.md  (or: make teardown)

  EOT
}
