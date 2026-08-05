import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { globalKey, redis } from '../cache/redis.js';

const cfg = loadConfig();

/**
 * OAuth2 / OpenID Connect relying-party implementation: authorization code flow with
 * PKCE.
 *
 * Authorization code + PKCE rather than implicit or password grant. The implicit flow
 * returns tokens in the URL fragment, where they land in browser history, `Referer`
 * headers and server logs; it is deprecated for good reason. The password grant requires
 * the application to handle the user's actual credentials, which is the thing federated
 * identity exists to avoid.
 *
 * PKCE was originally for public clients that cannot keep a secret, but it is now
 * recommended for confidential clients too: it binds the authorization code to the
 * specific request that started the flow, so an intercepted code is useless without the
 * verifier, which never leaves this server.
 *
 * The provider is configured entirely by environment. The default points at the in-repo
 * dev IdP so the flow runs offline; pointing OIDC_* at Auth0, Google or Keycloak needs no
 * code change.
 */

/** Fields of the discovery document this client actually uses. */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const STATE_NS = 'oauth_state';
const STATE_TTL_SECONDS = 600;

/** Address used for server-to-server calls; may differ from the public issuer. */
function internalBase(): string {
  return (cfg.OIDC_INTERNAL_ISSUER ?? cfg.OIDC_ISSUER).replace(/\/$/, '');
}

let discoveryCache: { value: Discovery; fetchedAt: number } | null = null;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export async function discover(): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.value;
  }

  const url = `${internalBase()}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} from ${url}`);

  const doc = (await res.json()) as Discovery;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[field] !== 'string') {
      throw new Error(`OIDC discovery document is missing "${field}"`);
    }
  }

  discoveryCache = { value: doc, fetchedAt: Date.now() };
  return doc;
}

/**
 * JWKS with caching and rate limiting handled by jose. Built against the internal base so
 * it is reachable from inside the cluster; the `iss` claim is still checked against the
 * public issuer during verification.
 */
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
async function providerJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (jwksCache) return jwksCache;
  const doc = await discover();
  const uri = new URL(doc.jwks_uri);
  // Rewrite the host to the internally reachable one; the provider advertises its public
  // address, which the API container may not be able to resolve.
  const internal = new URL(internalBase());
  uri.protocol = internal.protocol;
  uri.host = internal.host;
  jwksCache = createRemoteJWKSet(uri, { cacheMaxAge: 10 * 60 * 1000 });
  return jwksCache;
}

function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export interface AuthorizationRequest {
  url: string;
  state: string;
}

interface StoredState {
  codeVerifier: string;
  nonce: string;
  /** Where to send the browser once the exchange succeeds. Validated against WEB_ORIGIN. */
  returnTo: string;
  createdAt: number;
}

/**
 * Builds the authorize URL and stashes the PKCE verifier and nonce server-side.
 *
 * `state` is the lookup key and doubles as CSRF protection; it is deleted on first use
 * (see `consumeState`), so a replayed callback finds nothing.
 */
export async function beginAuthorization(returnTo: string): Promise<AuthorizationRequest> {
  const doc = await discover();

  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(64).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');

  const stored: StoredState = { codeVerifier, nonce, returnTo, createdAt: Date.now() };
  await redis.set(
    globalKey(STATE_NS, state),
    JSON.stringify(stored),
    'EX',
    STATE_TTL_SECONDS,
  );

  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.OIDC_CLIENT_ID);
  url.searchParams.set('redirect_uri', cfg.OIDC_REDIRECT_URI);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', base64UrlSha256(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state };
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

/** Single-use retrieval: GETDEL means a replayed callback cannot find its state. */
async function consumeState(state: string): Promise<StoredState> {
  if (typeof state !== 'string' || state.length < 16) {
    throw new OidcError('missing or malformed state', 'bad_state');
  }
  const raw = await redis.getdel(globalKey(STATE_NS, state));
  if (!raw) throw new OidcError('state is unknown, expired, or already used', 'unknown_state');
  return JSON.parse(raw) as StoredState;
}

export interface OidcIdentity {
  /** Provider's subject id. Stable per user per provider. */
  providerSub: string;
  email: string;
  name: string;
  returnTo: string;
}

/**
 * Completes the flow: exchanges the code (with the PKCE verifier) and verifies the ID
 * token.
 *
 * Verification is the security-critical half and is done properly: signature against the
 * provider's JWKS, `iss` equal to the configured issuer, `aud` equal to our client id,
 * expiry, and the `nonce` matching the one minted at the start of this specific flow.
 * Skipping the nonce check would leave the flow open to token replay across sessions.
 */
export async function completeAuthorization(params: {
  code: string;
  state: string;
}): Promise<OidcIdentity> {
  const stored = await consumeState(params.state);
  const doc = await discover();

  const tokenUrl = new URL(doc.token_endpoint);
  const internal = new URL(internalBase());
  tokenUrl.protocol = internal.protocol;
  tokenUrl.host = internal.host;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: cfg.OIDC_REDIRECT_URI,
    client_id: cfg.OIDC_CLIENT_ID,
    client_secret: cfg.OIDC_CLIENT_SECRET,
    code_verifier: stored.codeVerifier,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn({ status: res.status, detail: detail.slice(0, 500) }, 'token exchange failed');
    throw new OidcError('authorization code exchange failed', 'exchange_failed');
  }

  const tokens = (await res.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new OidcError('provider returned no id_token', 'no_id_token');

  const jwkSet = await providerJwks();
  let payload;
  try {
    const verified = await jwtVerify(tokens.id_token, jwkSet, {
      issuer: cfg.OIDC_ISSUER,
      audience: cfg.OIDC_CLIENT_ID,
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    payload = verified.payload as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      nonce?: string;
    };
  } catch (err) {
    logger.warn({ err }, 'id_token verification failed');
    throw new OidcError('id_token failed verification', 'bad_id_token');
  }

  // Binds this ID token to the authorize request that started the flow.
  if (payload.nonce !== stored.nonce) {
    throw new OidcError('id_token nonce does not match this authorization request', 'bad_nonce');
  }

  if (!payload.sub) throw new OidcError('id_token has no sub', 'no_sub');
  if (!payload.email) throw new OidcError('id_token has no email', 'no_email');

  // Email is what tenant membership is keyed on, so an unverified one would let anyone
  // who can register an account at the provider claim someone else's address.
  if (payload.email_verified === false) {
    throw new OidcError('provider reports the email address as unverified', 'email_unverified');
  }

  return {
    providerSub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email.split('@')[0] ?? 'user',
    returnTo: stored.returnTo,
  };
}

/** Only same-origin redirects are honoured, so `returnTo` cannot be turned into an open redirect. */
export function safeReturnTo(candidate: string | undefined): string {
  const base = cfg.WEB_ORIGIN.replace(/\/$/, '');
  if (!candidate) return base;
  try {
    const url = new URL(candidate, base);
    if (url.origin !== new URL(base).origin) return base;
    return url.toString();
  } catch {
    return base;
  }
}

export function newRequestNonce(): string {
  return randomUUID();
}
