import client from 'prom-client';

/**
 * Prometheus instrumentation.
 *
 * Deliberate omission: **nothing here is labelled by tenant id.** Tenant id is unbounded
 * cardinality, and a label per tenant is the standard way to melt a Prometheus server.
 * Per-tenant numbers belong in logs (which carry `tenantId` on every line) and in the
 * database, not in metric labels. `plan` is used instead where a tenant breakdown is
 * genuinely needed — it has three values.
 */
export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry, prefix: 'saas_api_' });

/** Route label is the *template* ("/v1/projects/:id"), never the resolved path — again, cardinality. */
export const httpRequestDuration = new client.Histogram({
  name: 'saas_api_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'saas_api_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const dbQueryDuration = new client.Histogram({
  name: 'saas_api_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
  registers: [registry],
});

/** Time spent holding a pooled connection, i.e. the whole withTenant() transaction. */
export const dbTransactionDuration = new client.Histogram({
  name: 'saas_api_db_transaction_duration_seconds',
  help: 'Duration of a tenant-scoped transaction, including BEGIN/COMMIT',
  labelNames: ['outcome'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const dbPoolGauge = new client.Gauge({
  name: 'saas_api_db_pool_connections',
  help: 'Connections in the pg pool by state',
  labelNames: ['state'] as const,
  registers: [registry],
});

/**
 * Increments when a request is rejected because its tenant claim failed a check.
 * A non-zero rate here is either an attack or a bug, and is alerted on. See
 * observability/alerts/api.rules.yml.
 */
export const tenantScopeViolations = new client.Counter({
  name: 'saas_api_tenant_scope_violations_total',
  help: 'Requests rejected because the tenant claim did not authorise the target resource',
  labelNames: ['surface', 'reason'] as const,
  registers: [registry],
});

export const authEvents = new client.Counter({
  name: 'saas_api_auth_events_total',
  help: 'Authentication events',
  labelNames: ['event', 'outcome'] as const,
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: 'saas_api_cache_events_total',
  help: 'Redis cache hits and misses',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const graphqlOperationDuration = new client.Histogram({
  name: 'saas_api_graphql_operation_duration_seconds',
  help: 'GraphQL operation duration in seconds',
  labelNames: ['operation_type', 'operation_name', 'outcome'] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}
