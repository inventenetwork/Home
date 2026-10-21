import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { activateAllServices, clearDemoData, loadDemoData } from '../src/db/demo.js';
import { login, loginAdmin, makeClock, setup } from './helpers.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function world() {
  const clock = makeClock('2026-10-21T04:00:00Z');
  const ctx = await setup({}, { now: clock.now });
  const admin = await loginAdmin(ctx.app, ctx.mailer, ctx.db);
  const get = (path: string, t = admin) => request(ctx.app).get(path).set(bearer(t));
  return { ...ctx, clock, admin, get };
}

describe('demo data', () => {
  it('switches every service on, adds believable bookings, and can be removed again', async () => {
    const w = await world();
    expect(await activateAllServices(w.db)).toBe(11);
    expect(await activateAllServices(w.db)).toBe(0);
    const r = await loadDemoData(w.db, { now: w.clock.now(), weeks: 12, customers: 8 });
    expect(r.bookings).toBeGreaterThan(100);
    const count = async () => Number((await w.db.query<{ n: string }>("SELECT count(*)::text AS n FROM bookings")).rows[0]!.n);
    expect(await count()).toBe(r.bookings);
    // Running it again replaces, not doubles.
    const again = await loadDemoData(w.db, { now: w.clock.now(), weeks: 12, customers: 8 });
    expect(again.bookings).toBe(r.bookings);
    expect(await count()).toBe(r.bookings);
    // Money rows agree with the bookings.
    const odd = await w.db.query(`SELECT 1 FROM bookings b WHERE b.status = 'paid_out' AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.booking_id = b.id AND p.status = 'paid')`);
    expect(odd.rows).toHaveLength(0);
    expect(await clearDemoData(w.db)).toBe(r.bookings);
    expect(await count()).toBe(0);
    expect((await w.db.query("SELECT 1 FROM users WHERE email LIKE 'demo.customer%'")).rows).toHaveLength(0);
  });
});

