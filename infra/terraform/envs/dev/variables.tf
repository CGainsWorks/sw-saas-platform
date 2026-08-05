variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-2"
}

variable "kubernetes_api_allowed_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach the Kubernetes API server.

    Defaults to open so the demo works from anywhere. Set this to your own address before
    leaving anything running:

      kubernetes_api_allowed_cidrs = ["203.0.113.10/32"]
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "oidc_client_secret" {
  description = <<-EOT
    Client secret for the real identity provider (Auth0, Google, Keycloak).

    Not the dev IdP — that one only exists in docker-compose. Pass this via
    TF_VAR_oidc_client_secret rather than putting it in a .tfvars file.
  EOT
  type        = string
  sensitive   = true
  default     = "change-me"
}
