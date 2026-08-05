# Service level objectives

Three SLOs. Deliberately few: an SLO nobody would act on is a dashboard, not an
objective, and a long list guarantees most of them are ignored.

Each one names what it measures, what it excludes, what the error budget buys, and what
happens when the budget is burning. The alert expressions that implement them are in
[`observability/alerts/api.rules.yml`](../observability/alerts/api.rules.yml) and run in
the local demo as well as in the cluster — an alert that only exists in production has
never been tested.

---

## Why these three

Following the "four golden signals" minus saturation, which is a cause rather than a
symptom. Saturation is alerted on separately (`DatabasePoolExhausted`) because in a pooled
tenancy model the shared connection pool is the mechanism by which one tenant's traffic
becomes everyone's outage — but it is a diagnostic, not an objective.

| | Objective | Window |
|---|---|---|
| Availability | 99.9% of requests do not return 5xx | 30 days rolling |
| Latency | 99% of requests complete within 500 ms | 30 days rolling |
| Isolation | Zero confirmed cross-tenant data exposures | Always |

---

## 1. Availability — 99.9%

**SLI.** The proportion of HTTP requests that do not return a 5xx status.

```promql
sum(rate(saas_api_http_requests_total{status_code!~"5.."}[30d]))
/
sum(rate(saas_api_http_requests_total[30d]))
```

**Target:** 99.9% over a 30-day rolling window.

**Error budget:** 0.1%, which is **43 minutes 12 seconds** of total unavailability per
30 days, or one request in a thousand.

**What is excluded, and why:**

- **4xx responses.** A client sending a malformed body is not the service failing. This
  matters here more than usual: cross-tenant access attempts return 404, and counting
  those as errors would mean a determined attacker could burn the error budget and
  trigger a rollback.
- **Requests to `/healthz`, `/readyz` and `/metrics`.** Probe traffic, not user traffic;
  including it inflates the denominator and flatters the number.
- **Planned maintenance windows**, when announced in advance.

**Alerting.** Multi-window, multi-burn-rate rather than a fixed threshold. A plain
"error rate > 0.1%" either pages constantly on brief blips or misses a slow burn that
quietly exhausts the whole budget over a week.

| Alert | Burn rate | Budget gone in | Windows | Action |
|---|---|---|---|---|
| `ApiErrorBudgetFastBurn` | 14.4× | ~2 days | 5m **and** 1h | Page |
| `ApiErrorBudgetSlowBurn` | 6× | ~5 days | 6h | Ticket |

The fast-burn alert requires *both* the 5-minute and 1-hour windows to be over
threshold. The short window makes it react quickly; the long window stops a 30-second
blip from paging anyone.

---

## 2. Latency — p99 under 500 ms

**SLI.** The 99th percentile of request duration, measured server-side from the start of
request handling to the end of the response.

```promql
histogram_quantile(
  0.99,
  sum by (le) (rate(saas_api_http_request_duration_seconds_bucket[30d]))
)
```

**Target:** p99 ≤ 500 ms.

**Why p99 and not p50.** A median is a statement about a typical request, and users do
not experience the median — they experience their own slowest request. p99 is roughly the
worst experience a regular user has on any given day. p999 would be better still, and is
not measurable at this traffic volume without the number being mostly noise.

**Measured server-side, which is a real limitation.** It excludes network transit, TLS
negotiation and browser rendering, so it undercounts what a user actually waits for. Real
user monitoring would be the honest version. This is the number available without
shipping a client-side agent.

**Known contributors:**

- Every request opens a transaction, because `SET LOCAL` requires one. Measured at
  roughly **0.3 ms** locally — see [`multi_tenancy.md §8`](multi_tenancy.md#8-known-limitations).
- RLS adds a predicate to every query. With `tenant_id` leading every relevant index the
  plans stay index-only, but this has not been benchmarked at a scale where it would hurt.
- GraphQL operations fan out across DataLoader batches, each opening its own short
  transaction. A deep query costs more transactions than the equivalent REST call — a
  deliberate trade documented in [`graphql/context.ts`](../apps/api/src/graphql/context.ts).

---

## 3. Tenant isolation — zero exposures

**SLI.** Confirmed incidents in which one tenant was able to read or modify another
tenant's data.

**Target:** zero. **Error budget: none.**

This is the one SLO with no budget, and it is worth being explicit about why that is not
just rhetoric. Availability and latency degrade gracefully — a slow request is worse than
a fast one, and users trade one against the other all the time. A cross-tenant exposure
does not degrade: it is a breach, it is likely reportable under GDPR within 72 hours, and
it cannot be undone by shipping a fix. There is no quantity of it that is acceptable, so
there is no budget to spend.

**Proxy signals**, since the SLI itself is only measurable after the fact:

```promql
# Requests rejected because the tenant claim failed a check.
sum(rate(saas_api_tenant_scope_violations_total[5m]))
```

A low background rate is normal — expired tokens, users returning to stale tabs. A spike
is either an attack in progress or a bug that has started sending requests to the wrong
tenant. The `reason` label separates the two: `no_token` and `expired` are benign;
anything else means tokens are being tampered with.

**Preventive controls**, which is where the actual work lives:

| Control | Where |
|---|---|
| RLS `FORCE` on every tenant-owned table | migration `0002_rls.sql` |
| Application role is `NOBYPASSRLS`, verified at boot | `db/pool.ts` |
| Tenant identity only ever from a signed token claim | `auth/middleware.ts` |
| Composite foreign keys making cross-tenant references unrepresentable | migration `0001_init.sql` |
| Cache keys that cannot be built without a tenant id | `cache/redis.ts` |
| 68 cross-tenant attack tests, required on `main` | `apps/api/tests/isolation/` |
| Mutation check proving those tests detect a removed policy | `scripts/verify-isolation.mjs` |

**If it happens.** [`runbook.md`](runbook.md#suspected-cross-tenant-exposure) has the
procedure. In outline: preserve the audit log first, identify the blast radius from it,
revoke every affected session, then fix — in that order, because the audit trail is the
only record of what was reached and the temptation is always to fix first.

---

## Reviewing these

Quarterly, or after any incident that one of them should have caught but did not.

The questions worth asking are whether the target still matches what users need — a
99.9% target on a service nobody would notice being down for an hour is over-engineering
— and whether any alert has fired without anyone acting on it, which means it should be
deleted or downgraded rather than tolerated.

---

## Honest status

These SLOs are **defined and instrumented, not yet operated**. The metrics exist, the
alert rules parse and fire against the local stack, and the Grafana dashboard renders
them. What does not exist is 30 days of production traffic to measure against, or an
on-call rotation to page. The numbers above are targets chosen to be defensible, not
observations.
