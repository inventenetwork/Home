import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addFrequency } from '../src/recurring/routes.js';
import { login, loginAdmin, makeAddress, makeClock, makeProvider, payBooking, setup } from './helpers.js';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+08:00`;
const FRI = '2026-10-23';

async function world() {
  const clock = makeClock();
  const ctx = await setup({}, { now: clock.now });
  const p = await makeProvider(ctx.db, { email: 'cleaner@example.com', name: 'Aisha Rahman' });
  const ptoken = (await login(ctx.app, ctx.mailer, 'cleaner@example.com')).body.accessToken as string;
  const ctoken = (await login(ctx.app, ctx.mailer, 'sam@example.com')).body.accessToken as string;
  const addressId = await makeAddress(ctx.app, ctoken);
  const admin = await loginAdmin(ctx.app, ctx.mailer, ctx.db);
  const call = (method: 'get' | 'post' | 'put' | 'patch', path: string, t: string, body?: object) => {
    const r = request(ctx.app)[method](path).set(bearer(t));
    return body ? r.send(body) : r;
  };
  const book = async (date = FRI, time = '09:00') => {
    const b = await call('post', '/bookings', ctoken, { serviceSlug: 'home-cleaning', addressId, scheduledAt: at(date, time), units: 2 }).expect(201);
    return b.body.id as string;
  };
  const confirmed = async (date = FRI, time = '09:00') => {
    const id = await book(date, time);
    await payBooking(ctx.app, ctoken, id);
    await call('post', `/provider/offers/${id}/accept`, ptoken).expect(200);
    return id;
  };
  const finish = async (id: string) => {
    for (const s of ['on_the_way', 'in_progress', 'completed']) await call('post', `/provider/jobs/${id}/status`, ptoken, { status: s }).expect(200);
  };
  const done = async (date = FRI, time = '09:00') => {
    const id = await confirmed(date, time);
    await finish(id);
    return id;
  };
  return { ...ctx, clock, p, ptoken, ctoken, addressId, admin, call, book, confirmed, finish, done };
}

describe('reviews', () => {
  it('rates a finished job once, updates the provider rating, and shows it on the booking', async () => {
    const w = await world();
    const id = await w.done();
    const r = await w.call('post', `/bookings/${id}/review`, w.ctoken, { rating: 4, comment: 'Tidy work' }).expect(201);
    expect(r.body.rating).toBe(4);
    expect((await w.call('post', `/bookings/${id}/review`, w.ctoken, { rating: 5 })).body.error).toBe('already_reviewed');
    const view = await w.call('get', `/bookings/${id}`, w.ctoken).expect(200);
    expect(view.body.review).toEqual({ rating: 4, comment: 'Tidy work' });
    const mine = await w.call('get', '/provider/reviews', w.ptoken).expect(200);
    expect(mine.body).toMatchObject({ ratingAvg: 4, ratingCount: 1 });
    expect(mine.body.reviews[0]).toMatchObject({ rating: 4, customer: expect.any(String) });
  });

  it('refuses unfinished jobs, bad ratings, strangers and late reviews', async () => {
    const w = await world();
    const id = await w.confirmed();
    expect((await w.call('post', `/bookings/${id}/review`, w.ctoken, { rating: 5 })).body.error).toBe('not_reviewable');
    await w.finish(id);
    expect((await w.call('post', `/bookings/${id}/review`, w.ctoken, { rating: 6 })).status).toBe(400);
    expect((await w.call('post', `/bookings/${id}/review`, w.ctoken, { rating: 3.5 })).status).toBe(400);
    const other = (await login(w.app, w.mailer, 'lee@example.com')).body.accessToken as string;
    expect((await w.call('post', `/bookings/${id}/review`, other, { rating: 5 })).status).toBe(404);
    w.clock.advanceMinutes(31 * 24 * 60);
    expect((await w.call('post', `/bookings/${id}/review`, w.ctoken, { rating: 5 })).body.error).toBe('review_window_closed');
  });
});

describe('disputes', () => {
  it('customer opens one during the payout hold; the booking freezes and the payout cannot be requested', async () => {
    const w = await world();
    const id = await w.done();
    expect((await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'short' })).status).toBe(400);
    const d = await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'The kitchen was not cleaned at all.' }).expect(201);
    expect(d.body.status).toBe('open');
    expect((await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'The kitchen was not cleaned at all.' })).body.error).toBe('already_open');
    const view = await w.call('get', `/bookings/${id}`, w.ctoken).expect(200);
    expect(view.body.status).toBe('disputed');
    expect(view.body.dispute.status).toBe('open');
    const list = await w.call('get', '/admin/disputes', w.admin).expect(200);
    expect(list.body.disputes).toHaveLength(1);
  });

  it('is refused before completion and after the hold has ended', async () => {
    const w = await world();
    const id = await w.confirmed();
    expect((await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'Not done yet but complaining.' })).body.error).toBe('not_disputable');
    await w.finish(id);
    w.clock.advanceMinutes(25 * 60);
    expect((await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'Too late to complain now.' })).body.error).toBe('window_closed');
  });

  it('full refund cancels the booking, refunds the customer and voids the payout', async () => {
    const w = await world();
    const id = await w.done();
    const d = await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'Nobody cleaned anything here.' }).expect(201);
    expect((await w.call('post', `/admin/disputes/${d.body.id}/resolve`, w.admin, { outcome: 'refund' })).status).toBe(400); // note required
    await w.call('post', `/admin/disputes/${d.body.id}/resolve`, w.admin, { outcome: 'refund', note: 'Photos confirm no work done.' }).expect(200);
    const b = (await w.db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id])).rows[0]!;
    expect(b.status).toBe('cancelled');
    const po = (await w.db.query<{ status: string }>('SELECT status FROM payouts WHERE booking_id = $1', [id])).rows[0]!;
    expect(po.status).toBe('failed');
    const pay = (await w.db.query<{ status: string }>('SELECT status FROM payments WHERE booking_id = $1', [id])).rows[0]!;
    expect(pay.status).toBe('refunded');
    expect((await w.call('post', `/admin/disputes/${d.body.id}/resolve`, w.admin, { outcome: 'reject', note: 'again' })).body.error).toBe('not_open');
  });

  it('partial refund can be charged to the provider and ends the hold', async () => {
    const w = await world();
    const id = await w.done();
    const d = await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'Half of the rooms were skipped.' }).expect(201);
    const before = (await w.db.query<{ net_cents: number }>('SELECT net_cents FROM payouts WHERE booking_id = $1', [id])).rows[0]!.net_cents;
    await w.call('post', `/admin/disputes/${d.body.id}/resolve`, w.admin, { outcome: 'refund', note: 'Partial.', amountCents: 2000, chargeProvider: true }).expect(200);
    const b = (await w.db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id])).rows[0]!;
    expect(b.status).toBe('completed');
    const po = (await w.db.query<{ net_cents: number; available_at: Date }>('SELECT net_cents, available_at FROM payouts WHERE booking_id = $1', [id])).rows[0]!;
    expect(po.net_cents).toBe(before - 2000);
    expect(new Date(po.available_at).getTime()).toBeLessThanOrEqual(w.clock.now().getTime());
  });

  it('refund larger than what is held is refused', async () => {
    const w = await world();
    const id = await w.done();
    const d = await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'Everything was broken after.' }).expect(201);
    const r = await w.call('post', `/admin/disputes/${d.body.id}/resolve`, w.admin, { outcome: 'refund', note: 'x y z', amountCents: 99_999_999 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('refund_too_large');
  });

  it('reject releases the payout now; redo restarts the hold', async () => {
    const w = await world();
    const a = await w.done(FRI, '09:00');
    const da = await w.call('post', `/bookings/${a}/dispute`, w.ctoken, { reason: 'I just do not like it, sorry.' }).expect(201);
    await w.call('post', `/admin/disputes/${da.body.id}/resolve`, w.admin, { outcome: 'reject', note: 'Work was fine.' }).expect(200);
    const pa = (await w.db.query<{ available_at: Date }>('SELECT available_at FROM payouts WHERE booking_id = $1', [a])).rows[0]!;
    expect(new Date(pa.available_at).getTime()).toBeLessThanOrEqual(w.clock.now().getTime());

    const b = await w.done('2026-10-24', '09:00');
    const db = await w.call('post', `/bookings/${b}/dispute`, w.ctoken, { reason: 'Windows were left streaky.' }).expect(201);
    await w.call('post', `/admin/disputes/${db.body.id}/resolve`, w.admin, { outcome: 'redo', note: 'Provider will redo.' }).expect(200);
    const pb = (await w.db.query<{ available_at: Date }>('SELECT available_at FROM payouts WHERE booking_id = $1', [b])).rows[0]!;
    expect(new Date(pb.available_at).getTime()).toBeGreaterThan(w.clock.now().getTime());
  });

  it('only admins can use the dispute desk', async () => {
    const w = await world();
    expect((await w.call('get', '/admin/disputes', w.ctoken)).status).toBe(403);
    expect((await w.call('post', `/admin/disputes/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/resolve`, w.ptoken, { outcome: 'reject', note: 'abc' })).status).toBe(403);
  });
});

describe('chat', () => {
  it('only the customer and the assigned provider can talk, and unread counts work', async () => {
    const w = await world();
    const id = await w.confirmed();
    await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: 'Gate code is 1234' }).expect(201);
    const unread = await w.call('get', '/chat/unread', w.ptoken).expect(200);
    expect(unread.body.unread[id]).toBe(1);
    const read = await w.call('get', `/bookings/${id}/messages`, w.ptoken).expect(200);
    expect(read.body.messages).toEqual([expect.objectContaining({ mine: false, body: 'Gate code is 1234' })]);
    expect(read.body.canPost).toBe(true);
    expect((await w.call('get', '/chat/unread', w.ptoken)).body.total).toBe(0);
    w.clock.advanceMinutes(1); // the clock is frozen in tests: a reply must be later than the customer's last read
    await w.call('post', `/bookings/${id}/messages`, w.ptoken, { body: 'Thanks!' }).expect(201);
    expect((await w.call('get', '/chat/unread', w.ctoken)).body.total).toBe(1);

    const stranger = (await login(w.app, w.mailer, 'lee@example.com')).body.accessToken as string;
    expect((await w.call('get', `/bookings/${id}/messages`, stranger)).status).toBe(404);
    expect((await w.call('post', `/bookings/${id}/messages`, stranger, { body: 'hi' })).status).toBe(404);
    await makeProvider(w.db, { email: 'rival@example.com' });
    const rival = (await login(w.app, w.mailer, 'rival@example.com')).body.accessToken as string;
    expect((await w.call('get', `/bookings/${id}/messages`, rival)).status).toBe(404);
  });

  it('is closed before a provider is assigned, validates the text, throttles, and the admin can read it', async () => {
    const w = await world();
    const pending = await w.book('2026-10-25');
    expect((await w.call('get', `/bookings/${pending}/messages`, w.ctoken)).status).toBe(404); // nobody assigned yet
    const id = await w.confirmed();
    expect((await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: '   ' })).status).toBe(400);
    expect((await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: 'x'.repeat(1001) })).status).toBe(400);
    for (let i = 0; i < 10; i++) await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: `m${i}` }).expect(201);
    expect((await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: 'one more' })).status).toBe(429);
    w.clock.advanceMinutes(2);
    await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: 'ok now' }).expect(201);
    const adminView = await w.call('get', `/admin/bookings/${id}/messages`, w.admin).expect(200);
    expect(adminView.body.messages).toHaveLength(11);
    expect((await w.call('get', `/admin/bookings/${id}/messages`, w.ctoken)).status).toBe(403);
  });

  it('turns read-only once the booking is paid out or cancelled', async () => {
    const w = await world();
    const id = await w.done();
    await w.db.query("UPDATE bookings SET status = 'paid_out' WHERE id = $1", [id]);
    const g = await w.call('get', `/bookings/${id}/messages`, w.ctoken).expect(200);
    expect(g.body.canPost).toBe(false);
    expect((await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: 'hello?' })).body.error).toBe('chat_closed');
  });
});

describe('recurring plans', () => {
  it('computes next dates, including month ends', () => {
    expect(addFrequency(new Date('2026-10-23T01:00:00Z'), 'weekly').toISOString()).toBe('2026-10-30T01:00:00.000Z');
    expect(addFrequency(new Date('2026-10-23T01:00:00Z'), 'biweekly').toISOString()).toBe('2026-11-06T01:00:00.000Z');
    expect(addFrequency(new Date('2026-01-31T01:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T01:00:00.000Z');
    // 00:30 MYT on the 31st is still the 30th in UTC: the calendar month must follow Malaysian time.
    expect(addFrequency(new Date('2026-01-30T16:30:00Z'), 'monthly').toISOString()).toBe('2026-02-27T16:30:00.000Z');
  });

  it('creates a plan with its first booking, then books the next visit only after the first is paid', async () => {
    const w = await world();
    const plan = await w.call('post', '/recurring', w.ctoken, { serviceSlug: 'home-cleaning', addressId: w.addressId, scheduledAt: at(FRI, '09:00'), units: 2, frequency: 'weekly', sessions: 3 }).expect(201);
    const list = await w.call('get', '/recurring', w.ctoken).expect(200);
    expect(list.body.plans[0]).toMatchObject({ id: plan.body.id, sessionsRemaining: 2, status: 'active', awaitingPaymentBookingId: plan.body.bookingId });
    expect(new Date(list.body.plans[0].nextAt).toISOString()).toBe('2026-10-30T01:00:00.000Z');
    expect((await w.call('post', `/recurring/${plan.body.id}/next`, w.ctoken, {})).body.error).toBe('payment_pending');
    await payBooking(w.app, w.ctoken, plan.body.bookingId);
    const n = await w.call('post', `/recurring/${plan.body.id}/next`, w.ctoken, {}).expect(201);
    expect(n.body.bookingId).toBeTruthy();
    await payBooking(w.app, w.ctoken, n.body.bookingId);
    const n2 = await w.call('post', `/recurring/${plan.body.id}/next`, w.ctoken, {}).expect(201);
    await payBooking(w.app, w.ctoken, n2.body.bookingId);
    const after = (await w.call('get', '/recurring', w.ctoken)).body.plans[0];
    expect(after).toMatchObject({ status: 'completed', sessionsRemaining: 0, nextAt: null });
    expect((await w.call('post', `/recurring/${plan.body.id}/next`, w.ctoken, {})).body.error).toBe('plan_not_active');
  });

  it('pause and cancel stop new visits; other customers cannot touch the plan', async () => {
    const w = await world();
    const plan = await w.call('post', '/recurring', w.ctoken, { serviceSlug: 'home-cleaning', addressId: w.addressId, scheduledAt: at(FRI, '09:00'), units: 2, frequency: 'biweekly', sessions: null }).expect(201);
    await payBooking(w.app, w.ctoken, plan.body.bookingId);
    await w.call('patch', `/recurring/${plan.body.id}`, w.ctoken, { status: 'paused' }).expect(200);
    expect((await w.call('post', `/recurring/${plan.body.id}/next`, w.ctoken, {})).body.error).toBe('plan_not_active');
    await w.call('patch', `/recurring/${plan.body.id}`, w.ctoken, { status: 'active' }).expect(200);
    const other = (await login(w.app, w.mailer, 'lee@example.com')).body.accessToken as string;
    expect((await w.call('patch', `/recurring/${plan.body.id}`, other, { status: 'cancelled' })).status).toBe(404);
    expect((await w.call('post', `/recurring/${plan.body.id}/next`, other, {})).status).toBe(404);
    await w.call('patch', `/recurring/${plan.body.id}`, w.ctoken, { status: 'cancelled' }).expect(200);
    expect((await w.call('patch', `/recurring/${plan.body.id}`, w.ctoken, { status: 'active' })).body.error).toBe('plan_closed');
  });

  it('validates the plan', async () => {
    const w = await world();
    const base = { serviceSlug: 'home-cleaning', addressId: w.addressId, scheduledAt: at(FRI, '09:00'), units: 2, frequency: 'weekly' };
    expect((await w.call('post', '/recurring', w.ctoken, { ...base, sessions: 1 })).status).toBe(400);
    expect((await w.call('post', '/recurring', w.ctoken, { ...base, sessions: 99 })).status).toBe(400);
    expect((await w.call('post', '/recurring', w.ctoken, { ...base, frequency: 'daily' })).status).toBe(400);
    expect((await w.call('post', '/recurring', w.ctoken, { ...base, serviceSlug: 'nope' })).status).toBe(404);
    expect((await w.call('get', '/recurring', w.ctoken)).body.plans).toEqual([]); // failed attempts leave nothing behind
  });

  it('offers a repeat visit to the same provider first', async () => {
    const w = await world();
    const other = await makeProvider(w.db, { email: 'other@example.com', name: 'Zed' });
    await w.db.query('UPDATE providers SET rating_avg = 5, rating_count = 50 WHERE id = $1', [other.providerId]); // would normally rank first
    const plan = await w.call('post', '/recurring', w.ctoken, { serviceSlug: 'home-cleaning', addressId: w.addressId, scheduledAt: at(FRI, '09:00'), units: 2, frequency: 'weekly', sessions: 3 }).expect(201);
    await payBooking(w.app, w.ctoken, plan.body.bookingId);
    await w.call('post', `/provider/offers/${plan.body.bookingId}/accept`, w.ptoken).expect(200);
    await w.finish(plan.body.bookingId);
    const n = await w.call('post', `/recurring/${plan.body.id}/next`, w.ctoken, {}).expect(201);
    await payBooking(w.app, w.ctoken, n.body.bookingId);
    const offers = await w.db.query<{ provider_id: string; offered_at: Date }>('SELECT provider_id, offered_at FROM job_offers WHERE booking_id = $1', [n.body.bookingId]);
    expect(offers.rows.map((o) => o.provider_id)).toContain(w.p.providerId);
  });
});
