import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

describe('email OTP auth', () => {
  it('logs a new customer in and returns their profile', async () => {
    const { app, mailer } = await setup();
    const res = await login(app, mailer, 'Sam@Example.com');
    expect(res.status).toBe(201);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user).toMatchObject({ email: 'sam@example.com', role: 'customer' });
    expect(res.body.accessToken).toBeTruthy();

    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('sam@example.com');
  });

  it('treats the same email as the same account on the second login', async () => {
    const { app, mailer } = await setup();
    await login(app, mailer, 'sam@example.com');
    const again = await login(app, mailer, 'sam@example.com');
    expect(again.status).toBe(200);
    expect(again.body.isNewUser).toBe(false);
  });

  it('answers OTP requests identically for any email (no account enumeration)', async () => {
    const { app } = await setup();
    const a = await request(app).post('/auth/otp/request').send({ email: 'new@example.com' });
    const b = await request(app).post('/auth/otp/request').send({ email: 'other@example.com' });
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
  });

  it('rejects malformed emails and codes', async () => {
    const { app } = await setup();
    await request(app).post('/auth/otp/request').send({ email: 'nope' }).expect(400);
    await request(app).post('/auth/otp/verify').send({ email: 'a@b.com', code: '12' }).expect(400);
  });

  it('requires PDPA consent for new accounts without burning the code', async () => {
    const { app, mailer } = await setup();
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    const code = mailer.lastCodeFor('sam@example.com')!;

    const noConsent = await request(app).post('/auth/otp/verify').send({ email: 'sam@example.com', code });
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.error).toBe('consent_required');

    const withConsent = await request(app).post('/auth/otp/verify').send({ email: 'sam@example.com', code, consent: true });
    expect(withConsent.status).toBe(201);
  });

  it('codes are single-use', async () => {
    const { app, mailer } = await setup();
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    const code = mailer.lastCodeFor('sam@example.com')!;
    const body = { email: 'sam@example.com', code, consent: true };
    await request(app).post('/auth/otp/verify').send(body).expect(201);
    await request(app).post('/auth/otp/verify').send(body).expect(400);
  });

  it('a newer code invalidates the older one', async () => {
    const { app, mailer } = await setup();
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    const first = mailer.lastCodeFor('sam@example.com')!;
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    const second = mailer.lastCodeFor('sam@example.com')!;
    if (first !== second) {
      await request(app).post('/auth/otp/verify').send({ email: 'sam@example.com', code: first, consent: true }).expect(400);
    }
    await request(app).post('/auth/otp/verify').send({ email: 'sam@example.com', code: second, consent: true }).expect(201);
  });

  it('locks a code after too many wrong guesses, even if the right code is then used', async () => {
    const { app, mailer } = await setup(); // OTP_MAX_ATTEMPTS = 3 in test config
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    const code = mailer.lastCodeFor('sam@example.com')!;
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 3; i++) {
      await request(app).post('/auth/otp/verify').send({ email: 'sam@example.com', code: wrong, consent: true }).expect(400);
    }
    const locked = await request(app).post('/auth/otp/verify').send({ email: 'sam@example.com', code, consent: true });
    expect(locked.status).toBe(429);
  });

  it('enforces the resend cooldown', async () => {
    const { app } = await setup({ OTP_RESEND_COOLDOWN_SECONDS: '60' });
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(429);
  });

  it('caps how many codes can be requested per hour', async () => {
    const { app } = await setup({ OTP_MAX_PER_HOUR: '2' });
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(429);
  });

  it('does not store the code in plain text', async () => {
    const { app, mailer, db } = await setup();
    await request(app).post('/auth/otp/request').send({ email: 'sam@example.com' }).expect(200);
    const code = mailer.lastCodeFor('sam@example.com')!;
    const { rows } = await db.query<{ code_hash: string }>('SELECT code_hash FROM otp_codes');
    expect(rows[0]!.code_hash).not.toContain(code);
    expect(rows[0]!.code_hash).toHaveLength(64);
  });
});

describe('roles', () => {
  it('provider signup creates a pending provider profile', async () => {
    const { app, mailer, db } = await setup();
    const res = await login(app, mailer, 'cleaner@example.com', { role: 'provider' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('provider');
    const p = await db.query<{ vetting_status: string }>(
      'SELECT vetting_status FROM providers WHERE user_id = $1',
      [res.body.user.id],
    );
    expect(p.rows[0]?.vetting_status).toBe('pending');
  });

  it('nobody can sign themselves up as admin', async () => {
    const { app, mailer } = await setup();
    await request(app).post('/auth/otp/request').send({ email: 'evil@example.com' }).expect(200);
    const code = mailer.lastCodeFor('evil@example.com')!;
    await request(app)
      .post('/auth/otp/verify')
      .send({ email: 'evil@example.com', code, consent: true, role: 'admin' })
      .expect(400);
  });

  it('guards admin routes by role', async () => {
    const { app, mailer, db } = await setup();

    await request(app).get('/admin/ping').expect(401);

    const customer = await login(app, mailer, 'sam@example.com');
    await request(app).get('/admin/ping').set('Authorization', `Bearer ${customer.body.accessToken}`).expect(403);

    await db.query("INSERT INTO users (email, role, consent_at) VALUES ('boss@example.com','admin', now())");
    const admin = await login(app, mailer, 'boss@example.com');
    expect(admin.status).toBe(200);
    await request(app).get('/admin/ping').set('Authorization', `Bearer ${admin.body.accessToken}`).expect(200);
  });

  it('rejects forged or garbage tokens', async () => {
    const { app } = await setup();
    await request(app).get('/auth/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
    await request(app).get('/auth/me').set('Authorization', 'Basic abc').expect(401);
  });

  it('suspending an account blocks existing tokens and new logins', async () => {
    const { app, mailer, db } = await setup();
    const res = await login(app, mailer, 'sam@example.com');
    await db.query("UPDATE users SET status = 'suspended' WHERE email = 'sam@example.com'");

    await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(401);
    const again = await login(app, mailer, 'sam@example.com');
    expect(again.status).toBe(403);
  });
});

describe('refresh tokens', () => {
  it('rotates, and the old token stops working', async () => {
    const { app, mailer } = await setup();
    const first = await login(app, mailer, 'sam@example.com');
    const rotated = await request(app).post('/auth/refresh').send({ refreshToken: first.body.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first.body.refreshToken);

    await request(app).post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
  });

  it('reusing an old refresh token revokes the whole session family', async () => {
    const { app, mailer } = await setup();
    const first = await login(app, mailer, 'sam@example.com');
    const rotated = await request(app).post('/auth/refresh').send({ refreshToken: first.body.refreshToken });

    // Attacker replays the stolen, already-used token...
    await request(app).post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
    // ...so even the legitimate newest token is now dead.
    await request(app).post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const { app, mailer } = await setup();
    const res = await login(app, mailer, 'sam@example.com');
    await request(app).post('/auth/logout').send({ refreshToken: res.body.refreshToken }).expect(200);
    await request(app).post('/auth/refresh').send({ refreshToken: res.body.refreshToken }).expect(401);
  });
});
