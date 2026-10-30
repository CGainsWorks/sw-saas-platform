# API load test result

- Runner: GitHub-hosted runner, image ubuntu26 20261026.180.1, 4 vCPU (INTEL(R) XEON(R) PLATINUM 8573C), 15.6 GiB RAM
- Date (UTC): 2026-10-30T08:42:06.261Z
- Tool: grafana/k6:1.8.2@sha256:00fdcebafbc86cb0137d429529b1caa401a02e09025f02fc74866fa6e2b004d8, script loadtest/k6/api.js
- Target: API container from docker-compose.yml (NODE_ENV=production), Postgres 16.4 and Redis 7.4 containers on the same host
- Load: ramp to 20 virtual users over 10 s, hold 60s, ramp down 5 s; no think time
- Requests: 124921 (1665.4/s, including one readiness check in setup), failed 0.00%
- Checks: 124920 passed, 0 failed
- Thresholds (failed < 1%, checks > 99%, p95 < 1000 ms per endpoint): all met
- Source: `Load test` workflow run https://github.com/CGainsWorks/sw-saas-platform/actions/runs/41027991702 (summary.md artifact, copied unedited apart from this line)

Latency in milliseconds:

| Endpoint | avg | median | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| all requests | 10.7 | 11.7 | 15.6 | 16.8 | 20.6 | 50.0 |
| GET /v1/projects | 5.8 | 5.7 | 7.6 | 8.3 | 10.4 | 22.3 |
| GET /v1/tasks | 12.5 | 12.5 | 15.5 | 16.7 | 20.7 | 50.0 |
| POST /graphql | 13.8 | 13.8 | 16.9 | 18.2 | 23.2 | 40.4 |
