import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import type { GoogleVerifier } from '../src/auth/google.js';
import { MemoryMailer } from '../src/mailer.js';
import { FakeGateway, fakeGatewaySecret } from '../src/payments/fake.js';
import { createMemoryStore } from '../src/storage.js';

/** A controllable clock for booking tests. Default: Wed 21 Oct 2026, 08:00 Malaysia time. */
export function makeClock(iso = '2026-10-21T00:00:00Z') {
  let t = new Date(iso);
  return {
    now: () => new Date(t),
    set(d: string | Date) {
      t = new Date(d);
    },
    advanceMinutes(m: number) {
      t = new Date(t.getTime() + m * 60_000);
    },
  };
}

export async function setup(overrides: Record<string, string> = {}, opts: { now?: () => Date; googleVerifier?: GoogleVerifier; requireAfterPhoto?: boolean } = {}) {
  const cfg: Config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234567890',
    OTP_SECRET: 'test-otp-secret-test-otp-secret-1234567890',
    OTP_RESEND_COOLDOWN_SECONDS: '0',
    OTP_MAX_ATTEMPTS: '3',
    RATE_LIMIT_PER_MINUTE: '10000',
    ...overrides,
  });
  const db: Db = await createDb({}); // in-memory PGlite
  await migrate(db);
  await seed(db);
  // Most tests are not about photos, so finishing a job does not require one unless a test asks for it.
  await db.query(
    `INSERT INTO app_config (key, value) VALUES ('require_after_photo', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [opts.requireAfterPhoto ? 'true' : 'false'],
  );
  const mailer = new MemoryMailer();
  const store = createMemoryStore();
  const gateway = new FakeGateway(fakeGatewaySecret(cfg.JWT_SECRET));
  const app = createApp({ cfg, db, mailer, now: opts.now, googleVerifier: opts.googleVerifier, gateway, store });
  return { cfg, db, mailer, app, gateway, store };
}

/**
 * Inserts a provider straight into the database (provider onboarding comes in a later step).
 * By default: approved, can do home cleaning, serves Petaling Jaya, works 08:00-20:00 every day.
 */
export async function makeProvider(
  db: Db,
  opts: {
    email: string;
    name?: string;
    areas?: string[];
    skills?: string[];
    approved?: boolean;
    windows?: Array<{ weekday: number; start: string; end: string }>;
  },
) {
  const user = await db.query<{ id: string }>(
    "INSERT INTO users (email, role, full_name, consent_at) VALUES ($1, 'provider', $2, now()) RETURNING id",
    [opts.email, opts.name ?? 'Aisha Rahman'],
  );
  const provider = await db.query<{ id: string }>(
    'INSERT INTO providers (user_id, vetting_status) VALUES ($1, $2) RETURNING id',
    [user.rows[0]!.id, opts.approved === false ? 'pending' : 'approved'],
  );
  const providerId = provider.rows[0]!.id;
  for (const slug of opts.areas ?? ['petaling-jaya']) {
    await db.query('INSERT INTO provider_areas (provider_id, area_id) SELECT $1, id FROM areas WHERE slug = $2', [providerId, slug]);
  }
  for (const code of opts.skills ?? ['cleaning']) {
    await db.query('INSERT INTO provider_skills (provider_id, skill_id) SELECT $1, id FROM skills WHERE code = $2', [providerId, code]);
  }
  const windows = opts.windows ?? [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '08:00', end: '20:00' }));
  for (const w of windows) {
    await db.query(
      'INSERT INTO provider_availability (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)',
      [providerId, w.weekday, w.start, w.end],
    );
  }
  return { userId: user.rows[0]!.id, providerId };
}

/** Creates a saved address through the real API and returns its id. */
export async function makeAddress(app: App, token: string, areaSlug = 'petaling-jaya'): Promise<string> {
  const res = await request(app)
    .post('/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({ line1: '12 Jalan SS2/24', postcode: '47300', areaSlug });
  return res.body.id as string;
}

type App = ReturnType<typeof createApp>;

/** Creates an admin directly in the database (admins cannot self-register) and logs them in. Returns the access token. */
export async function loginAdmin(app: App, mailer: MemoryMailer, db: Db, email = 'boss@example.com'): Promise<string> {
  await db.query(
    "INSERT INTO users (email, role, consent_at) VALUES ($1, 'admin', now()) ON CONFLICT (email) DO UPDATE SET role = 'admin'",
    [email],
  );
  const res = await login(app, mailer, email);
  return res.body.accessToken as string;
}

/** Full login flow: request a code, read it from the memory mailer, verify it. */
export async function login(
  app: App,
  mailer: MemoryMailer,
  email: string,
  extra: { role?: 'customer' | 'provider'; consent?: boolean } = {},
) {
  await request(app).post('/auth/otp/request').send({ email }).expect(200);
  const code = mailer.lastCodeFor(email.trim().toLowerCase())!; // the API normalizes emails to lowercase
  return request(app)
    .post('/auth/otp/verify')
    .send({ email, code, consent: true, ...extra });
}

/**
 * Pays for a booking the way a customer does: choose a method, get sent to the (fake) payment page, press a button there.
 * The gateway's webhook is what actually moves the booking, so this exercises the real path.
 */
export async function payBooking(
  app: Parameters<typeof request>[0],
  token: string,
  bookingId: string,
  outcome: 'success' | 'failed' | 'cancelled' = 'success',
  method: 'fpx' | 'ewallet' = 'fpx',
) {
  const pay = await request(app).post(`/bookings/${bookingId}/pay`).set('Authorization', `Bearer ${token}`).send({ method });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const done = await request(app).post(pay.body.redirectUrl as string).type('form').send({ outcome });
  expect(done.status).toBe(303);
  return pay.body as { paymentId: string; redirectUrl: string; method: string; amountCents: number };
}

/** A tiny but real-looking PNG (correct signature, padded to a plausible size) for upload tests. Different `seed`s give different bytes. */
export function png(seed = 0): string {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(200, seed)]).toString('base64');
}
