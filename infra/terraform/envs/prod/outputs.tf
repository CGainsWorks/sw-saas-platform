output "cluster_name" {
  value = module.eks.cluster_name
}

output "kubeconfig_command" {
  value = module.eks.kubeconfig_command
}

output "api_irsa_role_arn" {
  value = module.eks.api_role_arn
}

output "rds_address" {
  value = module.rds.address
}

output "redis_endpoint" {
  value = module.redis.primary_endpoint
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "post_apply_steps" {
  value = <<-EOT

    Before this environment can serve traffic:

      1. Write the JWT keypair into ${aws_secretsmanager_secret.app.name}
         (generated out of band so it never enters Terraform state — see main.tf).
      2. Create the app_user role's password and update DATABASE_URL in the same secret.
      3. Run the migration job:  kubectl apply -k infra/k8s/overlays/prod
      4. Confirm the API's boot check passes — it refuses to start if its database role
         can bypass row-level security.

    Full procedure: docs/runbook.md

  EOT
}
