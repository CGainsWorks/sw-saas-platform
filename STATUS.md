# Status

Last updated: 2026-10-30.

Nothing in this repository runs on AWS. Every AWS service it depends on is either emulated
locally and exercised in CI, or stated below as not exercised.

## Complete

- **Local stack.** `docker compose up --build` runs Postgres, Redis, the dev OIDC provider,
  the API, the web app, Prometheus and Grafana. `scripts/smoke-test.mjs` (28 checks,
  including a real OAuth2 flow) runs against it by hand; it is not in CI.
- **Tenant isolation tests.** 68 tests in `apps/api/tests/isolation/` (15 GraphQL, 17 HTTP,
  13 RLS invariants, 11 RLS reads, 12 RLS writes), run in CI against real PostgreSQL 16.4
  and Redis 7.4 service containers and mutation-checked by `scripts/verify-isolation.mjs`
  (each tenant-owned table's policy is removed in turn and the suite must go red).
- **Kubernetes layer on kind (CI job `kind`).** `scripts/kind/up.sh` creates a kind
  cluster (kind v0.33.0, node v1.35.8) with the default CNI replaced by Calico v3.32.3,
  builds the API and web images from the commit and deploys the **dev overlay** through
  `infra/k8s/overlays/kind`. The ExternalSecret syncs, the migration Job completes and
  both Deployments become ready under the restricted Pod Security Standard.
- **NetworkPolicy enforcement.** `scripts/kind/netpol-check.sh` makes 6 TCP checks from
  inside pods: the API pod reaches Postgres and Redis; the web pod reaches neither; an
  unlabelled pod in `saas` cannot reach Postgres; the same pod in a namespace without
  policies can (the control). All 6 pass in CI.
- **Isolation tests against the in-cluster API.** `scripts/kind/isolation-tests.sh` runs the
  same 68 tests with the HTTP and GraphQL suites sent to the API deployed in kind
  (production image, `NODE_ENV=production`, secrets from External Secrets) and the RLS
  suites against the in-cluster Postgres. All 68 pass in CI.
- **Secrets Manager and External Secrets, emulated.** LocalStack 4.14.0 (the last
  Community release, pinned by digest) provides Secrets Manager inside the cluster. The
  External Secrets Operator 2.14.0 (Helm) has its Secrets Manager and STS endpoints
  pointed at LocalStack and syncs `saas-dev/app` into `saas-api-secrets` through the
  base `ExternalSecret`, unchanged. Only the `SecretStore` auth block differs from dev:
  static LocalStack keys instead of IRSA. This is LocalStack, not the operator's fake
  provider.
- **Load test.** A basic k6 test (`loadtest/k6/api.js`, grafana/k6 1.8.2) against the API
  in docker compose, run from the manual `Load test` workflow. One labelled result from a
  GitHub-hosted runner is in `loadtest/results/`.
- **Manifest and IaC checks in CI.** `terraform fmt` and `terraform validate` (no AWS
  credentials), `kubectl kustomize` for every overlay, `promtool check rules`, npm audit
  and a Trivy filesystem scan.

## In progress

- Nothing.

## Not started

- Billing and SSO hooks (usage events to a billing service, an external IdP such as
  Keycloak in compose).
- Distributed tracing.
- Load testing at production scale or on dedicated hardware.

## Limitations

- **AWS is never used.** Terraform for VPC, EKS, RDS, ElastiCache and Secrets Manager is
  validated but has never been applied. The deploy workflows are manual only and have
  never run.
- **IRSA is not exercised.** On kind the SecretStore uses static keys against LocalStack;
  the IAM role binding the EKS module creates has never been tested.
- **NetworkPolicies are proven on Calico, not on EKS.** The AWS VPC CNI only enforces them
  when network policy support is enabled on the addon.
- **The in-cluster data stores are stand-ins.** Single Postgres and Redis pods with no
  persistence, TLS or authentication on Redis, unlike RDS and ElastiCache.
- **The ALB ingress is not exercised.** No AWS Load Balancer Controller runs on kind; the
  Ingress object is accepted and nothing serves it. The tests reach the API through
  `kubectl port-forward`.
- **The API ingress policy admits any pod in 10.0.0.0/8.** It is written for ALB traffic
  from the VPC range; on a cluster whose pods also live in that range it lets every
  pod reach the API on port 4000.
- **The dev HorizontalPodAutoscaler overrides the dev replica count.** The dev overlay sets
  one replica; the base HPA has `minReplicas: 2`, so two pods run.
- **The load test is basic.** One tenant, reads only, a shared CI runner, a single run.
  The numbers say nothing about production capacity.
