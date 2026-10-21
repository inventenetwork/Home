import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDevProvider } from '../src/db/dev-provider.js';
import { makeClock, setup } from './helpers.js';

describe('createDevProvider', () => {
  it('turns "no slots" into real bookable slots in every launch area, and is repeatable', async () => {
    const clock = makeClock(); // Wed 21 Oct 2026, 08:00 Malaysia time
    const { app, db } = await setup({}, { now: clock.now });
    const slots = (service: string, area: string) =>
      request(app).get(`/services/${service}/slots`).query({ date: '2026-10-23', area, units: 2 });

    const before = await slots('home-cleaning', 'kuching');
    expect(before.body.slots.some((s: { available: boolean }) => s.available)).toBe(false);

    await createDevProvider(db);
    await createDevProvider(db); // second run changes nothing
    const n = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM providers');
    expect(n.rows[0]!.n).toBe('1');
    const rows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM provider_availability');
    expect(rows.rows[0]!.n).toBe('7');

    for (const [service, area] of [['home-cleaning', 'kuching'], ['aircon-service', 'petaling-jaya'], ['deep-cleaning', 'kepong'], ['ironing-laundry', 'sibu']]) {
      const res = await slots(service!, area!);
      expect(res.status, `${service} in ${area}`).toBe(200);
      expect(res.body.slots.some((s: { available: boolean }) => s.available), `${service} in ${area}`).toBe(true);
    }
  });

  it('adds capacity with a second email', async () => {
    const { db } = await setup();
    await createDevProvider(db);
    await createDevProvider(db, { email: 'Second@Example.com', name: 'Second' });
    const r = await db.query<{ email: string }>(
      "SELECT u.email FROM providers p JOIN users u ON u.id = p.user_id WHERE p.vetting_status = 'approved' ORDER BY u.email",
    );
    expect(r.rows.map((x) => x.email)).toEqual(['provider@example.com', 'second@example.com']);
  });

  it('refuses to turn an existing customer into a provider', async () => {
    const { db } = await setup();
    await db.query("INSERT INTO users (email, role, consent_at) VALUES ('cust@example.com', 'customer', now())");
    await expect(createDevProvider(db, { email: 'cust@example.com' })).rejects.toThrow(/already exists as a customer/);
  });
});
