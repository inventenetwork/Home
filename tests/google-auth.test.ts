import request from 'supertest';
import { LEGAL_VERSION } from '../src/legal.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { GoogleAuthError, type GoogleIdentity } from '../src/auth/google.js';
import { login, setup } from './helpers.js';

// The real signature checks are covered in google.test.ts. Here Google is faked: the "token" is just a key into this table.
const people: Record<string, GoogleIdentity> = {
  ada: { sub: 'g-ada', email: 'Ada@Example.com', emailVerified: true, name: 'Ada Lovelace' },
  ada2: { sub: 'g-ada', email: 'ada.new@example.com', emailVerified: true, name: 'Ada L.' }, // same account, email changed at Google
  bob: { sub: 'g-bob', email: 'bob@example.com', emailVerified: true, name: 'Bob' },
  unverified: { sub: 'g-evil', email: 'victim@example.com', emailVerified: false, name: null },
};
const fake = async (idToken: string): Promise<GoogleIdentity> => {
  if (idToken === 'x'.repeat(30)) throw new GoogleAuthError('keys_unavailable', 'down');
  const who = people[idToken.replace(/-.*/, '')];
  if (!who) throw new GoogleAuthError('invalid_token', 'bad');
  return who;
};
const tok = (name: string) => `${name}-${'0'.repeat(30)}`; // long enough for the body schema

describe('POST /auth/google', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup({}, { googleVerifier: fake });
  });
  const post = (body: object) => request(ctx.app).post('/auth/google').send(body);

  it('creates an account on first sign-in when consent is given, and stores the Google name', async () => {
    const res = await post({ idToken: tok('ada'), consent: true });
    expect(res.status).toBe(201);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user).toMatchObject({ email: 'ada@example.com', role: 'customer', fullName: 'Ada Lovelace' });
    expect(res.body.accessToken).toBeTruthy();
    const me = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.body.email).toBe('ada@example.com');
  });

  it('refuses to create an account without consent, and creates nothing', async () => {
    const res = await post({ idToken: tok('ada') });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('consent_required');
    const n = await ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM users WHERE email = 'ada@example.com'");
    expect(n.rows[0]!.n).toBe('0');
  });

  it('logs the same person in again (200) and keeps them on the same user even if their Google email changed', async () => {
    const first = await post({ idToken: tok('ada'), consent: true });
    const again = await post({ idToken: tok('ada2') });
    expect(again.status).toBe(200);
    expect(again.body.isNewUser).toBe(false);
    expect(again.body.user.id).toBe(first.body.user.id);
  });

  it('links to an existing email-code account instead of creating a duplicate', async () => {
    const viaOtp = await login(ctx.app, ctx.mailer, 'bob@example.com');
    const viaGoogle = await post({ idToken: tok('bob') }); // no consent needed: the account already exists
    expect(viaGoogle.status).toBe(200);
    expect(viaGoogle.body.user.id).toBe(viaOtp.body.user.id);
    const n = await ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM users WHERE email = 'bob@example.com'");
    expect(n.rows[0]!.n).toBe('1');
    // and email codes still work afterwards
    expect((await login(ctx.app, ctx.mailer, 'bob@example.com')).status).toBe(200);
  });

  it('never links or signs in when Google has not verified the email', async () => {
    await login(ctx.app, ctx.mailer, 'victim@example.com');
    const res = await post({ idToken: tok('unverified'), consent: true });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('email_not_verified');
    const n = await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM user_identities');
    expect(n.rows[0]!.n).toBe('0');
  });

  it('rejects an invalid token (401) and reports Google being unreachable (502)', async () => {
    expect((await post({ idToken: tok('nobody'), consent: true })).status).toBe(401);
    expect((await post({ idToken: 'x'.repeat(30), consent: true })).status).toBe(502);
    expect((await post({ consent: true })).status).toBe(400);
  });

  it('cannot be used to become an admin', async () => {
    const res = await post({ idToken: tok('bob'), consent: true, role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('can sign up a provider, who gets a provider record', async () => {
    const res = await post({ idToken: tok('bob'), consent: true, role: 'provider' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('provider');
    const p = await ctx.db.query('SELECT 1 FROM providers WHERE user_id = $1', [res.body.user.id]);
    expect(p.rowCount).toBe(1);
  });

  it('blocks suspended accounts', async () => {
    const first = await post({ idToken: tok('ada'), consent: true });
    await ctx.db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [first.body.user.id]);
    const res = await post({ idToken: tok('ada') });
    expect(res.status).toBe(403);
  });

  it('answers 503 when Google sign-in is not configured', async () => {
    const plain = await setup();
    const res = await request(plain.app).post('/auth/google').send({ idToken: tok('ada'), consent: true });
    expect(res.status).toBe(503);
  });
});

describe('GET /config', () => {
  it('exposes only public settings', async () => {
    const { app } = await setup({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com' }, { googleVerifier: fake });
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      googleClientId: 'abc.apps.googleusercontent.com',
      pendingExpiryMinutes: 30,
      maxAdvanceDays: 60,
      minLeadHours: 24,
      freeCancelHours: 12,
      paymentGateway: 'fake',
      demo: null,
      legal: { company: 'Home360 (company name to be added)', email: 'support@example.com', version: LEGAL_VERSION },
    });
  });

  it('hides the client id when Google sign-in is not available', async () => {
    const { app } = await setup({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com' }, { googleVerifier: undefined });
    // a client id alone builds the real verifier, so it is shown
    expect((await request(app).get('/config')).body.googleClientId).toBe('abc.apps.googleusercontent.com');
    const none = await setup();
    expect((await request(none.app).get('/config')).body.googleClientId).toBeNull();
  });
});
