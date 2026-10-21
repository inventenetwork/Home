import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setup } from './helpers.js';

describe('DEMO_MODE username/password login', () => {
  it('does not exist unless DEMO_MODE is on', async () => {
    const { app } = await setup();
    await request(app).post('/auth/demo-login').send({ username: 'admin', password: 'demo1234' }).expect(404);
    const cfg = await request(app).get('/config').expect(200);
    expect(cfg.body.demo).toBeNull();
  });

  it('logs the three demo accounts in with the shared password', async () => {
    const { app } = await setup({ DEMO_MODE: 'true', DEMO_PASSWORD: 'letmein-demo' });
    const cfg = await request(app).get('/config').expect(200);
    expect(cfg.body.demo.accounts.map((a: { username: string }) => a.username)).toEqual(['admin', 'vendor', 'user']);

    for (const [username, role] of [['admin', 'admin'], ['vendor', 'provider'], ['user', 'customer']] as const) {
      const r = await request(app).post('/auth/demo-login').send({ username: ` ${username.toUpperCase()} `, password: 'letmein-demo' }).expect(200);
      expect(r.body.user.role).toBe(role);
      const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${r.body.accessToken}`).expect(200);
      expect(me.body.role ?? me.body.user?.role).toBe(role);
    }
    // logging in again reuses the same accounts
    const again = await request(app).post('/auth/demo-login').send({ username: 'user', password: 'letmein-demo' }).expect(200);
    expect(again.body.isNewUser).toBe(false);
  });

  it('rejects a wrong password or unknown username the same way', async () => {
    const { app } = await setup({ DEMO_MODE: 'true' });
    const a = await request(app).post('/auth/demo-login').send({ username: 'admin', password: 'nope-nope' }).expect(401);
    const b = await request(app).post('/auth/demo-login').send({ username: 'root', password: 'demo1234' }).expect(401);
    expect(a.body).toEqual(b.body);
    await request(app).post('/auth/demo-login').send({}).expect(400);
  });

  it('the demo vendor can take bookings and the demo user has an address', async () => {
    const { app, db } = await setup({ DEMO_MODE: 'true' });
    await request(app).post('/auth/demo-login').send({ username: 'vendor', password: 'demo1234' }).expect(200);
    await request(app).post('/auth/demo-login').send({ username: 'user', password: 'demo1234' }).expect(200);
    const v = await db.query("SELECT vetting_status FROM providers p JOIN users u ON u.id = p.user_id WHERE u.email = 'demo.vendor@example.com'");
    expect(v.rows[0]).toMatchObject({ vetting_status: 'approved' });
    const a = await db.query("SELECT 1 FROM addresses a JOIN users u ON u.id = a.user_id WHERE u.email = 'demo.user@example.com'");
    expect(a.rowCount).toBe(1);
  });

  it('config: production demo needs no SMTP but must allow pretend payments', () => {
    const base = { JWT_SECRET: 'x'.repeat(40), OTP_SECRET: 'y'.repeat(40), NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/db', DATA_KEY: 'z'.repeat(40) };
    expect(() => loadConfig({ ...base, ALLOW_FAKE_PAYMENTS: 'true' })).toThrow(/SMTP_HOST/);
    expect(() => loadConfig({ ...base, DEMO_MODE: 'true' })).toThrow(/ALLOW_FAKE_PAYMENTS/);
    expect(loadConfig({ ...base, DEMO_MODE: 'true', ALLOW_FAKE_PAYMENTS: 'true' }).DEMO_MODE).toBe('true');
    expect(() => loadConfig({ ...base, DEMO_MODE: 'true', ALLOW_FAKE_PAYMENTS: 'true', DEMO_PASSWORD: 'short' })).toThrow(/DEMO_PASSWORD/);
  });
});

describe('demo history for the vendor and user logins', () => {
  it('fills both accounts with bookings once, and the vendor sees offers, jobs and reviews', async () => {
    const { app, db } = await setup({ DEMO_MODE: 'true' });
    const v = await request(app).post('/auth/demo-login').send({ username: 'vendor', password: 'demo1234' }).expect(200);
    const u = await request(app).post('/auth/demo-login').send({ username: 'user', password: 'demo1234' }).expect(200);
    await request(app).post('/auth/demo-login').send({ username: 'user', password: 'demo1234' }).expect(200); // second login adds nothing
    const count = await db.query("SELECT count(*)::int AS n FROM bookings WHERE customer_id = (SELECT id FROM users WHERE email = 'demo.user@example.com')");
    expect(count.rows[0]!.n).toBe(9);
    const statuses = (await db.query('SELECT DISTINCT status FROM bookings ORDER BY status')).rows.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(['cancelled', 'completed', 'confirmed', 'disputed', 'in_progress', 'offered', 'paid_out']);
    const offers = await db.query("SELECT count(*)::int AS n FROM job_offers WHERE status = 'offered'");
    expect(offers.rows[0]!.n).toBe(3);
    const mine = await request(app).get('/bookings').set('Authorization', `Bearer ${u.body.accessToken}`).expect(200);
    expect((mine.body.bookings ?? mine.body).length).toBeGreaterThanOrEqual(9);
    void v;
  });
});
