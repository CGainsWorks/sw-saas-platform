# Multi-tenancy isolation model

**Status:** decided, implemented, and tested.
**Decision:** Pool model — shared database, shared schema — with **PostgreSQL Row-Level
Security (RLS)** as the enforcement boundary, driven by a per-transaction session
variable and a database role that has no ability to bypass it.

This document is the load-bearing one. The data model, the auth design, the service
layer, the connection pooling strategy and the cost model all follow from it. Read it
before reading any code.

---

## 1. The choice

Three isolation models are conventionally available. The names below follow the AWS
SaaS Lens taxonomy (silo / bridge / pool) because that is the vocabulary most readers
will already have.

| Model | Physical layout | Blast radius of a bug | Cost at 1000 tenants | Migration cost |
|---|---|---|---|---|
| **Silo** | One database (or one cluster) per tenant | One tenant | Very high — you pay per tenant | 1000 migration runs |
| **Bridge** | One schema per tenant, shared database | One tenant | Moderate — one cluster, but catalog bloat | 1000 × N tables of DDL |
| **Pool** *(chosen)* | Shared schema, `tenant_id` on every row | **All tenants, unless enforced below the app** | Low — one cluster | One migration run |

I chose **pool**, and then spent the isolation budget on making the "blast radius"
cell in that row false.

### Why pool

- **Cost.** This is a portfolio project on an AWS account I pay for personally. Silo
  means one RDS instance per tenant; at the smallest sane production instance
  (`db.t4g.small`, multi-AZ) that is roughly $50/month **per tenant**. Pool is one
  cluster regardless of tenant count. The cost model in [`cost.md`](cost.md) assumes
  pool; silo would make the demo unaffordable to run for more than a day.
- **Operational simplicity.** One migration run, one connection pool, one backup, one
  set of dashboards. Bridge and silo both turn a routine schema change into a
  fan-out job with partial-failure states, which is a genuine source of production
  incidents and not something I want to hand-roll to prove a point.
- **Connection economics.** Postgres connections are expensive (roughly 5–10 MB each).
  Schema-per-tenant tends toward pool-per-tenant, because a pooled connection carries
  a `search_path`. The pool model lets every tenant share one pool, with the tenant
  identity scoped to the *transaction* rather than the *connection* — see §3.
- **It is the honest default.** Most real B2B SaaS starts pooled and carves out silos
  for the handful of enterprise customers who contractually require it. Building the
  pooled path well, with a documented escape hatch (§7), reflects that reality better
  than picking the model that makes isolation trivially easy.

### What pool costs me

The pool model's weakness is real and I am not going to soften it: **a single missing
`WHERE tenant_id = $1` leaks another customer's data.** Application-layer scoping is
one forgotten clause away from a breach, and code review does not reliably catch it —
it is an omission, not a commission, so there is nothing on the screen to notice.

That is the entire reason for the next section.

---

## 2. The enforcement boundary is the database, not the application

**The application is not trusted to scope its own queries.**

The service layer *does* write `WHERE tenant_id = $1`, because it produces better query
plans and clearer code. But correctness does not depend on it. Every tenant-owned table
has RLS enabled with `FORCE`, and the application connects as a role that cannot turn
it off. If a developer forgets the clause, the database returns zero rows instead of
someone else's rows.

Concretely, three things have to all be true, and each is independently verified by a
test:

1. **`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`** on every tenant-owned
   table. `FORCE` matters: without it, the table's *owner* bypasses RLS, and it is very
   easy to end up running the app as the owner. See
   [`migrations/0002_rls.sql`](../apps/api/src/db/migrations/0002_rls.sql).
2. **The app connects as `app_user`**, a role with `NOBYPASSRLS`, which is not the owner
   of any table and holds no `SUPERUSER`. Superusers and table owners silently ignore
   RLS policies; connecting as one would make every policy in this repo decorative.
3. **Tenant identity is set per transaction**, via `SET LOCAL app.current_tenant`, by a
   wrapper that is the only way the service layer is allowed to reach the database.

The policy itself is uniform across tables:

