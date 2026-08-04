# sw-saas-platform

> **Status: planned. This repository is a brief, not an implementation.**
> Nothing here is built yet. The sections below define what goes in it.

A production-shaped multi-tenant application covering the whole stack: typed front end, dual REST and GraphQL API, tenant isolation, OAuth2 and JWT auth, infrastructure as code, automated deployment and Prometheus and Grafana observability with defined SLOs.

---

## What this covers

CV entries this repository is the evidence for:

- Full-Stack SaaS Platform
- Production cloud infrastructure and CI/CD (Bottle Bond) - architecture demonstrated here
- React front end and FastAPI back-end services (Bottle Bond)

---

## Requirements

### Hardware

- None. Cloud account for AWS EKS

### Software

- Next.js and React with TypeScript
- Node.js REST and GraphQL API
- PostgreSQL and Redis
- OAuth2 and JWT
- Docker
- Kubernetes on EKS
- Terraform
- GitHub Actions
- Prometheus and Grafana

### Report and documentation deliverables

- Architecture diagram
- Multi-tenancy isolation model
- Data model and ERD
- Auth flow diagram
- Runbook
- SLO definitions
- Cost estimate

---

## Inputs

- User credentials and OAuth tokens
- Tenant configuration
- API requests
- Terraform variables
- Environment secrets

## Outputs

- Rendered application
- REST and GraphQL responses
- Persisted tenant data
- Provisioned cloud infrastructure
- Metrics and dashboards
- Alerts
- CI/CD deployments

---

## Intended structure

```
apps/
  web/                    Next.js and TypeScript
    app/ components/ lib/ tests/
  api/                    Node.js REST and GraphQL
    src/routes/ src/graphql/ src/services/ src/db/migrations/ src/auth/
    tests/
packages/
  shared-types/
infra/
  terraform/              modules/, envs/dev/, envs/prod/
  k8s/                    base/, overlays/
observability/            prometheus/, grafana-dashboards/, alerts/
.github/workflows/        ci.yml, deploy-staging.yml, deploy-prod.yml
docs/                     architecture.md, multi_tenancy.md, erd.png,
                          runbook.md, slos.md
```

Plus the standard baseline: `README.md`, `LICENSE`, `.gitignore`, `.gitattributes`
(Git LFS rules for weights, bags and media), `.github/workflows/ci.yml`, `docs/`,
`scripts/setup.sh`, `scripts/run_demo.sh` and `tests/`.

---

## Build checklist

- [ ] Data model and ERD with the tenancy strategy decided
- [ ] Postgres schema and migrations
- [ ] Auth: OAuth2 and JWT with tenant scoping
- [ ] REST API with tenant isolation enforced and tested
- [ ] GraphQL layer
- [ ] Redis caching and session handling
- [ ] Next.js front end with typed API clients
- [ ] Docker images for web and API
- [ ] Terraform modules for VPC, EKS, RDS and Redis
- [ ] Kubernetes manifests with dev and prod overlays
- [ ] GitHub Actions CI with tests
- [ ] Automated staging and production deployment
- [ ] Prometheus metrics and Grafana dashboards
- [ ] Alert rules and SLO definitions
- [ ] Runbook and cost estimate

---

## Definition of done

This repository is finished when:

- [ ] The whole thing runs from one command on a clean machine.
- [ ] The README opens with a diagram or a GIF, not a wall of text.
- [ ] Every number quoted in the README is reproducible from a script in the repo.
- [ ] Limitations are stated honestly in their own section.
- [ ] A licence is declared.
- [ ] Large binaries live in Releases or LFS, not in the Git history.
- [ ] The repository URL is added to the matching CV bullet point.

---

## Starter prompt

Paste this into your coding agent of choice to begin.

<details>
<summary>Expand</summary>

```
You are helping me build a portfolio project from scratch. Read this brief and then
propose a concrete implementation plan before writing any code.

PROJECT: sw-saas-platform
A production-shaped multi-tenant application covering the whole stack: typed front end, dual REST and GraphQL API, tenant isolation, OAuth2 and JWT auth, infrastructure as code, automated deployment and Prometheus and Grafana observability with defined SLOs.

TARGET STACK
- Next.js and React with TypeScript
- Node.js REST and GraphQL API
- PostgreSQL and Redis
- OAuth2 and JWT
- Docker
- Kubernetes on EKS
- Terraform
- GitHub Actions
- Prometheus and Grafana

HARDWARE CONTEXT
- None. Cloud account for AWS EKS

THE SYSTEM MUST TAKE THESE INPUTS
- User credentials and OAuth tokens
- Tenant configuration
- API requests
- Terraform variables
- Environment secrets

AND PRODUCE THESE OUTPUTS
- Rendered application
- REST and GraphQL responses
- Persisted tenant data
- Provisioned cloud infrastructure
- Metrics and dashboards
- Alerts
- CI/CD deployments

INTENDED REPOSITORY LAYOUT
apps/
  web/                    Next.js and TypeScript
    app/ components/ lib/ tests/
  api/                    Node.js REST and GraphQL
    src/routes/ src/graphql/ src/services/ src/db/migrations/ src/auth/
    tests/
packages/
  shared-types/
infra/
  terraform/              modules/, envs/dev/, envs/prod/
  k8s/                    base/, overlays/
observability/            prometheus/, grafana-dashboards/, alerts/
.github/workflows/        ci.yml, deploy-staging.yml, deploy-prod.yml
docs/                     architecture.md, multi_tenancy.md, erd.png,
                          runbook.md, slos.md

CONSTRAINTS
- Everything must run from a single command: `docker compose up` or `make demo`.
- No placeholder or stub code presented as working. If something is not implemented, say so.
- Every quantitative claim in the README must be reproducible from a script in this repo.
- Use only public or synthetic data. Record the licence of every dataset used.


START BY
1. Confirming or challenging the proposed repository layout.
2. Listing the specific libraries and versions you intend to pin.
3. Identifying the single riskiest technical unknown and how to de-risk it first.
Then work through the milestones in the README build checklist, one at a time.

```

</details>

---

## Notes

- Do not backdate commits to match CV dates. Publishing older work today is normal and expected.
- Record dataset licences before training on anything. Several common research datasets are
  non-commercial only.
- Flip this repository to public once there is something in it worth showing.
