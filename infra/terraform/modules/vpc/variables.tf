variable "name" {
  description = "Name prefix for every resource in this module."
  type        = string
}

variable "region" {
  description = "AWS region. Used to build VPC endpoint service names."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. A /16 leaves room for three /20 tiers per AZ."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.cidr_block))
    error_message = "cidr_block must be a valid IPv4 CIDR."
  }
}

variable "az_count" {
  description = "Number of availability zones to span."
  type        = number
  default     = 2

  validation {
    # Two AZs is the minimum for RDS multi-AZ and for a node group that survives losing one.
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4."
  }
}

variable "single_nat_gateway" {
  description = <<-EOT
    Use one NAT gateway for the whole VPC instead of one per AZ.

    Saves roughly $32/month per AZ avoided. The cost is availability: if that AZ fails,
    every private subnet loses egress. Acceptable for dev, not for production.
  EOT
  type        = bool
  default     = false
}

variable "cluster_name" {
  description = "EKS cluster name, needed for the kubernetes.io/cluster subnet tags."
  type        = string
}

variable "enable_flow_logs" {
  description = "Send rejected-traffic VPC flow logs to CloudWatch."
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "CloudWatch retention for flow logs. Longer retention costs more."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
