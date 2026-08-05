import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { SignJWT, exportJWK, importPKCS8, importSPKI } from 'jose';
import { DEMO_USERS, findUser } from './users.js';

/**
 * A small but genuine OpenID Connect provider: discovery, JWKS, authorization code flow
 * with PKCE (S256), and a token endpoint.
 *
 * WHY THIS EXISTS
 *
 * The brief asks for OAuth2, and for the whole thing to run from one command on a clean
 * machine. Those pull in opposite directions: a real flow needs a real provider, and
 * every off-the-shelf option is either a heavyweight JVM container that dominates the
 * demo's startup time and memory, or an external account the reader has to go and create.
 *
 * The alternative — stubbing auth in development — would mean the OAuth2 code path is
 * never actually executed until it hits production. So the provider is real instead: the
 * API performs a true authorization-code + PKCE exchange, fetches this server's JWKS over
 * HTTP, and verifies the ID token's signature, issuer, audience, expiry and nonce. The
 * only thing that is not real is the authentication ceremony itself — you pick a demo
 * user from a list instead of proving who you are.
 *
 * Pointing OIDC_* at Auth0, Google or Keycloak swaps this out with no code change on the
 * API side, which is the property that makes the shortcut acceptable.
 *
 * NOT FOR PRODUCTION. It authenticates nobody. Codes live in process memory, so a restart
 * drops in-flight logins and a second replica would not share them.
 */

