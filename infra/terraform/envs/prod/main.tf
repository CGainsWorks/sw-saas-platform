/**
 * Production environment.
 *
 * Same modules as dev, different answers. The differences are all one of three things:
 * removing a single point of failure, keeping data longer, or refusing to let Terraform
 * delete something by accident.
 *
 *   dev                                   prod
 *   ---------------------------------     ----------------------------------------
 *   1 NAT gateway                         one per AZ (no shared failure domain)
 *   2 AZs                                 3 AZs
 *   SPOT nodes                            ON_DEMAND (no two-minute reclaim)
 *   db.t4g.micro, single AZ               db.t4g.small, multi-AZ standby
 *   1 day of backups                      30 days
 *   deletion_protection = false           true
 *   skip_final_snapshot = true            false
 *   no Redis replica                      1 replica, automatic failover
 *   Kubernetes API open                   restricted to known CIDRs, required variable
 *
 * NOT DEPLOYED. This environment has never been applied — see the honesty note in
 * docs/architecture.md. It is written to be applyable and reviewed as code, not to imply
 * it is running somewhere.
 *
 * Estimated ~$680/month. docs/cost.md has the breakdown.
 */

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.70" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    tls    = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

locals {
  name        = "saas-prod"
  environment = "prod"

  tags = {
    Project     = "sw-saas-platform"
    Environment = local.environment
    ManagedBy   = "terraform"
    CostCenter  = "portfolio"
  }
}

resource "aws_kms_key" "this" {
  description             = "${local.name} encryption key"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = { Name = local.name }
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.this.key_id
}

module "vpc" {
  source = "../../modules/vpc"

  name         = local.name
  region       = var.region
  cidr_block   = "10.30.0.0/16"
  az_count     = 3
  cluster_name = local.name

  # One per AZ. The extra ~$64/month buys the property that losing an AZ does not take
  # egress away from the two that are still up.
  single_nat_gateway = false

  enable_flow_logs        = true
  flow_log_retention_days = 90

  tags = local.tags
}

module "eks" {
  source = "../../modules/eks"

  cluster_name       = local.name
  region             = var.region
  kubernetes_version = "1.31"

  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids

  # No default. An open production API server should require someone to type it out.
  public_access_cidrs = var.kubernetes_api_allowed_cidrs

  node_instance_types = ["t4g.medium"]
  node_capacity_type  = "ON_DEMAND"
  node_desired_size   = 3
  node_min_size       = 3
  node_max_size       = 9

  kms_key_arn = aws_kms_key.this.arn

  secret_arns = [
    module.rds.master_secret_arn,
    aws_secretsmanager_secret.app.arn,
  ]

  log_retention_days = 90

  tags = local.tags
}

module "rds" {
  source = "../../modules/rds"

  name       = local.name
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.data_subnet_ids

  allowed_security_group_id = module.eks.node_security_group_id

  instance_class        = "db.t4g.small"
  allocated_storage     = 50
  max_allocated_storage = 500

  multi_az              = true
  backup_retention_days = 30

  # Terraform cannot delete this. Removing it is a deliberate, separate change — which is
  # exactly the friction you want in front of "destroy the customer database".
  deletion_protection = true
  skip_final_snapshot = false

  secret_recovery_window_days  = 30
  performance_insights_enabled = true

  kms_key_arn = aws_kms_key.this.arn

  tags = local.tags
}

resource "random_password" "redis_auth" {
  length  = 64
  special = false
}

module "redis" {
  source = "../../modules/redis"

  name       = local.name
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.data_subnet_ids

  allowed_security_group_id = module.eks.node_security_group_id

  node_type     = "cache.t4g.small"
  replica_count = 1 # automatic failover; losing the primary logs everyone out otherwise

  auth_token = random_password.redis_auth.result

  tags = local.tags
}

/* -------------------------------------------------------- application secrets */

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  description             = "Application secrets for ${local.name}"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 30

  tags = local.tags
}

/**
 * Note what is NOT here: the JWT signing key.
 *
 * In dev Terraform generates it, which is convenient and means the private key sits in
 * the state file in cleartext. For production the keypair is generated out of band and
 * written straight into this secret, so it never passes through Terraform state at all:
 *
 *   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.pem
 *   openssl rsa -in jwt.pem -pubout -out jwt.pub
 *   aws secretsmanager put-secret-value --secret-id saas-prod/app --secret-string "$(jq -n \
 *     --arg priv "$(base64 -w0 jwt.pem)" --arg pub "$(base64 -w0 jwt.pub)" \
 *     '{JWT_PRIVATE_KEY_B64:$priv, JWT_PUBLIC_KEY_B64:$pub}')"
 *
 * `ignore_changes` on the whole version keeps Terraform from reverting it afterwards.
 */
resource "aws_secretsmanager_secret_version" "app_placeholder" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    DATABASE_URL = "postgres://app_user:REPLACE_ME@${module.rds.address}:${module.rds.port}/${module.rds.database_name}?sslmode=require"
    REDIS_URL    = "rediss://:${random_password.redis_auth.result}@${module.redis.primary_endpoint}:${module.redis.port}"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
