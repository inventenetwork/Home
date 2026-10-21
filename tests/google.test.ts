import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoogleVerifier, GoogleAuthError, type KeySet } from '../src/auth/google.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const NOW = new Date('2026-10-21T01:00:00Z');
const nowSec = NOW.getTime() / 1000;

function makeKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const h = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const p = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: 'Ada@Example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    iat: nowSec - 10,
    exp: nowSec + 3000,
    ...claims,
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function verifierWith(sets: KeySet[]) {
  let calls = 0;
  const verify = createGoogleVerifier({
    clientId: CLIENT_ID,
    now: () => NOW,
    fetchKeys: async () => sets[Math.min(calls++, sets.length - 1)]!,
  });
  return { verify, fetches: () => calls };
}

async function code(p: Promise<unknown>) {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof GoogleAuthError ? e.code : 'other';
  }
}

describe('Google ID token verification', () => {
  const k1 = makeKey('k1');
  const keys: KeySet = { keys: [k1.jwk], maxAgeMs: 3600_000 };

  it('accepts a valid token and returns the verified claims', async () => {
    const { verify } = verifierWith([keys]);
    expect(await verify(token(k1))).toEqual({ sub: '1234567890', email: 'Ada@Example.com', emailVerified: true, name: 'Ada Lovelace' });
  });

  it('treats email_verified "true" (string) as verified and anything else as not', async () => {
    const { verify } = verifierWith([keys]);
    expect((await verify(token(k1, { email_verified: 'true' }))).emailVerified).toBe(true);
    expect((await verify(token(k1, { email_verified: false }))).emailVerified).toBe(false);
    expect((await verify(token(k1, { email_verified: undefined }))).emailVerified).toBe(false);
  });

  it('caches Google keys between calls', async () => {
    const { verify, fetches } = verifierWith([keys]);
    await verify(token(k1));
    await verify(token(k1));
    expect(fetches()).toBe(1);
  });

  it('rejects a wrong audience, wrong issuer and expired token', async () => {
    const { verify } = verifierWith([keys]);
    expect(await code(verify(token(k1, { aud: 'someone-else' })))).toBe('invalid_token');
    expect(await code(verify(token(k1, { iss: 'https://evil.example.com' })))).toBe('invalid_token');
    expect(await code(verify(token(k1, { exp: nowSec - 120 })))).toBe('invalid_token');
    expect(await code(verify(token(k1, { iat: nowSec + 600 })))).toBe('invalid_token');
  });

  it('allows the older-style issuer without https', async () => {
    const { verify } = verifierWith([keys]);
    expect(await code(verify(token(k1, { iss: 'accounts.google.com' })))).toBe('ok');
  });

  it('rejects a token signed with a different key, even if it claims a known kid', async () => {
    const attacker = makeKey('k1');
    const { verify } = verifierWith([keys]);
    expect(await code(verify(token(attacker)))).toBe('invalid_token');
  });

  it('rejects a tampered payload', async () => {
    const { verify } = verifierWith([keys]);
    const [h, , s] = token(k1).split('.');
    const forged = `${h}.${b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'admin@example.com', email_verified: true, exp: nowSec + 3000 })}.${s}`;
    expect(await code(verify(forged))).toBe('invalid_token');
  });

  it('rejects alg none / HS256 and malformed tokens', async () => {
    const { verify } = verifierWith([keys]);
    expect(await code(verify(token(k1, {}, { alg: 'none' })))).toBe('invalid_token');
    expect(await code(verify(token(k1, {}, { alg: 'HS256' })))).toBe('invalid_token');
    expect(await code(verify('not-a-token'))).toBe('invalid_token');
    expect(await code(verify('a.b.'))).toBe('invalid_token');
    expect(await code(verify('....'))).toBe('invalid_token');
  });

  it('refetches once when the key id is new (key rotation), then accepts', async () => {
    const k2 = makeKey('k2');
    const { verify, fetches } = verifierWith([keys, { keys: [k1.jwk, k2.jwk], maxAgeMs: 3600_000 }]);
    await verify(token(k1));
    expect(await code(verify(token(k2)))).toBe('ok');
    expect(fetches()).toBe(2);
  });

  it('refetches once for an unknown key id and then gives up', async () => {
    const stranger = makeKey('nope');
    const { verify, fetches } = verifierWith([keys]);
    expect(await code(verify(token(stranger)))).toBe('invalid_token');
    expect(fetches()).toBe(2);
  });

  it('reports when Google cannot be reached, which is not the same as a bad token', async () => {
    const verify = createGoogleVerifier({
      clientId: CLIENT_ID,
      now: () => NOW,
      fetchKeys: async () => {
        throw new GoogleAuthError('keys_unavailable', 'down');
      },
    });
    expect(await code(verify(token(k1)))).toBe('keys_unavailable');
  });
});