const PORT = Number(process.env.PORT ?? 4010);
const ISSUER = (process.env.ISSUER ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const CLIENT_ID = process.env.CLIENT_ID ?? 'saas-web';
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? 'dev-client-secret';
const REDIRECT_URI = process.env.REDIRECT_URI ?? 'http://localhost:4000/v1/auth/callback';

const CODE_TTL_MS = 60_000;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// The consent form and the token endpoint both post application/x-www-form-urlencoded,
// which Fastify does not parse out of the box.
await app.register(formbody);

/* --------------------------------------------------------------------- keys */

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privateKey = await importPKCS8(pair.privateKey, 'RS256');
const publicKey = await importSPKI(pair.publicKey, 'RS256');
const publicJwk = await exportJWK(publicKey);
const KID = createHash('sha256').update(publicJwk.n ?? '').digest('base64url').slice(0, 16);

/* -------------------------------------------------------- authorization codes */

interface PendingCode {
  sub: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

const codes = new Map<string, PendingCode>();

setInterval(() => {
  const now = Date.now();
  for (const [code, rec] of codes) if (rec.expiresAt < now) codes.delete(code);
}, 30_000).unref();

function b64urlSha256(v: string): string {
  return createHash('sha256').update(v).digest('base64url');
}

/** Constant-time comparison, so a wrong secret cannot be recovered by timing the response. */
function secretMatches(supplied: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(CLIENT_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/* ---------------------------------------------------------------- endpoints */

app.get('/healthz', async () => ({ status: 'ok' }));

app.get('/.well-known/openid-configuration', async () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks.json`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'email', 'profile'],
  code_challenge_methods_supported: ['S256'],
  claims_supported: ['sub', 'email', 'email_verified', 'name', 'nonce', 'aud', 'iss', 'exp'],
}));

app.get('/jwks.json', async () => ({
  keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }],
}));

interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

app.get<{ Querystring: AuthorizeQuery }>('/authorize', async (req, reply) => {
  const q = req.query;

  if (q.response_type !== 'code') {
    return reply.status(400).send({ error: 'unsupported_response_type' });
  }
  if (q.client_id !== CLIENT_ID) {
    return reply.status(400).send({ error: 'unauthorized_client' });
  }
  // Exact match, not prefix. A prefix check is how open-redirect bugs get into OAuth
  // implementations — "https://app.example.com" would also match "https://app.example.com.evil.tld".
  if (q.redirect_uri !== REDIRECT_URI) {
    return reply.status(400).send({ error: 'invalid_request', detail: 'redirect_uri mismatch' });
  }
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
    return reply
      .status(400)
      .send({ error: 'invalid_request', detail: 'PKCE with S256 is required' });
  }

  const rows = DEMO_USERS.map(
    (u) => `
      <li>
        <form method="POST" action="/authorize/consent">
          <input type="hidden" name="sub" value="${escapeHtml(u.sub)}">
          <input type="hidden" name="state" value="${escapeHtml(q.state ?? '')}">
          <input type="hidden" name="nonce" value="${escapeHtml(q.nonce ?? '')}">
          <input type="hidden" name="code_challenge" value="${escapeHtml(q.code_challenge!)}">
          <button type="submit">
            <span class="name">${escapeHtml(u.name)}</span>
            <span class="email">${escapeHtml(u.email)}</span>
            <span class="hint">${escapeHtml(u.hint)}</span>
          </button>
        </form>
      </li>`,
  ).join('');

  return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — development identity provider</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin-bottom: .25rem; }
  .warn { background: #fff4e5; border: 1px solid #f0c98d; color: #6b4a12; padding: .75rem 1rem;
          border-radius: 6px; margin: 1rem 0 1.5rem; font-size: .875rem; }
  @media (prefers-color-scheme: dark) { .warn { background:#3a2c12; border-color:#7a5f28; color:#f0dcb4; } }
  ul { list-style: none; padding: 0; display: grid; gap: .5rem; }
  button { width: 100%; text-align: left; padding: .75rem 1rem; border-radius: 8px; cursor: pointer;
           border: 1px solid currentColor; background: transparent; color: inherit; font: inherit; }
  button:hover { background: rgba(127,127,127,.12); }
  .name { display: block; font-weight: 600; }
  .email { display: block; font-size: .8125rem; opacity: .75; }
  .hint { display: block; font-size: .8125rem; opacity: .6; margin-top: .25rem; }
  footer { margin-top: 2rem; font-size: .8125rem; opacity: .65; }
</style></head>
<body>
  <h1>Development identity provider</h1>
  <div class="warn">
    <strong>This provider authenticates nobody.</strong> It exists so the OAuth2
    authorization-code + PKCE flow runs end to end without an external account. Choosing a
    user below issues a genuinely signed ID token, which the API verifies against this
    server's JWKS. Do not deploy it.
  </div>
  <ul>${rows}</ul>
  <footer>Issuer <code>${escapeHtml(ISSUER)}</code> · client <code>${escapeHtml(CLIENT_ID)}</code></footer>
</body></html>`);
});

interface ConsentBody {
  sub?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
}

app.post<{ Body: ConsentBody }>('/authorize/consent', async (req, reply) => {
  const { sub, state, nonce, code_challenge } = req.body;

  if (!sub || !findUser(sub) || !code_challenge) {
    return reply.status(400).send({ error: 'invalid_request' });
  }

  const code = randomBytes(32).toString('base64url');
  codes.set(code, {
    sub,
    nonce: nonce ?? '',
    codeChallenge: code_challenge,
    redirectUri: REDIRECT_URI,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const target = new URL(REDIRECT_URI);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return reply.redirect(target.toString(), 302);
});

interface TokenBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
}

app.post<{ Body: TokenBody }>('/token', async (req, reply) => {
  const b = req.body ?? {};

  if (b.grant_type !== 'authorization_code') {
    return reply.status(400).send({ error: 'unsupported_grant_type' });
  }
  if (b.client_id !== CLIENT_ID || !b.client_secret || !secretMatches(b.client_secret)) {
    return reply.status(401).send({ error: 'invalid_client' });
  }
  if (!b.code || !b.code_verifier) {
    return reply.status(400).send({ error: 'invalid_request' });
  }

  const pending = codes.get(b.code);
  // Single use: deleted on first presentation, so a replayed or intercepted code is dead
  // even if the attacker also has the verifier.
  codes.delete(b.code);

  if (!pending || pending.expiresAt < Date.now()) {
    return reply.status(400).send({ error: 'invalid_grant', detail: 'code unknown or expired' });
  }
  if (pending.redirectUri !== b.redirect_uri) {
    return reply.status(400).send({ error: 'invalid_grant', detail: 'redirect_uri mismatch' });
  }
  // The PKCE check: proves the caller is the same party that began the flow.
  if (b64urlSha256(b.code_verifier) !== pending.codeChallenge) {
    return reply.status(400).send({ error: 'invalid_grant', detail: 'PKCE verification failed' });
  }

  const user = findUser(pending.sub);
  if (!user) return reply.status(400).send({ error: 'invalid_grant' });

  const idToken = await new SignJWT({
    email: user.email,
    email_verified: true,
    name: user.name,
    nonce: pending.nonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setSubject(user.sub)
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  return reply.send({
    token_type: 'Bearer',
    expires_in: 300,
    id_token: idToken,
    // This provider has no userinfo endpoint, so the access token is a placeholder. The
    // API only consumes the ID token.
    access_token: randomBytes(24).toString('base64url'),
    scope: 'openid email profile',
  });
});

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`dev identity provider listening on ${ISSUER}`);
