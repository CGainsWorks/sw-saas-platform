/**
 * PostgreSQL on RDS.
 *
 * One instance holding every tenant's data — that is the pool tenancy model, and it is why
 * the parameter group below turns on the settings that make row-level security auditable
 * and why the master credential is not the credential the application uses.
 *
 * The application connects as `app_user` (NOSUPERUSER, NOBYPASSRLS), created by migration
 * 0002. The master user created here is used only to run migrations. On RDS the master is
 * not a true superuser, but it does hold rds_superuser, which includes BYPASSRLS — so
 * pointing the application at it would silently disable every isolation policy. The API
 * asserts at boot that its own role cannot bypass RLS, which is what stops that mistake
 * from reaching a serving state.
 */

locals {
  tags = merge(var.tags, { Module = "rds" })
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-postgres"
  subnet_ids = var.subnet_ids

  tags = merge(local.tags, { Name = "${var.name}-postgres" })
}

resource "aws_security_group" "this" {
  name        = "${var.name}-postgres"
  description = "Postgres access for ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(local.tags, { Name = "${var.name}-postgres" })

  lifecycle {
    create_before_destroy = true
  }
}

# Only from the node security group. Not from the VPC CIDR — that would also allow the
# public subnets, and therefore anything that ends up with a public IP.
resource "aws_vpc_security_group_ingress_rule" "from_nodes" {
  security_group_id            = aws_security_group.this.id
  description                  = "Postgres from EKS worker nodes"
  referenced_security_group_id = var.allowed_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# No egress rules at all. A database has no legitimate reason to originate connections,
# and the data subnets have no route to a NAT anyway. Belt and braces.

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres16"
  family = "postgres16"

  # Log statements slower than this. Enough to catch a pathological query without logging
  # the entire workload.
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  # Every connection and disconnection. Useful when diagnosing pool exhaustion, which in a
  # pooled tenancy model is how one tenant's traffic becomes everyone's outage.
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # Records the application_name the API sets, so a slow query in the log can be traced to
  # the service that issued it.
  parameter {
    name  = "log_line_prefix"
    value = "%t:%r:%u@%d:[%p]:%a:"
  }

  # A backstop below the API's own statement_timeout. If the application config is ever
  # wrong, the database still refuses to let one query hold a connection indefinitely.
  parameter {
    name  = "statement_timeout"
    value = tostring(var.statement_timeout_ms)
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = tostring(var.statement_timeout_ms * 2)
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

/* ------------------------------------------------------------- credentials */

resource "random_password" "master" {
  length  = 32
  special = true
  # RDS rejects these in a master password.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "master" {
  name        = "${var.name}/rds/master"
  description = "RDS master credentials for ${var.name}. Used by migrations only, never by request paths."

  # Zero means immediate deletion on destroy. Non-zero leaves the secret name reserved for
  # that many days, which makes a destroy-then-recreate cycle fail on a name collision —
  # an unpleasant surprise mid-teardown. See docs/teardown.md.
  recovery_window_in_days = var.secret_recovery_window_days

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "master" {
  secret_id = aws_secretsmanager_secret.master.id

  secret_string = jsonencode({
    username = var.master_username
    password = random_password.master.result
    engine   = "postgres"
    host     = aws_db_instance.this.address
    port     = aws_db_instance.this.port
    dbname   = var.database_name
  })
}

/* --------------------------------------------------------------- instance */

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = var.database_name
  username = var.master_username
  password = random_password.master.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  multi_az = var.multi_az

  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot   = true

  # Point-in-time recovery within the retention window is the only route back from a bad
  # migration. Note the limitation recorded in multi_tenancy.md §8: restoring one tenant
  # means restoring the whole cluster and extracting rows, because they share tables.
  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately

  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_retention_period = var.performance_insights_enabled ? 7 : null
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  # Terraform cannot delete a database with this on. That is the point in production, and
  # the reason `make teardown` needs the override documented in docs/teardown.md.
  deletion_protection = var.deletion_protection

  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name}-postgres-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  tags = merge(local.tags, { Name = "${var.name}-postgres" })

  lifecycle {
    ignore_changes = [
      # Recomputed from timestamp() on every plan, which would otherwise show a permanent
      # diff and force replacement.
      final_snapshot_identifier,
      # Rotated out of band by Secrets Manager, not by Terraform.
      password,
    ]
  }
}