describe('GET /admin/analytics/services', () => {
  it('ranks services by paid orders and returns one number per period', async () => {
    const w = await world();
    await activateAllServices(w.db);
    await loadDemoData(w.db, { now: w.clock.now(), weeks: 12, customers: 8 });
    const res = await w.get('/admin/analytics/services?period=week').expect(200);
    expect(res.body.period).toBe('week');
    expect(res.body.buckets).toHaveLength(12);
    expect(res.body.buckets[11].current).toBe(true);
    // Weeks start on Monday: 21 Oct 2026 is a Wednesday, so this week began on the 19th.
    expect(res.body.buckets[11].start).toBe('2026-10-19');
    expect(res.body.services).toHaveLength(15);
    const orders = res.body.services.map((s: any) => s.orders);
    expect([...orders].sort((a: number, b: number) => b - a)).toEqual(orders);
    expect(res.body.top.slug).toBe(res.body.services[0].slug);
    expect(res.body.services[0].slug).toBe('home-cleaning'); // the most popular in the dummy data
    for (const s of res.body.services) {
      expect(s.series).toHaveLength(12);
      expect(s.series.reduce((a: number, b: number) => a + b, 0)).toBe(s.orders);
    }
    expect(res.body.totals.perBucket.reduce((a: number, b: number) => a + b, 0)).toBe(res.body.totals.orders);
    const shares = res.body.services.reduce((a: number, s: any) => a + s.share, 0);
    expect(shares).toBeGreaterThan(0.99);
    expect(shares).toBeLessThan(1.01);
  });

  it('counts only paid bookings, and matches the database', async () => {
    const w = await world();
    await activateAllServices(w.db);
    await loadDemoData(w.db, { now: w.clock.now(), weeks: 12, customers: 8 });
    // An unpaid booking that lapsed is not an order.
    const cust = (await w.db.query<{ id: string; a: string }>("SELECT u.id, (SELECT id FROM addresses WHERE user_id = u.id LIMIT 1) AS a FROM users u WHERE email = 'demo.customer1@example.com'")).rows[0]!;
    const svc = (await w.db.query<{ id: string }>("SELECT id FROM services WHERE slug = 'pet-care'")).rows[0]!;
    await w.db.query("INSERT INTO bookings (customer_id, service_id, address_id, status, scheduled_at, units, subtotal_cents, total_cents, cancelled_reason, created_at) VALUES ($1,$2,$3,'cancelled','2026-10-20T02:00:00Z',1,1000,1000,'payment_timeout','2026-10-20T01:00:00Z')", [cust.id, svc.id, cust.a]);
    const res = await w.get('/admin/analytics/services?period=month&count=36').expect(200);
    const paid = Number((await w.db.query<{ n: string }>("SELECT count(*)::text AS n FROM bookings b WHERE EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('held','released','refunded'))")).rows[0]!.n);
    expect(res.body.totals.orders).toBe(paid);
    const cancelled = Number((await w.db.query<{ n: string }>("SELECT count(*)::text AS n FROM bookings b WHERE b.status = 'cancelled' AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status = 'refunded')")).rows[0]!.n);
    expect(res.body.totals.cancelled).toBe(cancelled);
  });

  it('supports months and quarters, with sensible bucket starts', async () => {
    const w = await world();
    const m = await w.get('/admin/analytics/services?period=month&count=3').expect(200);
    expect(m.body.buckets.map((b: any) => b.start)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    const q = await w.get('/admin/analytics/services?period=quarter').expect(200);
    expect(q.body.buckets.map((b: any) => b.start)).toEqual(['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
    expect(q.body.top).toBeNull(); // no orders yet
    expect(q.body.totals.orders).toBe(0);
  });

  it('puts a booking made just after midnight Malaysia time into the right week', async () => {
    const w = await world();
    const cust = (await login(w.app, w.mailer, 'sam@example.com')).body.user.id as string;
    const addr = (await w.db.query<{ id: string }>("INSERT INTO addresses (user_id, line1, postcode) VALUES ($1,'1 Jalan','47300') RETURNING id", [cust])).rows[0]!.id;
    const svc = (await w.db.query<{ id: string }>("SELECT id FROM services WHERE slug = 'home-cleaning'")).rows[0]!.id;
    // 2026-10-18 17:00 UTC is Monday 19 Oct 01:00 in Malaysia: it belongs to the week starting the 19th, not the 12th.
    const b = (await w.db.query<{ id: string }>("INSERT INTO bookings (customer_id, service_id, address_id, status, scheduled_at, units, subtotal_cents, total_cents, created_at) VALUES ($1,$2,$3,'confirmed','2026-10-25T02:00:00Z',2,6000,6000,'2026-10-18T17:00:00Z') RETURNING id", [cust, svc, addr])).rows[0]!.id;
    await w.db.query("INSERT INTO payments (booking_id, gateway, gateway_ref, method, amount_cents, status) VALUES ($1,'t','x1','fpx',6000,'held')", [b]);
    const res = await w.get('/admin/analytics/services?period=week&count=2').expect(200);
    expect(res.body.buckets.map((x: any) => x.start)).toEqual(['2026-10-12', '2026-10-19']);
    const hc = res.body.services.find((s: any) => s.slug === 'home-cleaning');
    expect(hc.series).toEqual([0, 1]);
    expect(hc.valueSeries).toEqual([0, 6000]);
  });

  it('checks its input and is for admins only', async () => {
    const w = await world();
    for (const q of ['period=day', 'period=week&count=0', 'period=week&count=99', 'period=quarter&count=abc']) {
      expect((await w.get(`/admin/analytics/services?${q}`)).status, q).toBe(400);
    }
    const cust = (await login(w.app, w.mailer, 'sam@example.com')).body.accessToken as string;
    expect((await w.get('/admin/analytics/services', cust)).status).toBe(403);
    expect((await request(w.app).get('/admin/analytics/services')).status).toBe(401);
  });
});
