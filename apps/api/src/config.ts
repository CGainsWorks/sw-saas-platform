import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Load a repo-root .env when running outside a container, using Node's built-in loader
 * (no dotenv dependency). Containers get their environment from compose or Kubernetes,
 * where no .env exists and this is a no-op.
 *
 * Real environment variables always win: `loadEnvFile` does not overwrite existing keys,
 * so `DATABASE_URL=... npm run migrate` still overrides the file.
 */
function loadDotEnvIfPresent(): void {
  if (process.env.SKIP_DOTENV === '1') return;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Malformed .env is not worth crashing over; validation below reports what is missing.
      }
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Environment configuration, validated once at boot.
 *
 * The process refuses to start on invalid config rather than failing later on the first
 * request that happens to touch a missing value. In a Kubernetes rollout that turns a
 * bad ConfigMap into a failed readiness probe and an automatic rollback, instead of a
 * half-working pod serving 500s.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Connection string for the least-privilege application role (`app_user`). */
  DATABASE_URL: z.string().min(1),
  /** Owner/superuser connection, used only by migrations and seeding. Never by request paths. */
  DATABASE_ADMIN_URL: z.string().min(1).optional(),
  PGPOOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  PGPOOL_IDLE_TIMEOUT_MS: z.coerce.number().int().default(30_000),
  PGPOOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().default(5_000),
  /** Kills runaway queries so one tenant cannot pin a connection indefinitely. */
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(10_000),

  REDIS_URL: z.string().min(1),

  /* ------------------------------------------------------------------ auth */

  JWT_ISSUER: z.string().default('https://api.saas.local'),
  JWT_AUDIENCE: z.string().default('saas-api'),
  /**
   * RS256 keypair in PEM, base64-encoded so it survives a single-line env var.
   * If absent in development a throwaway pair is generated at boot — see keys.ts.
   * Absent in production is a hard failure.
   */
  JWT_PRIVATE_KEY_B64: z.string().optional(),
  JWT_PUBLIC_KEY_B64: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).default(60 * 60 * 24 * 14),

  /** OIDC provider. Points at the in-repo dev IdP by default; set to Auth0/Google/Keycloak in prod. */
  OIDC_ISSUER: z.string().default('http://localhost:4010'),
  /**
   * Address the API uses to reach the provider server-to-server, when it differs from the
   * public issuer. Under docker-compose the browser is redirected to `localhost:4010`
   * while the API must call `dev-idp:4010` — same provider, different network vantage
   * point. Discovery and JWKS are fetched from here; the `iss` claim is still validated
   * against OIDC_ISSUER, so this does not weaken verification.
   */
  OIDC_INTERNAL_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().default('saas-web'),
  OIDC_CLIENT_SECRET: z.string().default('dev-client-secret'),
  OIDC_REDIRECT_URI: z.string().default('http://localhost:4000/v1/auth/callback'),

  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  /* ------------------------------------------------------------- rate limit */

  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),

  /* ---------------------------------------------------------------- graphql */

  GRAPHQL_MAX_DEPTH: z.coerce.number().int().default(10),
  GRAPHQL_INTROSPECTION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof EnvSchema> & { isProduction: boolean; isTest: boolean };

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  if (env === process.env) loadDotEnvIfPresent();

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const cfg = parsed.data;
  const isProduction = cfg.NODE_ENV === 'production';

  // Failing loudly here is the point: a production deployment that silently generates
  // an ephemeral signing key would invalidate every token on each pod restart, and
  // would issue tokens that other replicas cannot verify.
  if (isProduction && (!cfg.JWT_PRIVATE_KEY_B64 || !cfg.JWT_PUBLIC_KEY_B64)) {
    throw new Error(
      'JWT_PRIVATE_KEY_B64 and JWT_PUBLIC_KEY_B64 are required when NODE_ENV=production',
    );
  }
  if (isProduction && cfg.OIDC_CLIENT_SECRET === 'dev-client-secret') {
    throw new Error('OIDC_CLIENT_SECRET is still the development default');
  }

  cached = { ...cfg, isProduction, isTest: cfg.NODE_ENV === 'test' };
  return cached;
}

/** Test-only. Clears the memoised config so a suite can vary the environment. */
export function resetConfigForTests(): void {
  cached = null;
}
