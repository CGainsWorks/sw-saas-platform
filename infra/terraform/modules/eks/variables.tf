variable "cluster_name" {
  type = string
}

variable "region" {
  description = "AWS region, used to render the kubeconfig helper output."
  type        = string
}

variable "kubernetes_version" {
  type    = string
  default = "1.31"
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  description = "Where worker nodes run. No public addresses."
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Where internet-facing load balancers are placed."
  type        = list(string)
}

variable "endpoint_public_access" {
  description = "Expose the Kubernetes API publicly, restricted by public_access_cidrs."
  type        = bool
  default     = true
}

variable "public_access_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach the Kubernetes API endpoint.

    The default is open, which is what makes a demo runnable from anywhere. Narrow it to
    your office or VPN range for anything real — an exposed API server is worth exactly as
    much as the credentials protecting it.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "node_instance_types" {
  description = "Graviton by default: roughly 20% cheaper than equivalent x86 for this workload."
  type        = list(string)
  default     = ["t4g.medium"]
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT. Spot is far cheaper and can be reclaimed at two minutes' notice."
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.node_capacity_type)
    error_message = "node_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "node_desired_size" {
  type    = number
  default = 2
}

variable "node_min_size" {
  type    = number
  default = 2
}

variable "node_max_size" {
  type    = number
  default = 4
}

variable "node_disk_size" {
  type    = number
  default = 30
}

variable "log_retention_days" {
  description = "CloudWatch retention for control plane logs."
  type        = number
  default     = 14
}

variable "kms_key_arn" {
  description = "KMS key for envelope-encrypting Kubernetes Secrets in etcd."
  type        = string
}

variable "app_namespace" {
  description = "Namespace of the API service account that IRSA trusts."
  type        = string
  default     = "saas"
}

variable "app_service_account" {
  description = "Service account name the IRSA role is bound to."
  type        = string
  default     = "saas-api"
}

variable "secret_arns" {
  description = "Secrets Manager ARNs the API is allowed to read. Never set this to [\"*\"]."
  type        = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
