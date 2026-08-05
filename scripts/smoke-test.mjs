#!/usr/bin/env node
/**
 * End-to-end smoke test against a running stack.
 *
 * Drives the actual OAuth2 authorization-code + PKCE flow the way a browser would —
 * following redirects, submitting the consent form, carrying the session cookies — and
 * then verifies the isolation boundary over the wire as two different real customers.
 *
 * This is the difference between "the unit tests pass" and "the thing works". It talks to
 * the deployed containers over HTTP and knows nothing about the source.
 *
 *   docker compose up -d --build
 *   node scripts/smoke-test.mjs
 *
 * Exits non-zero on the first failure.
 */

const API = process.env.API_URL ?? 'http://localhost:4000';
const IDP = process.env.IDP_URL ?? 'http://localhost:4010';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ${GREEN}pass${RESET}  ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
  } else {
    console.log(`  ${RED}FAIL${RESET}  ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
    failures += 1;
  }
}

/** Collects Set-Cookie headers into a single Cookie header value. */
function collectCookies(res, jar = new Map()) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return jar;
}

const cookieHeader = (jar) =>
  [...jar.entries()]
    .filter(([, v]) => v && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

/**
 * Performs a complete login as one of the dev IdP's demo users and returns its cookie jar.
 *
 * Every step is the real one: the API mints state and a PKCE verifier and redirects, the
 * IdP issues a signed ID token, the API verifies it against the IdP's JWKS and exchanges
 * the code with the verifier. Nothing is short-circuited.
 */
async function login(sub) {
  // 1. Start the flow. The API stores state + verifier + nonce server-side and redirects.
  const start = await fetch(`${API}/v1/auth/login?returnTo=${encodeURIComponent(WEB)}`, {
    redirect: 'manual',
  });
  if (start.status !== 302) throw new Error(`login did not redirect (got ${start.status})`);

  const authorizeUrl = start.headers.get('location');
  if (!authorizeUrl) throw new Error('login redirect had no Location header');

  // The browser is sent to the public issuer address; from the host that is reachable.
  const consentPage = await fetch(authorizeUrl);
  if (!consentPage.ok) throw new Error(`authorize page returned ${consentPage.status}`);
  const html = await consentPage.text();

  // 2. Find the form belonging to the requested demo user and replay its hidden fields.
  const form = html.split('<form').find((chunk) => chunk.includes(`value="${sub}"`));
  if (!form) throw new Error(`no consent form for ${sub}`);

  const field = (name) => {
    const m = new RegExp(`name="${name}"\\s+value="([^"]*)"`).exec(form);
    return m?.[1] ?? '';
  };

  const body = new URLSearchParams({
    sub,
    state: field('state'),
    nonce: field('nonce'),
    code_challenge: field('code_challenge'),
  });

  const consent = await fetch(`${IDP}/authorize/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  if (consent.status !== 302) throw new Error(`consent did not redirect (got ${consent.status})`);

  // 3. Follow the callback. The API exchanges the code with its PKCE verifier, verifies
  //    the ID token, resolves membership from the database and sets session cookies.
  const callbackUrl = consent.headers.get('location');
  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  if (callback.status !== 302) {
    throw new Error(`callback failed (${callback.status}): ${await callback.text()}`);
  }

  const jar = collectCookies(callback);
  if (!jar.has('saas_at')) throw new Error('callback set no access-token cookie');
  return jar;
}

const authed = (jar, init = {}) => ({
  ...init,
  headers: { 'content-type': 'application/json', cookie: cookieHeader(jar), ...(init.headers ?? {}) },
  redirect: 'manual',
});

async function main() {
  console.log(`\nSmoke-testing ${API}\n`);

  /* ------------------------------------------------------------- liveness */

  console.log('health');
  const health = await fetch(`${API}/healthz`);
  check('GET /healthz', health.ok, `${health.status}`);

  const ready = await fetch(`${API}/readyz`);
  const readyBody = await ready.json();
  check('GET /readyz', ready.ok, JSON.stringify(readyBody.checks));

  const metrics = await fetch(`${API}/metrics`);
  const metricsText = await metrics.text();
  check('GET /metrics exposes app metrics', metricsText.includes('saas_api_http_requests_total'));

  const web = await fetch(WEB);
  check('front end responds', web.ok, `${web.status}`);

  const discovery = await fetch(`${IDP}/.well-known/openid-configuration`);
  const disco = await discovery.json();
  check('IdP publishes OIDC discovery', typeof disco.jwks_uri === 'string');
  check('IdP requires PKCE S256', disco.code_challenge_methods_supported?.includes('S256'));

  const jwks = await fetch(`${API}/.well-known/jwks.json`);
  const jwksBody = await jwks.json();
  check('API publishes its own JWKS', Array.isArray(jwksBody.keys) && jwksBody.keys.length > 0);

  /* ------------------------------------------------------------ auth flow */

  console.log('\noauth2 authorization code + pkce');
  const alice = await login('dev-idp|alice');
  check('alice completed the full OAuth2 flow', alice.has('saas_at'));

  const aliceSession = await fetch(`${API}/v1/auth/session`, authed(alice)).then((r) => r.json());
  check('alice resolves to a tenant', Boolean(aliceSession.tenant?.id), aliceSession.tenant?.name);
  check('alice is an owner', aliceSession.role === 'owner');

  const carol = await login('dev-idp|carol');
  const carolSession = await fetch(`${API}/v1/auth/session`, authed(carol)).then((r) => r.json());
  check('carol resolves to a different tenant', carolSession.tenant?.id !== aliceSession.tenant?.id,
    carolSession.tenant?.name);

  const dave = await login('dev-idp|dave');
  const daveSession = await fetch(`${API}/v1/auth/session`, authed(dave)).then((r) => r.json());
  check('dave belongs to two tenants', daveSession.availableTenants?.length === 2,
    `${daveSession.availableTenants?.length} tenants`);

  /* ------------------------------------------------------------- the data */

  console.log('\ntenant-scoped reads');
  const aliceProjects = await fetch(`${API}/v1/projects`, authed(alice)).then((r) => r.json());
  const carolProjects = await fetch(`${API}/v1/projects`, authed(carol)).then((r) => r.json());

  check('alice sees her own projects', aliceProjects.items.length > 0,
    `${aliceProjects.items.length} projects`);
  check('carol sees her own projects', carolProjects.items.length > 0,
    `${carolProjects.items.length} projects`);

  const aliceIds = new Set(aliceProjects.items.map((p) => p.id));
  const carolIds = new Set(carolProjects.items.map((p) => p.id));
  const overlap = [...aliceIds].filter((id) => carolIds.has(id));
  check('their project sets do not overlap', overlap.length === 0);

  check(
    'both tenants have a project keyed OPS (keys are per-tenant, not global)',
    aliceProjects.items.some((p) => p.key === 'OPS') &&
      carolProjects.items.some((p) => p.key === 'OPS'),
  );

  /* -------------------------------------------------------- the attacks */

  console.log('\ncross-tenant attacks (all of these must fail)');
  const carolProjectId = carolProjects.items[0].id;

  const read = await fetch(`${API}/v1/projects/${carolProjectId}`, authed(alice));
  check('alice cannot read carol\'s project', read.status === 404, `got ${read.status}`);
  check('  ...and gets 404, not 403 (403 would confirm it exists)', read.status !== 403);

  const write = await fetch(
    `${API}/v1/projects/${carolProjectId}`,
    authed(alice, { method: 'PATCH', body: JSON.stringify({ name: 'pwned' }) }),
  );
  check('alice cannot modify carol\'s project', write.status === 404, `got ${write.status}`);

  const plant = await fetch(
    `${API}/v1/tasks`,
    authed(alice, {
      method: 'POST',
      body: JSON.stringify({ projectId: carolProjectId, title: 'planted' }),
    }),
  );
  check('alice cannot create a task in carol\'s project', plant.status === 404, `got ${plant.status}`);

  const spoofed = await fetch(
    `${API}/v1/projects`,
    authed(alice, { headers: { 'x-tenant-id': carolSession.tenant.id } }),
  ).then((r) => r.json());
  check(
    'an X-Tenant-Id header is ignored',
    spoofed.items.every((p) => p.tenantId === aliceSession.tenant.id),
  );

  const anon = await fetch(`${API}/v1/projects`);
  check('unauthenticated requests are rejected', anon.status === 401, `got ${anon.status}`);

  /* -------------------------------------------------------------- graphql */

  console.log('\ngraphql');
  const gqlOk = await fetch(
    `${API}/graphql`,
    authed(alice, {
      method: 'POST',
      body: JSON.stringify({ query: '{ projects { id key tasks { id title } } }' }),
    }),
  ).then((r) => r.json());
  check('graphql returns the caller\'s projects', Array.isArray(gqlOk.data?.projects));

  const gqlCross = await fetch(
    `${API}/graphql`,
    authed(alice, {
      method: 'POST',
      body: JSON.stringify({
        query: 'query($id: ID!) { project(id: $id) { id name } }',
        variables: { id: carolProjectId },
      }),
    }),
  ).then((r) => r.json());
  check('graphql returns null for a foreign project', gqlCross.data?.project === null);

  const deep = 'tasks { project { '.repeat(6) + 'id' + ' } }'.repeat(6);
  const gqlDeep = await fetch(
    `${API}/graphql`,
    authed(alice, {
      method: 'POST',
      body: JSON.stringify({ query: `{ projects { ${deep} } }` }),
    }),
  ).then((r) => r.json());
  check('graphql rejects an over-deep query', /exceeds the maximum/i.test(gqlDeep.errors?.[0]?.message ?? ''));

  /* -------------------------------------------------------- tenant switch */

  console.log('\ntenant switching');
  const target = daveSession.availableTenants.find((t) => t.id !== daveSession.tenant.id);
  const switched = await fetch(
    `${API}/v1/auth/switch-tenant`,
    authed(dave, { method: 'POST', body: JSON.stringify({ tenantId: target.id }) }),
  );
  check('dave can switch into his other tenant', switched.ok, `${switched.status}`);

  const daveAfter = collectCookies(switched, new Map(dave));
  const afterSession = await fetch(`${API}/v1/auth/session`, authed(daveAfter)).then((r) => r.json());
  check('dave is now scoped to the other tenant', afterSession.tenant.id === target.id,
    afterSession.tenant.name);

  const denied = await fetch(
    `${API}/v1/auth/switch-tenant`,
    authed(alice, { method: 'POST', body: JSON.stringify({ tenantId: carolSession.tenant.id }) }),
  );
  check('alice cannot switch into a tenant she does not belong to', denied.status === 401,
    `got ${denied.status}`);

  /* ------------------------------------------------------------- summary */

  console.log('');
  if (failures > 0) {
    console.log(`${RED}${failures} check(s) failed.${RESET}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}All checks passed against the running stack.${RESET}\n`);
}

main().catch((err) => {
  console.error(`\n${RED}Smoke test aborted:${RESET} ${err.message}\n`);
  process.exit(1);
});
