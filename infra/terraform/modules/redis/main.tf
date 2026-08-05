/**
 * ElastiCache for Redis.
 *
 * Holds three things, in decreasing order of how much it matters that they survive:
 *
 *   1. Refresh tokens and their families. Losing these logs everyone out. Annoying, not
 *      dangerous — and it fails in the safe direction, since a lost token cannot be used.
 *   2. OAuth state and PKCE verifiers, with a 10-minute TTL. Losing these breaks logins
 *      that are mid-flight.
 *   3. Cached query results. Losing these costs a few database queries.
 *
 * Nothing here is a source of truth, which is why `snapshot_retention_limit` defaults to
 * zero. Paying to back up a cache is a common reflex and usually waste.
 *
 * Encryption in transit is on. Redis speaks a plaintext protocol, and refresh tokens
 * cross this wire — hashed, but still.
 */

locals {
  tags = merge(var.tags, { Module = "redis" })
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.subnet_ids

  tags = merge(local.tags, { Name = "${var.name}-redis" })
}

resource "aws_security_group" "this" {
  name        = "${var.name}-redis"
  description = "Redis access for ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(local.tags, { Name = "${var.name}-redis" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "from_nodes" {
  security_group_id            = aws_security_group.this.id
  description                  = "Redis from EKS worker nodes"
  referenced_security_group_id = var.allowed_security_group_id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_elasticache_parameter_group" "this" {
  name   = "${var.name}-redis7"
  family = "redis7"

  # Evict the least-recently-used key with a TTL when memory runs out, rather than
  # returning errors on write. `volatile-lru` and not `allkeys-lru` deliberately: every
  # key this application writes has a TTL, so nothing is exempt, but if a future change
  # introduces a persistent key it will not be silently evicted.
  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name}-redis"
  description          = "Sessions, refresh tokens and query cache for ${var.name}"

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  num_cache_clusters         = var.replica_count + 1
  automatic_failover_enabled = var.replica_count > 0
  multi_az_enabled           = var.replica_count > 0

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  # AUTH on top of TLS. The token goes to Secrets Manager and reaches the pod through
  # External Secrets, never into a manifest.
  auth_token                 = var.auth_token

  # A cache. See the module header.
  snapshot_retention_limit = var.snapshot_retention_limit
  maintenance_window       = "sun:05:00-sun:06:00"

  apply_immediately = var.apply_immediately

  tags = merge(local.tags, { Name = "${var.name}-redis" })

  lifecycle {
    ignore_changes = [auth_token]
  }
}
