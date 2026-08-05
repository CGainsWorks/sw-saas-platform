import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, importPKCS8, importSPKI, type JWK, type KeyLike } from 'jose';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * RS256 signing keys for the access tokens this API issues.
 *
 * Asymmetric rather than HS256 on purpose: the public half can be published at
 * /.well-known/jwks.json so that other services (and, in a larger system, an API gateway
 * or service mesh) can verify tokens without being handed the ability to mint them.
 */

const cfg = loadConfig();

export interface KeyMaterial {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

let cached: KeyMaterial | null = null;

function decodeB64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

/**
 * Stable key id derived from the key material itself, so it changes exactly when the key
 * changes. A hand-maintained kid tends to drift from the key it names, which breaks
 * verification in a way that is tedious to diagnose.
 */
async function kidFor(jwk: JWK): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url')
    .slice(0, 16);
}

export async function getKeys(): Promise<KeyMaterial> {
  if (cached) return cached;

  let privatePem: string;
  let publicPem: string;

  if (cfg.JWT_PRIVATE_KEY_B64 && cfg.JWT_PUBLIC_KEY_B64) {
    privatePem = decodeB64(cfg.JWT_PRIVATE_KEY_B64);
    publicPem = decodeB64(cfg.JWT_PUBLIC_KEY_B64);
  } else {
    // Development only — loadConfig() refuses to start in production without a
    // configured pair, because an ephemeral key means every pod signs with a different
    // key and tokens stop verifying across replicas.
    if (cfg.isProduction) throw new Error('signing keys are required in production');
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privatePem = pair.privateKey;
    publicPem = pair.publicKey;
    logger.warn(
      'no JWT keypair configured; generated an ephemeral one. Tokens will not survive a restart.',
    );
  }

  const privateKey = await importPKCS8(privatePem, 'RS256');
  const publicKey = await importSPKI(publicPem, 'RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = await kidFor(publicJwk);

  cached = {
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' },
    kid,
  };
  return cached;
}

/** Body of the /.well-known/jwks.json response. Public material only. */
export async function jwks(): Promise<{ keys: JWK[] }> {
  const { publicJwk } = await getKeys();
  return { keys: [publicJwk] };
}

export function resetKeysForTests(): void {
  cached = null;
}
