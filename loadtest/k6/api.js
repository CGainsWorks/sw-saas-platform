// Basic load test for the API: REST and GraphQL reads as one authenticated tenant.
//
// Run through loadtest/run.sh, which starts the stack, mints a token and runs this in the
// pinned grafana/k6 image. Each iteration is what a dashboard page load costs the API:
//
//   GET  /v1/projects                         (cached per tenant in Redis after the first call)
//   GET  /v1/tasks                            (database read under RLS, uncached)
//   POST /graphql  projects { tasks { ... } } (nested resolvers through DataLoader)
//
// handleSummary writes a short Markdown summary and the raw k6 summary JSON. The
// Markdown is labelled with RUNNER_LABEL so a result is never separated from the machine
// that produced it.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.API_BASE_URL || 'http://api:4000';
const TOKEN = __ENV.TOKEN;
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '60s';

const ENDPOINTS = ['GET /v1/projects', 'GET /v1/tasks', 'POST /graphql'];

export const options = {
  scenarios: {
    dashboard: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  // Pass/fail criteria, not results. Per-endpoint thresholds also make k6 keep a
  // per-endpoint latency breakdown, which the summary below reports.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    ...Object.fromEntries(ENDPOINTS.map((n) => [`http_req_duration{name:${n}}`, ['p(95)<1000']])),
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const GQL = JSON.stringify({ query: '{ projects { id name tasks { id title status } } }' });

export function setup() {
  if (!TOKEN) throw new Error('TOKEN is not set; run loadtest/run.sh');
  const res = http.get(`${BASE}/readyz`);
  if (res.status !== 200) throw new Error(`API not ready: ${res.status} ${res.body}`);
}

export default function () {
  const headers = { authorization: `Bearer ${TOKEN}` };

  const projects = http.get(`${BASE}/v1/projects`, { headers, tags: { name: 'GET /v1/projects' } });
  check(projects, { 'projects 200': (r) => r.status === 200 });

  const tasks = http.get(`${BASE}/v1/tasks`, { headers, tags: { name: 'GET /v1/tasks' } });
  check(tasks, { 'tasks 200': (r) => r.status === 200 });

  const gql = http.post(`${BASE}/graphql`, GQL, {
    headers: { ...headers, 'content-type': 'application/json' },
    tags: { name: 'POST /graphql' },
  });
  check(gql, {
    'graphql 200 without errors': (r) => r.status === 200 && !r.json('errors'),
  });
}

function ms(v) {
  return v === undefined ? 'n/a' : v.toFixed(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const reqs = m.http_reqs.values;
  const failed = m.http_req_failed.values.rate;
  const checks = m.checks.values;
  const rows = [['all requests', m.http_req_duration.values]].concat(
    ENDPOINTS.map((n) => [n, (m[`http_req_duration{name:${n}}`] || {}).values || {}]),
  );
  const thresholdsOk = Object.values(m).every(
    (metric) => !metric.thresholds || Object.values(metric.thresholds).every((t) => t.ok),
  );

  const md = [
    '# API load test result',
    '',
    `- Runner: ${__ENV.RUNNER_LABEL || 'unlabelled'}`,
    `- Date (UTC): ${new Date().toISOString()}`,
    `- Tool: ${__ENV.K6_IMAGE || 'k6'}, script loadtest/k6/api.js`,
    `- Target: ${__ENV.TARGET_LABEL || BASE}`,
    `- Load: ramp to ${VUS} virtual users over 10 s, hold ${DURATION}, ramp down 5 s; no think time`,
    `- Requests: ${reqs.count} (${reqs.rate.toFixed(1)}/s, including one readiness check in setup), failed ${(failed * 100).toFixed(2)}%`,
    `- Checks: ${checks.passes} passed, ${checks.fails} failed`,
    `- Thresholds (failed < 1%, checks > 99%, p95 < 1000 ms per endpoint): ${thresholdsOk ? 'all met' : 'NOT met'}`,
    '',
    'Latency in milliseconds:',
    '',
    '| Endpoint | avg | median | p90 | p95 | p99 | max |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(
      ([n, v]) =>
        `| ${n} | ${ms(v.avg)} | ${ms(v.med)} | ${ms(v['p(90)'])} | ${ms(v['p(95)'])} | ${ms(v['p(99)'])} | ${ms(v.max)} |`,
    ),
    '',
  ].join('\n');

  return {
    stdout: `${md}\n`,
    [`${__ENV.OUT_DIR || '.'}/summary.md`]: md,
    [`${__ENV.OUT_DIR || '.'}/summary.json`]: JSON.stringify(data, null, 2),
  };
}
