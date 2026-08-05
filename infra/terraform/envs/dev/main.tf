/**
 * Development environment.
 *
 * Sized to be as cheap as an EKS cluster can reasonably be while still being the same
 * shape as production: same modules, same isolation boundaries, smaller instances and
 * fewer of them. Roughly $260/month if left running — see docs/cost.md for the breakdown
 * and docs/teardown.md for how to stop paying for it.
 *
 * The single largest line item is the EKS control plane at $73/month, which is charged
 * whether or not anything is deployed to it. If you are not actively working on the
 * cluster, destroy it.
 */

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

locals {
  name        = "saas-dev"
  environment = "dev"

  tags = {
    Project     = "sw-saas-platform"
    Environment = local.environment
    ManagedBy   = "terraform"
    # Makes `aws ce get-cost-and-usage --group-by TAG:Project` actually work, which is how
    # you find out what this is costing before the bill arrives.
    CostCenter = "portfolio"
  }
}

/* -------------------------------------------------------------------- KMS */

# One customer-managed key for the whole environment: RDS storage, EKS secret envelope
# encryption, and the Secrets Manager entries. A single key is easier to reason about at
# this scale than one per service, and rotation applies to all of it at once.
resource "aws_kms_key" "this" {
  description             = "${local.name} encryption key"
  enable_key_rotation     = true
  deletion_window_in_days = 7 # minimum, so a teardown does not leave a key billing for a month

  tags = { Name = local.name }
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.this.key_id
}

/* --------------------------------------------------------------- networking */

module "vpc" {
  source = "../../modules/vpc"

  name         = local.name
  region       = var.region
  cidr_block   = "10.20.0.0/16"
  az_count     = 2
  cluster_name = local.name

  # One NAT gateway instead of two: saves ~$32/month, at the cost of losing egress from
  # every private subnet if that AZ goes down. Fine for dev, not for production.
  single_nat_gateway = true

  enable_flow_logs        = true
  flow_log_retention_days = 7

  tags = local.tags
}

/* ------------------------------------------------------------------- EKS */

module "eks" {
  source = "../../modules/eks"

  cluster_name       = local.name
  region             = var.region
  kubernetes_version = "1.31"

  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids

  # Narrow this to your own address. The default is open so the demo works from anywhere,
  # which is a convenience, not a recommendation.
  public_access_cidrs = var.kubernetes_api_allowed_cidrs

  node_instance_types = ["t4g.small"]
  node_capacity_type  = "SPOT" # dev only: reclaimed at two minutes' notice
  node_desired_size   = 2
  node_min_size       = 1
  node_max_size       = 3

  kms_key_arn = aws_kms_key.this.arn

  # Explicit list, never "*". This is what the API pod may read and nothing else.
  secret_arns = [
    module.rds.master_secret_arn,
    aws_secretsmanager_secret.app.arn,
  ]

  log_retention_days = 7

  tags = local.tags
}

/* ------------------------------------------------------------------ data */

module "rds" {
  source = "../../modules/rds"

  name       = local.name
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.data_subnet_ids

  allowed_security_group_id = module.eks.node_security_group_id

  instance_class        = "db.t4g.micro"
  allocated_storage     = 20
  max_allocated_storage = 50

  multi_az              = false # dev: a restore is acceptable, a standby is not worth 2x
  backup_retention_days = 1
  deletion_protection   = false # dev is meant to be destroyed
  skip_final_snapshot   = true

  # Zero, so a destroy-then-recreate cycle does not collide on the reserved secret name.
  secret_recovery_window_days = 0

  kms_key_arn = aws_kms_key.this.arn

  tags = local.tags
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false # ElastiCache AUTH tokens reject most punctuation
}

module "redis" {
  source = "../../modules/redis"

  name       = local.name
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.data_subnet_ids

  allowed_security_group_id = module.eks.node_security_group_id

  node_type     = "cache.t4g.micro"
  replica_count = 0
  auth_token    = random_password.redis_auth.result

  tags = local.tags
}

/* -------------------------------------------------------- application secrets */

# RS256 keypair for the tokens the API issues.
#
# Generated by Terraform so the environment is self-contained. In production the private
# key should be generated outside Terraform and imported, because anything Terraform
# creates is also in the state file — see the warning in docs/runbook.md.
resource "tls_private_key" "jwt" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  description             = "Application secrets for ${local.name}"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 0

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    # The application role, NOT the master user. Pointing the app at the master would
    # give it rds_superuser, which includes BYPASSRLS and would silently disable every
    # tenant isolation policy. The API refuses to start if it detects this.
    DATABASE_URL = "postgres://app_user:${random_password.app_db.result}@${module.rds.address}:${module.rds.port}/${module.rds.database_name}?sslmode=require"

    # Master credential. Used only by the migration Job, which needs to create roles and
    # alter policies — things app_user deliberately cannot do. Never read on a request path.
    DATABASE_ADMIN_URL = "postgres://${module.rds.master_username}:${module.rds.master_password}@${module.rds.address}:${module.rds.port}/${module.rds.database_name}?sslmode=require"

    REDIS_URL = "rediss://:${random_password.redis_auth.result}@${module.redis.primary_endpoint}:${module.redis.port}"

    JWT_PRIVATE_KEY_B64 = base64encode(tls_private_key.jwt.private_key_pem)
    JWT_PUBLIC_KEY_B64  = base64encode(tls_private_key.jwt.public_key_pem)

    OIDC_CLIENT_SECRET = var.oidc_client_secret
  })
}

# Password for app_user. The role itself is created by migration 0002; this sets its
# password, applied by the bootstrap step in docs/runbook.md.
resource "random_password" "app_db" {
  length           = 40
  special          = true
  override_special = "-_"
}
