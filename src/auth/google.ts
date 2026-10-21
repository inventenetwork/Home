import { createPublicKey, verify as rsaVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Verifies a Google "Sign in with Google" ID token using only Node's crypto (no extra dependency).
 * Checks: RS256 signature against Google's published keys, issuer, audience (our client id), expiry.
 * The browser is never trusted for the email: everything comes from the signed token.
 */

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

export class GoogleAuthError extends Error {
  constructor(
    public code: 'invalid_token' | 'keys_unavailable',
    message: string,
  ) {
    super(message);
  }
}

interface Jwk extends JsonWebKey {
  kid?: string;
}
export interface KeySet {
  keys: Jwk[];
  /** How long the keys may be cached, in milliseconds. */
  maxAgeMs: number;
}

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const LEEWAY_SECONDS = 60;

export async function fetchGoogleKeys(): Promise<KeySet> {
  let res: Response;
  try {
    res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new GoogleAuthError('keys_unavailable', 'Could not reach Google to fetch signing keys');
  }
  if (!res.ok) throw new GoogleAuthError('keys_unavailable', `Google keys request failed (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
  return { keys: body.keys ?? [], maxAgeMs: (maxAge ? Number(maxAge) : 3600) * 1000 };
}

function decodePart(part: string): Record<string, any> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  } catch {
    /* fall through */
  }
  throw new GoogleAuthError('invalid_token', 'Malformed token');
}

export function createGoogleVerifier(opts: {
  clientId: string;
  /** Injectable for tests. */
  fetchKeys?: () => Promise<KeySet>;
  now?: () => Date;
}): GoogleVerifier {
  const fetchKeys = opts.fetchKeys ?? fetchGoogleKeys;
  const now = opts.now ?? (() => new Date());
  let cache: { keys: Map<string, KeyObject>; expiresAt: number } | null = null;

  async function loadKeys(force: boolean): Promise<Map<string, KeyObject>> {
    if (!force && cache && cache.expiresAt > now().getTime()) return cache.keys;
    const set = await fetchKeys();
    const keys = new Map<string, KeyObject>();
    for (const jwk of set.keys) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    cache = { keys, expiresAt: now().getTime() + set.maxAgeMs };
    return keys;
  }

  return async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new GoogleAuthError('invalid_token', 'Malformed token');
    const [h, p, s] = parts as [string, string, string];

    const header = decodePart(h);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleAuthError('invalid_token', 'Unsupported token header');

    // Signature first, so nothing in an unsigned payload is acted on. If the key id is unknown, Google may have rotated: refetch once.
    let key = (await loadKeys(false)).get(header.kid);
    if (!key) key = (await loadKeys(true)).get(header.kid);
    if (!key) throw new GoogleAuthError('invalid_token', 'Unknown signing key');
    const ok = rsaVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw new GoogleAuthError('invalid_token', 'Bad signature');

    const c = decodePart(p);
    if (typeof c.iss !== 'string' || !ISSUERS.has(c.iss)) throw new GoogleAuthError('invalid_token', 'Wrong issuer');
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(opts.clientId)) throw new GoogleAuthError('invalid_token', 'Wrong audience');
    const nowSec = now().getTime() / 1000;
    if (typeof c.exp !== 'number' || c.exp + LEEWAY_SECONDS < nowSec) throw new GoogleAuthError('invalid_token', 'Token expired');
    if (typeof c.iat === 'number' && c.iat - LEEWAY_SECONDS > nowSec) throw new GoogleAuthError('invalid_token', 'Token issued in the future');
    if (typeof c.sub !== 'string' || !c.sub || typeof c.email !== 'string' || !c.email) {
      throw new GoogleAuthError('invalid_token', 'Missing claims');
    }

    return {
      sub: c.sub,
      email: c.email,
      emailVerified: c.email_verified === true || c.email_verified === 'true',
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 120) : null,
    };
  };
}
