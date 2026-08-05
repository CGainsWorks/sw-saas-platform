output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR, for security group rules that allow intra-VPC traffic."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnets: load balancers and NAT gateways."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnets: EKS worker nodes."
  value       = aws_subnet.private[*].id
}

output "data_subnet_ids" {
  description = "Data subnets: RDS and ElastiCache. No route to the internet."
  value       = aws_subnet.data[*].id
}

output "availability_zones" {
  description = "AZs this VPC spans."
  value       = local.azs
}

output "nat_gateway_count" {
  description = "Number of NAT gateways created. Each is a fixed monthly cost — see docs/cost.md."
  value       = length(aws_nat_gateway.this)
}