```sql
CREATE POLICY tenant_isolation ON projects
  USING      (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

`USING` governs what rows are *visible* to `SELECT`/`UPDATE`/`DELETE`. `WITH CHECK`
governs what rows may be *written* by `INSERT`/`UPDATE`. Both are required — a policy
with only `USING` lets a tenant happily insert rows stamped with someone else's
`tenant_id`, and lets an `UPDATE` move a row *out* of its own tenant. That specific
mistake is common enough that there is a dedicated test for it
(`writes cannot forge a foreign tenant_id`).

The `true` second argument to `current_setting` makes it return `NULL` rather than
raising when the variable is unset. That turns the comparison into `NULL`, which is not
`TRUE`, so **an unscoped connection sees nothing at all**. Fail-closed, not fail-open.
There is a test for that too (`a connection with no tenant set sees zero rows`).

### Why `SET LOCAL` and not `SET`

`SET LOCAL` is scoped to the enclosing transaction and is reverted on `COMMIT` or
`ROLLBACK`. Plain `SET` persists for the life of the *connection* — and connections are
recycled through a pool into the next request, which may belong to a different tenant.
Using `SET` here would produce an intermittent, load-dependent cross-tenant leak: the
worst possible failure mode, because it would pass every test run serially and fail in
production under concurrency.

Because `SET LOCAL` requires a transaction, `withTenant()` opens one unconditionally,
even for a single `SELECT`. That is a deliberate cost: an extra `BEGIN`/`COMMIT`
round-trip per read, in exchange for making the safe path the only path.

### The chokepoint

There is exactly one function in the codebase that hands out a database connection to
business logic:

```ts
// apps/api/src/db/tenant-context.ts
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T>
```

It acquires a connection, `BEGIN`s, validates that `tenantId` is a well-formed UUID,
issues `SET LOCAL app.current_tenant`, runs the callback, and commits or rolls back.
The `TenantClient` it yields exposes only `query()` — it does not expose `release()`,
`BEGIN`, or the raw pool, so business logic cannot escape the transaction or hold the
connection past it.

The UUID validation before interpolation is not decoration. `SET LOCAL` does not accept
bind parameters for the *value* in all drivers, so the tenant id reaches the SQL string
by interpolation; validating it as a UUID first is what stops that from being an
injection point. It is done with `set_config('app.current_tenant', $1, true)` — the
function form, which *does* take a bind parameter — with the regex check as a second
layer. Belt and braces, because this is the one line where getting it wrong is fatal.

---

## 3. Where tenant identity comes from

Never from the client. Specifically, never from a `X-Tenant-Id` header, a query
parameter, or a request body field — all three are attacker-controlled.

Tenant identity is a **claim inside the signed access token**:

```
sub:       user id
tenant_id: tenant this token is scoped to
role:      owner | admin | member  (within that tenant)
```

The token is RS256-signed by the API's own key. The chain is:

1. User authenticates at the OIDC provider (authorization code + PKCE).
2. API verifies the provider's ID token against its JWKS, extracting a verified email.
3. API looks up which tenants that email has membership in — **a database lookup, not
   a client assertion**.
4. API mints its own access token carrying `tenant_id` for the selected membership.
5. Every subsequent request derives `tenantId` from that verified token claim, and
   passes it to `withTenant()`.

A user who belongs to more than one tenant gets one token per tenant and switches
explicitly via `POST /v1/auth/switch-tenant`, which re-checks membership in the
database before minting the new token. Holding a token for tenant A grants nothing in
tenant B, and there is a test that takes a valid token from one tenant and replays it
against another tenant's resources.

See [`auth_flow.md`](auth_flow.md) for the full sequence including refresh rotation.

---

## 4. What is *not* tenant-scoped

Being explicit about the exceptions, because an unexplained exception is
indistinguishable from a bug:

| Table | Why it has no RLS policy |
|---|---|
| `tenants` | The tenant registry itself. Readable only via `withTenant`-independent admin paths; the app role has `SELECT` on it but every application read is by primary key with the id already derived from a verified token claim. |
| `users` | A user is a global identity (one email, one row) that may hold membership in several tenants. Tenant-scoping lives on `memberships`, which *is* RLS-protected. |
| `schema_migrations` | Migration bookkeeping. Owned by the migrator role; `app_user` has no access at all. |

`memberships` is the join table and is the security-critical one — it is RLS-protected
so that tenant A cannot enumerate who belongs to tenant B, which would otherwise be a
user-enumeration oracle across customers.

---

## 5. Defence in depth, listed by layer

Isolation is not one mechanism. If any single layer below fails, the layer beneath it
still denies the request.

| Layer | Mechanism | Fails closed? |
|---|---|---|
| Token | `tenant_id` is a signed claim; never read from headers or body | Yes — unsigned/expired token is rejected before routing |
| Request | `requireAuth` populates `req.tenantId` from the verified claim only | Yes — no claim, no `tenantId`, route 401s |
| Service | Every query goes through `withTenant()`; no raw pool access | Yes — no tenant, no connection |
| Query | Service layer also writes explicit `WHERE tenant_id = $1` | Partially — this is the layer assumed to be fallible |
| **Database** | **RLS `FORCE` + `NOBYPASSRLS` role + `SET LOCAL`** | **Yes — unset variable matches nothing** |
| Cache | Redis keys are prefixed `t:{tenantId}:` and built by one helper | Yes — key builder requires tenant id |

The Redis row deserves a note: caches are a classic isolation bypass, because a cache
hit skips the database entirely and therefore skips RLS. Every cache key in this repo
is constructed by `tenantKey(tenantId, ...parts)`, which is the only exported key
builder, and there is a test asserting that a cached value written under tenant A is
not returned to tenant B.

---

## 6. How this is proved

Claiming isolation is cheap. The repo contains tests that actively **attack** the
boundary and assert the attack fails. They run against a real PostgreSQL container in
CI, not a mock, because a mock cannot enforce RLS.

`apps/api/tests/isolation/` contains, at the database layer:

- reads scoped to tenant A never return tenant B's rows
- a connection with **no** tenant set sees zero rows (fail-closed)
- `INSERT` cannot forge a foreign `tenant_id` (`WITH CHECK`)
- `UPDATE` cannot move a row into another tenant (`WITH CHECK`)
- `UPDATE`/`DELETE` targeting a known foreign primary key affect **0 rows**
- a foreign row cannot be reached by pivoting through a foreign key join
- aggregates (`COUNT(*)`) do not leak the existence of foreign rows
- the app role cannot `SET ROLE`, cannot disable RLS, and is not `BYPASSRLS`
- tenant context does not survive a transaction (pool-recycling regression test)

and at the HTTP/GraphQL layer:

- a valid tenant-A token replayed against a tenant-B resource id returns 404, not 403
  — a 403 confirms the resource exists, which is itself a cross-tenant information leak
- `X-Tenant-Id` header injection is ignored
- a tenant claim edited without re-signing is rejected
- the same attacks through GraphQL, including via nested field resolvers, which is the
  path that bypasses REST route guards
- cache poisoning across tenants

Run them with:

```bash
make test-isolation
```

The suite is a required status check on `main`. If someone deletes a policy, CI goes
red.

---

## 7. Escape hatch: when a tenant needs a silo

The pool model is the default, not a religion. A tenant with a contractual data
residency or physical isolation requirement is handled by promoting them to a silo,
and the schema is designed so this does not require a rewrite:

- `tenants.isolation_model` is an enum (`pool` | `silo`) with a `shard_dsn` column,
  null for pooled tenants.
- The connection factory resolves a DSN per tenant. Today every pooled tenant resolves
  to the same primary pool; a silo tenant would resolve to its own.
- Because `tenant_id` is present on every row *even in a silo*, the same RLS policies
  and the same service-layer code work unchanged in both models. The migration path for
  promoting a tenant is a data copy, not a code change.

This is implemented as far as the schema and the connection factory. **The silo path is
not exercised — there is no second database in the demo, and `shard_dsn` is null for
every seeded tenant.** I am flagging that rather than implying it is proven, since the
brief asks for no stub presented as working.

---

## 8. Known limitations

Stated honestly, per the brief.

- **RLS has a query-planning cost.** Policies become predicates on every query. With
  `tenant_id` leading every relevant index the plans stay index-only, but I have not
  benchmarked this at a scale where it would hurt. The numbers in the README are from
  a single-node dev machine and are labelled as such.
- **`current_setting` is per-transaction, so every read pays a transaction.** Measured
  at roughly 0.3 ms of overhead per request locally — real, and acceptable here.
- **Noisy-neighbour is unaddressed.** One tenant can consume a disproportionate share
  of the shared cluster. Per-tenant rate limiting exists at the API edge, but there is
  no query-level resource governance, and pool means there is no physical bulkhead.
  This is the main honest argument for silo at enterprise tier.
- **The `tenants` and `users` tables rely on application discipline**, not RLS (§4).
  They are read by primary key with ids from verified claims, but they are the part of
  the model where the database is not the backstop.
- **Backup/restore is all-or-nothing.** Restoring one tenant to a point in time means
  restoring the whole cluster and extracting rows. There is a runbook entry for it,
  but it is a manual procedure, not a tested automation.
- **A superuser connection bypasses everything.** RLS protects against application
  bugs, not against a compromised admin credential. RDS master credentials are held in
  Secrets Manager and are not used by the application.

---

## 9. Decision record

| | |
|---|---|
| **Decision** | Pool model (shared schema) with Postgres RLS as the enforcement boundary |
| **Date** | 2026-08-05 |
| **Alternatives** | Silo (rejected: cost, ~$50/tenant/month), Bridge (rejected: migration fan-out, catalog bloat, connection economics) |
| **Key risk accepted** | A single missing `WHERE` clause would leak data *if the application were the only guard* |
| **Mitigation** | The application is explicitly not the guard; the database is, via `FORCE` RLS + `NOBYPASSRLS` role + per-transaction `SET LOCAL` |
| **Reversible?** | Partially. Moving a tenant pool → silo is a data migration, not a code change (§7). Moving to bridge would be a rewrite. |
| **Proved by** | `apps/api/tests/isolation/`, run against real Postgres in CI |
