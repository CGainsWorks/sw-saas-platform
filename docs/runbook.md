# Runbook

Operational procedures. Every alert in
[`observability/alerts/api.rules.yml`](../observability/alerts/api.rules.yml) links to a
section here — an alert that fires at 3am with no stated action is a page that trains
people to ignore pages.

**Status:** these procedures are written and the commands are correct for the manifests in
this repository, but they have not been executed against a live production incident,
because there is no production. Treat them as a considered plan rather than a battle-tested
one.

---

## Contents

- [First five minutes](#first-five-minutes)
- **Incidents**
  - [Suspected cross-tenant exposure](#suspected-cross-tenant-exposure) ← read this first if unsure
  - [API down](#api-down)
  - [Elevated 5xx](#elevated-5xx)
  - [Latency](#latency)
  - [Tenant scope violations](#tenant-scope-violations)
  - [Refresh token reuse](#refresh-token-reuse)
  - [Pool exhaustion](#pool-exhaustion)
  - [Slow queries](#slow-queries)
  - [Failed migration](#failed-migration)
- **Procedures**
  - [Deploy and roll back](#deploy-and-roll-back)
  - [Bootstrap a new environment](#bootstrap-a-new-environment)
  - [Rotate credentials](#rotate-credentials)
  - [Restore a tenant's data](#restore-a-tenants-data)

---

## First five minutes

```bash
aws eks update-kubeconfig --name saas-prod --region eu-west-2

kubectl get pods -n saas -o wide
kubectl get events -n saas --sort-by=.lastTimestamp | tail -30
kubectl logs -n saas -l app.kubernetes.io/name=saas-api --tail=100 --since=15m

# Is it one tenant or all of them? This is almost always the first useful question, and
# it is why every log line carries tenantId.
kubectl logs -n saas -l app.kubernetes.io/name=saas-api --since=15m \
  | jq -r 'select(.level >= 50) | .tenantId' | sort | uniq -c | sort -rn | head
```

If that last command shows one tenant dominating, it is a tenant-specific problem —
usually a hot query or a client looping. If it is spread evenly, it is the service.

---

## Suspected cross-tenant exposure

**Severity: highest. This is a data breach until proven otherwise.**

Likely reportable under UK GDPR within **72 hours** of becoming aware. The clock starts at
awareness, not at confirmation.

### Order of operations — do not reorder

The instinct is to fix it first. Don't. The audit log is the only record of what was
actually reached, and a fix can change or truncate it.

**1. Preserve evidence.**

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)

kubectl logs -n saas -l app.kubernetes.io/name=saas-api --since=24h --timestamps \
  > "incident-$TS-api.log"

# Snapshot the database before touching anything.
aws rds create-db-snapshot \
  --db-instance-identifier saas-prod-postgres \
  --db-snapshot-identifier "incident-$TS"
```

**2. Establish the blast radius from the audit log.**

```sql
-- As the master user. app_user cannot read across tenants, which is the point.
SELECT a.tenant_id, t.name, a.actor_id, u.email, a.action, a.entity_type, a.created_at
  FROM audit_log a
  JOIN tenants t ON t.id = a.tenant_id
  LEFT JOIN users u ON u.id = a.actor_id
 WHERE a.created_at > now() - interval '24 hours'
   AND a.actor_id IN (
     -- Actors who appear under more than one tenant. For a legitimate multi-tenant user
     -- such as dave@globex.test this is expected; for anyone else it is the signal.
     SELECT actor_id FROM audit_log
      WHERE created_at > now() - interval '24 hours' AND actor_id IS NOT NULL
      GROUP BY actor_id HAVING count(DISTINCT tenant_id) > 1
   )
 ORDER BY a.actor_id, a.created_at;
```

Cross-reference with `memberships` — an actor writing to a tenant they hold no membership
in is the confirmation.

**3. Contain.**

```bash
# Revoke every refresh token. Everyone is logged out within one access-token lifetime
# (15 minutes) and cannot get a new one.
kubectl exec -n saas deploy/saas-api -- \
  node -e "const {Redis}=require('ioredis');const r=new Redis(process.env.REDIS_URL);
           r.keys('g:rt:*').then(k=>k.length?r.del(...k):0).then(n=>{console.log('revoked',n);r.quit()})"
```

Rotating the JWT signing key invalidates every access token immediately — a harder stop
that logs everyone out with no grace period. See [rotate credentials](#rotate-credentials).

**4. Verify the boundary is intact.** Very often the answer is that it is, and the report
was something else.

```bash
kubectl exec -n saas deploy/saas-api -- node -e "
  const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});
  c.connect().then(()=>c.query(\`
    SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user\`))
   .then(r=>{console.log(r.rows);return c.query(\`
    SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relnamespace='public'::regnamespace AND relkind='r'\`)})
   .then(r=>{console.table(r.rows);c.end()})"
```

`rolbypassrls` must be `false` and every tenant-owned table must show both flags true. If
either is wrong, that is the root cause and it is an infrastructure change, not a code bug.

**5. Only now, fix.** Then add the attack that was missed to
`apps/api/tests/isolation/` and confirm `node scripts/verify-isolation.mjs` catches it.

---

## API down

`ApiDown` — Prometheus cannot scrape the API.

```bash
kubectl get pods -n saas -l app.kubernetes.io/name=saas-api
kubectl describe pod -n saas -l app.kubernetes.io/name=saas-api | tail -40
```

| Pod state | Likely cause | Action |
|---|---|---|
| `CrashLoopBackOff` | Config validation, or the boot-time RLS assertion | `kubectl logs --previous` — the message is explicit |
| `Pending` | No schedulable node; spot reclaim; topology constraint unsatisfiable | `kubectl describe` shows the reason; check node count |
| `ImagePullBackOff` | Bad digest or registry auth | Check the image reference matches what CI pushed |
| `Running` but not ready | `/readyz` failing — Postgres or Redis unreachable | `kubectl exec … curl -s localhost:4000/readyz` |
| Running and ready | Prometheus problem, not an API problem | Check the ServiceMonitor and NetworkPolicy |

**Note the deliberate design:** liveness does *not* check dependencies. A database outage
will not make Kubernetes restart every pod, so if pods are crash-looping the cause is the
process itself, not Postgres.

A boot failure reading `Refusing to start: database role … can bypass row-level security`
is [working as intended](#bootstrap-a-new-environment) — `DATABASE_URL` is pointed at the
master user.

---

## Elevated 5xx

`ApiErrorBudgetFastBurn` (page) / `ApiErrorBudgetSlowBurn` (ticket).

```bash
kubectl logs -n saas -l app.kubernetes.io/name=saas-api --since=15m \
  | jq -r 'select(.res.statusCode >= 500) | "\(.req.url) \(.err.message // .msg)"' \
  | sort | uniq -c | sort -rn | head -20
```

Then, in order of likelihood:

1. **Did something just deploy?** `kubectl rollout history deployment/saas-api -n saas`.
   If the timing lines up, [roll back](#deploy-and-roll-back) and diagnose afterwards.
2. **Is the database reachable?** `kubectl exec deploy/saas-api -- curl -s localhost:4000/readyz`
3. **Is the pool exhausted?** See [pool exhaustion](#pool-exhaustion).
4. **Is one tenant responsible?** The `jq` on `.tenantId` from
   [first five minutes](#first-five-minutes).

---

## Latency

`ApiLatencyHigh` — p99 above 500 ms for 10 minutes.

```promql
# Which route?
topk(5, histogram_quantile(0.95,
  sum by (le, route) (rate(saas_api_http_request_duration_seconds_bucket[5m]))))

# Is it the database, or the application?
histogram_quantile(0.95,
  sum by (le) (rate(saas_api_db_transaction_duration_seconds_bucket[5m])))
```

If transaction duration tracks request duration, it is the database — go to
[slow queries](#slow-queries). If not, it is CPU, garbage collection, or an external call
(the OIDC provider's JWKS endpoint is the only one on a request path, and it is cached for
10 minutes).

Remember there are **no CPU limits** on these containers by design, so this is not
throttling. Check node pressure: `kubectl top nodes`.

---

## Tenant scope violations

`TenantScopeViolationSpike` — rejected-tenant-scope requests above 1/sec for 5 minutes.

**The `reason` label decides how worried to be.**

```promql
sum by (reason) (rate(saas_api_tenant_scope_violations_total[5m]))
```

| `reason` | Meaning | Severity |
|---|---|---|
| `no_token` | Unauthenticated request to a protected route | Low — scanners, stale tabs |
| `ERR_JWT_EXPIRED` | Expired access token | Low — normal, or refresh is broken |
| `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` | **Forged or tampered token** | **High** |
| `no_tenant` / `no_role` | Token verified but missing required claims | **High** — signing bug, or a token from another issuer |
| `ERR_JWT_CLAIM_VALIDATION_FAILED` | Wrong `iss` or `aud` | Medium — misconfiguration or cross-environment token |

A spike in `no_token` or `expired` after a deploy usually means the refresh flow broke —
check `saas_api_auth_events_total{event="refresh"}`.

A spike in signature failures means someone is actively trying to forge tokens. It is not
itself an exposure — the check worked — but capture the source IPs from ALB access logs
and consider a WAF rule.

---

## Refresh token reuse

`RefreshTokenReuseDetected`.

The token family was already revoked automatically; no action is needed to contain it. The
question is *why*.

```bash
kubectl logs -n saas -l app.kubernetes.io/name=saas-api --since=1h \
  | jq -r 'select(.msg | test("reuse detected")) | "\(.time) family=\(.familyId) revoked=\(.revoked)"'
```

- **One or two events, spread out** — almost certainly a client replaying a request:
  double-submit, a retry after a timeout, a restored browser session. Benign.
- **A burst for one family** — a stolen token being used alongside the legitimate client.
  Treat as credential compromise: confirm the user re-authenticates, and check the audit
  log for what that session did.
- **Many families at once** — suspect Redis. A flush or failover loses the rotation
  markers and every subsequent refresh looks like reuse. Check `redis` health before
  concluding anything about attackers.

---

## Pool exhaustion

`DatabasePoolExhausted` — requests queueing for a connection.

This is the pooled tenancy model's characteristic failure: one tenant's traffic becomes
every tenant's outage, because they share the pool.

```promql
saas_api_db_pool_connections            # by state: total, idle, waiting
```

```sql
-- What is actually holding connections?
SELECT pid, usename, state, wait_event_type, wait_event,
       now() - query_start AS duration, left(query, 120) AS query
  FROM pg_stat_activity
 WHERE datname = 'saas' AND state <> 'idle'
 ORDER BY duration DESC LIMIT 20;
```

| Finding | Action |
|---|---|
| Long-running queries | [Slow queries](#slow-queries). `statement_timeout` (10s) should already be killing them — if not, config is wrong |
| Many `idle in transaction` | A transaction is being left open. `idle_in_transaction_session_timeout` is the backstop; find the code path |
| All connections busy, all queries fast | Genuine load. HPA should be scaling; check it is not at `maxReplicas` |

**Do not simply raise `PGPOOL_MAX`.** Every replica multiplies it, and `db.t4g.small`
allows roughly 170 connections total. `3 replicas x 10 = 30` is the current headroom;
raising the pool without raising the instance moves the failure from the application to
the database, where it is worse.

---

## Slow queries

```sql
-- Requires pg_stat_statements.
SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms,
       round(total_exec_time::numeric) AS total_ms, left(query, 120)
  FROM pg_stat_statements
 WHERE query NOT LIKE '%pg_stat%'
 ORDER BY total_exec_time DESC LIMIT 20;
```

RDS also logs anything over 500 ms (`log_min_duration_statement`), retrievable from the
`postgresql` CloudWatch log export.

**Check the plan is still index-only.** RLS adds a predicate to every query, and a plan
that stops using a `tenant_id`-leading index degrades sharply:

```sql
BEGIN;
SELECT set_config('app.current_tenant', '<a real tenant uuid>', true);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM tasks WHERE project_id = '<uuid>';
COMMIT;
```

Look for `Index Scan using tasks_tenant_project_idx`. A `Seq Scan` on a large table means
the policy predicate is not being pushed into the index — usually because a new query
shape does not lead with `tenant_id`.

---

## Failed migration

The deploy workflow runs migrations to completion **before** rolling out new pods, so a
failed migration normally means the old version is still serving. That is the good case.

```bash
kubectl logs job/saas-migrate -n saas --tail=200
```

The runner wraps each migration and its bookkeeping row in **one transaction**, so a
failed migration is rolled back and is not recorded as applied. The database is in the
state it was before that file ran.

1. Fix the SQL.
2. Deploy again. Already-applied migrations are skipped after a checksum check.

**If it partially applied anyway** — only possible if the file contains something
non-transactional such as `CREATE INDEX CONCURRENTLY`, which nothing here does — write a
new forward migration to reconcile. Never edit an applied migration: the runner records a
checksum and will refuse to proceed, deliberately, because the file no longer describes
the database.

**Rollbacks do not revert migrations.** `kubectl rollout undo` returns the *code*; the
schema stays forward. This is why migrations must be backwards-compatible with the
previous release — add columns before writing to them, remove readers before dropping
columns.

---

## Deploy and roll back

Deploys are automated: push to `main` → staging; push a `v*.*.*` tag → production, behind
a GitHub Environment approval.

```bash
# Roll back to the previous ReplicaSet.
kubectl rollout undo deployment/saas-api -n saas
kubectl rollout status deployment/saas-api -n saas --timeout=300s

# Or to a specific revision.
kubectl rollout history deployment/saas-api -n saas
kubectl rollout undo deployment/saas-api -n saas --to-revision=3
```

The deploy workflow does this automatically when the post-deploy smoke test fails, and
prints a warning that the schema was not reverted.

---

## Bootstrap a new environment

After `terraform apply`, before the first deploy.

```bash
cd infra/terraform/envs/dev
terraform apply
eval "$(terraform output -raw kubeconfig_command)"
```

**1. Install the cluster add-ons** (not managed by Terraform here — they are cluster-wide
concerns with their own release cadence):

```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo add external-secrets https://charts.external-secrets.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName=saas-dev

helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace
```

**2. Set the `app_user` password.** Migration `0002` creates the role; it does not set a
password (a migration cannot hold a secret).

```bash
# Master credential, from Secrets Manager.
ADMIN=$(aws secretsmanager get-secret-value --secret-id saas-dev/rds/master \
  --query SecretString --output text)
APP=$(aws secretsmanager get-secret-value --secret-id saas-dev/app \
  --query SecretString --output text)

# Extract the password Terraform generated for app_user from DATABASE_URL, then set it.
psql "$(echo "$ADMIN" | jq -r '"postgres://\(.username):\(.password)@\(.host):\(.port)/\(.dbname)"')" \
  -c "ALTER ROLE app_user WITH PASSWORD '$(echo "$APP" | jq -r '.DATABASE_URL' | sed -E 's|.*://app_user:([^@]+)@.*|\1|')';"
```

**3. Annotate the service account** with the IRSA role and apply:

```bash
terraform output -raw api_irsa_role_arn   # paste into the overlay's serviceaccount patch
kubectl apply -k infra/k8s/overlays/dev
```

**4. Verify the isolation boundary before sending traffic.**

```bash
kubectl exec -n saas deploy/saas-api -- \
  node -e "require('./dist/db/pool.js').assertLeastPrivilege().then(()=>console.log('OK'))"
```

The API refuses to start if this fails, so a running pod already implies it passed — but
check explicitly the first time.

**5. Confirm NetworkPolicies are actually enforced.** The AWS VPC CNI does not enforce
them by default; applied without an enforcing CNI they are accepted silently and do
nothing, which is worse than not having them.

```bash
kubectl get ds -n kube-system aws-node \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="aws-node")].env[?(@.name=="ENABLE_NETWORK_POLICY")].value}'
# must print "true"
```

---

## Rotate credentials

**JWT signing key** — invalidates every access token immediately; everyone re-authenticates.

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/jwt.pem
openssl rsa -in /tmp/jwt.pem -pubout -out /tmp/jwt.pub

CURRENT=$(aws secretsmanager get-secret-value --secret-id saas-prod/app \
  --query SecretString --output text)

echo "$CURRENT" | jq \
  --arg priv "$(base64 -w0 /tmp/jwt.pem)" \
  --arg pub  "$(base64 -w0 /tmp/jwt.pub)" \
  '.JWT_PRIVATE_KEY_B64=$priv | .JWT_PUBLIC_KEY_B64=$pub' \
  | aws secretsmanager put-secret-value --secret-id saas-prod/app --secret-string file:///dev/stdin

shred -u /tmp/jwt.pem /tmp/jwt.pub

# External Secrets syncs within 15 minutes, but config is read at BOOT — a restart is
# required. This is a known rough edge, documented rather than hidden.
kubectl rollout restart deployment/saas-api -n saas
```

**Database password:**

```sql
ALTER ROLE app_user WITH PASSWORD 'new-password';
```

Update `DATABASE_URL` in the secret, then `kubectl rollout restart`. Existing pooled
connections survive on the old credential until they are recycled, so there is no hard
cutover.

---

## Restore a tenant's data

**This is the pooled model's sharpest edge.** Every tenant shares the same tables, so
there is no per-tenant restore. Recovering one customer means restoring the whole cluster
to a point in time and extracting their rows.

```bash
# 1. Restore to a NEW instance. Never restore over the live one.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier saas-prod-postgres \
  --target-db-instance-identifier saas-prod-restore-$(date +%Y%m%d) \
  --restore-time 2026-08-05T09:00:00Z

# 2. Extract only that tenant. The FK order matters.
pg_dump "postgres://…@saas-prod-restore-…/saas" \
  --data-only \
  --table=projects --table=tasks --table=comments \
  > tenant-restore.sql
```

Then filter to the tenant id and reconcile against live data — which is a manual,
judgement-heavy step, because rows may have changed since. **There is no tested automation
for this**, and that is stated as a limitation in
[multi_tenancy.md §8](multi_tenancy.md#8-known-limitations) rather than implied to be
solved.

Delete the restored instance when finished; it bills at full rate.
