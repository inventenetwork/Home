import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createObjectStore, createDbBackend, type ObjectBackend } from '../src/storage.js';
import { login, makeAddress, makeClock, makeProvider, setup } from './helpers.js';

const base = { JWT_SECRET: 'x'.repeat(40), OTP_SECRET: 'y'.repeat(40) };
const prod = { ...base, NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@localhost/db', SMTP_HOST: 'smtp.example.com', DATA_KEY: 'z'.repeat(40) };
const s3 = { STORAGE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };

describe('hosting configuration', () => {
  it('production refuses the pretend payment gateway unless a labelled demo is explicitly allowed', () => {
    expect(() => loadConfig(prod)).toThrow(/PAYMENT_GATEWAY=fake/);
    expect(() => loadConfig({ ...prod, ALLOW_FAKE_PAYMENTS: 'false' })).toThrow(/PAYMENT_GATEWAY=fake/);
    expect(loadConfig({ ...prod, ALLOW_FAKE_PAYMENTS: 'true' }).PAYMENT_GATEWAY).toBe('fake');
    expect(() => loadConfig({ ...prod, ALLOW_FAKE_PAYMENTS: 'yes' })).toThrow(/ALLOW_FAKE_PAYMENTS/);
  });
  it('s3 storage needs the bucket and keys', () => {
    expect(() => loadConfig({ ...base, STORAGE: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...base, STORAGE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    const c = loadConfig({ ...base, ...s3, S3_ENDPOINT: '' });
    expect(c).toMatchObject({ STORAGE: 's3', S3_REGION: 'ap-southeast-1', S3_PREFIX: 'uploads/' });
    expect(c.S3_ENDPOINT).toBeUndefined(); // empty counts as not set
  });
  it('Vercel has no permanent disk, so it must use s3', () => {
    expect(() => loadConfig({ ...base, VERCEL: '1' })).toThrow(/STORAGE=s3/);
    expect(loadConfig({ ...base, ...s3, VERCEL: '1' }).STORAGE).toBe('s3');
    expect(loadConfig({ ...base, STORAGE: 'db', VERCEL: '1' }).STORAGE).toBe('db');
  });
  it('CRON_SECRET must be long enough, and empty means off', () => {
    expect(() => loadConfig({ ...base, CRON_SECRET: 'short' })).toThrow(/CRON_SECRET/);
    expect(loadConfig({ ...base, CRON_SECRET: '' }).CRON_SECRET).toBeUndefined();
    expect(loadConfig({ ...base }).DB_POOL_MAX).toBe(5);
  });
});

describe('database file store (STORAGE=db)', () => {
  it('is for the demo only in production', () => {
    expect(() => loadConfig({ ...prod, ALLOW_FAKE_PAYMENTS: 'true', STORAGE: 'db' })).toThrow(/STORAGE=db/);
    expect(loadConfig({ ...prod, SMTP_HOST: '', ALLOW_FAKE_PAYMENTS: 'true', DEMO_MODE: 'true', STORAGE: 'db' }).STORAGE).toBe('db');
  });
  it('saves, reads and removes files', async () => {
    const { db } = await setup();
    const store = createObjectStore(createDbBackend(db));
    const data = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const key = await store.save(data, 'jpg');
    const back = await store.read(key);
    expect(back?.mime).toBe('image/jpeg');
    expect(back?.data.equals(data)).toBe(true);
    await store.remove(key);
    expect(await store.read(key)).toBeNull();
  });
});

describe('object store (what the S3 bucket sits behind)', () => {
  const backend = () => {
    const m = new Map<string, { data: Buffer; type: string }>();
    const b: ObjectBackend = {
      async put(key, data, type) { m.set(key, { data, type }); },
      async get(key) { return m.get(key)?.data ?? null; },
      async del(key) { m.delete(key); },
    };
    return { m, b };
  };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

  it('saves, reads back with the right type, and removes', async () => {
    const { m, b } = backend();
    const store = createObjectStore(b);
    const key = await store.save(png, 'png');
    expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(m.get(key)!.type).toBe('image/png');
    const got = await store.read(key);
    expect(got!.mime).toBe('image/png');
    expect(got!.data.equals(png)).toBe(true);
    await store.remove(key);
    expect(await store.read(key)).toBeNull();
  });
  it('never touches the backend for a key it did not make', async () => {
    const calls: string[] = [];
    const store = createObjectStore({
      async put(k) { calls.push(`put ${k}`); },
      async get(k) { calls.push(`get ${k}`); return Buffer.from('x'); },
      async del(k) { calls.push(`del ${k}`); },
    });
    for (const bad of ['../secret.png', 'a/b.png', 'x.png', '00000000-0000-0000-0000-000000000000.exe', '']) {
      expect(await store.read(bad)).toBeNull();
      await store.remove(bad);
    }
    expect(calls).toEqual([]);
  });
  it('a failing backend reads as "not found" and a failing delete never throws', async () => {
    const store = createObjectStore({
      async put() {},
      async get() { throw new Error('network'); },
      async del() { throw new Error('network'); },
    });
    expect(await store.read('00000000-0000-4000-8000-000000000000.png')).toBeNull();
    await expect(store.remove('00000000-0000-4000-8000-000000000000.png')).resolves.toBeUndefined();
  });
});

describe('/internal/housekeeping (for Vercel Cron)', () => {
  const secret = 'c'.repeat(32);

  it('does not exist unless CRON_SECRET is set', async () => {
    const w = await setup();
    expect((await request(w.app).get('/internal/housekeeping')).status).toBe(404);
  });
  it('refuses anyone without the secret', async () => {
    const w = await setup({ CRON_SECRET: secret });
    expect((await request(w.app).get('/internal/housekeeping')).status).toBe(401);
    expect((await request(w.app).get('/internal/housekeeping').set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(w.app).get('/internal/housekeeping').set('Authorization', secret)).status).toBe(401);
    expect((await request(w.app).get('/internal/housekeeping').set('Authorization', `Bearer ${secret}x`)).status).toBe(401);
  });
  it('releases unpaid bookings that ran out of time', async () => {
    const clock = makeClock();
    const w = await setup({ CRON_SECRET: secret }, { now: clock.now });
    await makeProvider(w.db, { email: 'cleaner@example.com' });
    const token = (await login(w.app, w.mailer, 'sam@example.com')).body.accessToken as string;
    const addressId = await makeAddress(w.app, token);
    const b = await request(w.app).post('/bookings').set('Authorization', `Bearer ${token}`).send({ serviceSlug: 'home-cleaning', addressId, scheduledAt: '2026-10-23T09:00:00+08:00', units: 2 }).expect(201);
    const status = async () => (await w.db.query<{ status: string; cancelled_reason: string | null }>('SELECT status, cancelled_reason FROM bookings WHERE id = $1', [b.body.id])).rows[0]!;
    expect((await status()).status).toBe('pending');
    clock.advanceMinutes(45); // the hold is 30 minutes
    const r = await request(w.app).get('/internal/housekeeping').set('Authorization', `Bearer ${secret}`).expect(200);
    expect(r.body).toEqual({ ok: true });
    expect(await status()).toEqual({ status: 'cancelled', cancelled_reason: 'payment_timeout' });
  });
});
