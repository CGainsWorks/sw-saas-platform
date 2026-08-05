output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority" {
  description = "Base64 CA bundle for kubeconfig."
  value       = aws_eks_cluster.this.certificate_authority[0].data
}

output "cluster_version" {
  value = aws_eks_cluster.this.version
}

output "node_security_group_id" {
  description = "Passed to the RDS and Redis modules as the only permitted source."
  value       = aws_security_group.nodes.id
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.this.arn
}

output "oidc_provider_url" {
  value = aws_iam_openid_connect_provider.this.url
}

output "api_role_arn" {
  description = "IRSA role for the API pod. Goes on the service account as eks.amazonaws.com/role-arn."
  value       = aws_iam_role.api.arn
}

output "kubeconfig_command" {
  description = "How to get credentials for this cluster."
  value       = "aws eks update-kubeconfig --name ${aws_eks_cluster.this.name} --region ${var.region}"
}
