# Cost estimate

**Read this before running `terraform apply`.** This stack bills continuously whether or
not anyone is using it, and the largest single item is charged for the privilege of the
control plane existing.

Every number on this page is produced by [`scripts/estimate-cost.mjs`](../scripts/estimate-cost.mjs):

```bash
node scripts/estimate-cost.mjs
```

It makes no AWS API calls, so it is free to run and works offline. Rates are published
on-demand pricing for **eu-west-2 (London), USD, excluding VAT, August 2026**. When AWS
changes a price, edit the rate table at the top of the script — the assumptions are meant
to be visible and arguable rather than buried.

> **The number that catches people out:** the EKS control plane is **$73/month per
> cluster** and cannot be stopped, scaled to zero, or paused. It is charged before a
> single pod is scheduled.

---

## Summary

| Environment | Monthly | Per day | Per hour |
|---|---:|---:|---:|
| **Local (`docker compose`)** | **$0.00** | $0.00 | $0.00 |
| **Dev on AWS** | **$174.78** | $5.83 | $0.24 |
| **Production on AWS** | **$509.13** | $16.97 | $0.70 |

**If you only want to see the system work, use `docker compose up`. It costs nothing and
demonstrates everything except the cloud infrastructure itself.**

A few hours of dev environment to capture evidence costs about **$1**. That is the
sensible way to use this: apply, screenshot, destroy the same day.

---

## Dev environment — $174.78/month

`infra/terraform/envs/dev`

| Component | Spec | Monthly |
|---|---|---:|
| EKS control plane | 1 cluster (fixed, cannot be paused) | $73.00 |
| EC2 worker nodes | 2 × t4g.small, SPOT | $8.60 |
| NAT gateway | 1 shared (`single_nat_gateway = true`) | $32.85 |
| NAT data processing | ~50 GB/month | $2.25 |
| RDS PostgreSQL | db.t4g.micro, single-AZ | $12.41 |
| RDS storage | 20 GB gp3 | $2.30 |
| RDS backups | 1 day retention, ~5 GB over free tier | $0.47 |
| ElastiCache Redis | cache.t4g.micro, no replica | $12.41 |
| Application Load Balancer | 1 ALB, hourly | $16.43 |
| ALB capacity units | light traffic, ~4 LCU-hours avg | $6.00 |
| KMS | 1 customer-managed key | $1.00 |
| Secrets Manager | 2 secrets | $0.80 |
| CloudWatch Logs | ~5 GB ingest, 7-day retention | $2.89 |
| VPC flow logs | REJECT only, ~1 GB | $0.57 |
| Container image storage | GHCR (free for public) / ECR | $1.00 |
| Data transfer out | ~20 GB | $1.80 |
| **Total** | | **$174.78** |

### Where the money goes

**$122.27 of $174.78 — 70% — is fixed cost that scaling every pod to zero does not
reduce.** That is the EKS control plane ($73.00), the NAT gateway ($32.85) and the ALB
($16.43). The actual compute running the application is $8.60.

