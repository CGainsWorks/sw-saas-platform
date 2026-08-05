variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "kubernetes_api_allowed_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach the production Kubernetes API server.

    Deliberately has no default. An open production control plane should require someone
    to type the CIDR out and see it in a diff, rather than inheriting 0.0.0.0/0 from a
    module default nobody read.
  EOT
  type        = list(string)

  validation {
    condition     = !contains(var.kubernetes_api_allowed_cidrs, "0.0.0.0/0")
    error_message = "Refusing to expose the production Kubernetes API to the whole internet."
  }
}