That ratio is the honest argument against EKS for a project of this size, and it is why
[cheaper alternatives](#cheaper-ways-to-run-this) are listed below rather than glossed
over. EKS is here because the brief asks for it and because the architecture is the point.

### Where dev already saves money

| Choice | Saves | Trade-off accepted |
|---|---:|---|
| `single_nat_gateway = true` | ~$66/mo | Losing that AZ takes egress with it |
| SPOT node capacity | ~$18/mo | Nodes reclaimed at two minutes' notice |
| `multi_az = false` on RDS | ~$12/mo | Recovery is a restore, not a failover |
| Graviton (`t4g`) instances | ~20% of compute | None material for this workload |
| 1-day backup retention | ~$7/mo | One day of point-in-time recovery |
| S3 gateway endpoint | ~$2/mo | None — it is free and keeps image pulls off the NAT |

---

## Production environment — $509.13/month

`infra/terraform/envs/prod`

| Component | Spec | Monthly |
|---|---|---:|
| EKS control plane | 1 cluster (fixed) | $73.00 |
| EC2 worker nodes | 3 × t4g.medium, ON_DEMAND | $80.59 |
| NAT gateways | 3, one per AZ | $98.55 |
| NAT data processing | ~200 GB/month | $9.00 |
| RDS PostgreSQL | db.t4g.small, **multi-AZ** | $49.64 |
| RDS storage | 50 GB gp3, mirrored | $11.50 |
| RDS backups | 30 day retention, ~80 GB | $7.60 |
| Performance Insights | 7-day retention (free tier) | $0.00 |
| ElastiCache Redis | 2 × cache.t4g.small (primary + replica) | $49.64 |
| Application Load Balancer | 1 ALB, hourly | $16.43 |
| ALB capacity units | moderate traffic, ~17 LCU-hours avg | $25.00 |
| AWS WAF | web ACL + 2 managed rule groups + ~10M requests | $13.00 |
| KMS | 1 key + request volume | $2.00 |
| Secrets Manager | 2 secrets | $0.80 |
| CloudWatch Logs | ~40 GB ingest, 90-day retention | $26.40 |
| ALB access logs | ~20 GB in S3 | $0.48 |
| Data transfer out | ~500 GB | $45.00 |
| Route 53 | 1 hosted zone | $0.50 |
| ACM certificate | public certificate | $0.00 |
| **Total** | | **$509.13** |

Prometheus and Grafana are self-hosted on the cluster and appear as $0 — but that is not
free, it is already counted in the node line as CPU, memory and EBS. Amazon Managed
Prometheus + Grafana would add roughly $40–90/month depending on series count and remove
the operational burden.

### Notable increases from dev

- **NAT gateways triple to $98.55**, the single largest production increase. One per AZ
  buys the property that losing an AZ does not remove egress from the other two.
- **RDS multi-AZ doubles the instance cost** for a standby that serves no reads. It buys
  automatic failover in one to two minutes instead of a restore measured in tens of
  minutes.
- **Data transfer out at $45** is the item that scales with success and is easiest to
  forget. CloudFront in front of the ALB would cut it meaningfully at real volume.
- **Worker nodes at $80.59** because production is ON_DEMAND. Spot would save ~$55 and is
  the wrong trade for a tier serving customers.

---

## What you are actually being charged

The estimate is arithmetic. To see reality once something is deployed:

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -u +%Y-%m-01),End=$(date -u +%Y-%m-%d) \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"Tags":{"Key":"Project","Values":["sw-saas-platform"]}}' \
  --group-by Type=DIMENSION,Key=SERVICE
```

Every resource is tagged `Project=sw-saas-platform` through Terraform `default_tags`,
which is what makes that query work at all. Cost Explorer data lags by up to 24 hours.

---

## Cheaper ways to run this

| Option | Monthly | What you give up |
|---|---:|---|
| **`docker compose`, locally** | **$0** | Nothing but the cloud infrastructure itself |
| Fly.io / Render + managed Postgres | ~$25 | Kubernetes, IRSA, the entire EKS story |
| ECS Fargate + RDS + ElastiCache | ~$110 | Kubernetes; keeps VPC, IAM, ALB, RDS |
| **EKS dev as configured** | **$175** | — |
| EKS with Fargate profiles | ~$160 | Node-level control; still $73 for the control plane |

Note that the row worth taking seriously is the first one. Every isolation guarantee this
project is actually about — row-level security, the least-privilege database role, the
signed tenant claim, the 68 attack tests — is demonstrated completely by
`docker compose up`, for nothing. The AWS environments demonstrate that the same thing can
be deployed, which is a different and more expensive claim.

---

## Guardrails worth setting up first

A budget alert is not optional when the failure mode is a bill rather than an outage.

```bash
aws budgets create-budget \
  --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --budget '{
    "BudgetName": "sw-saas-platform",
    "BudgetLimit": {"Amount": "50", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": {"TagKeyValue": ["user:Project$sw-saas-platform"]}
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "you@example.com"}]
  }]'
```

`FORECASTED` rather than `ACTUAL`: an alert that fires once the money is spent is a
receipt, not a warning.

Also worth doing before walking away:

- Set `kubernetes_api_allowed_cidrs` to your own address. An exposed API server is a
  security problem first, but a compromised cluster mining cryptocurrency is also a
  four-figure bill.
- Put a calendar reminder to run `terraform destroy`. This is the control that actually
  works.

---

## Stopping the charges

See **[teardown.md](teardown.md)**. It covers the order things must be destroyed in, the
resources Terraform will not remove on its own (deletion protection, non-empty S3 buckets,
load balancers created by the AWS Load Balancer Controller rather than by Terraform), and
how to verify the account is genuinely clean afterwards.
