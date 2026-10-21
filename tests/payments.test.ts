import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { expireStalePending } from '../src/bookings/availability.js';
import { loadBookingSettings } from '../src/bookings/settings.js';
import { login, loginAdmin, makeAddress, makeClock, makeProvider, payBooking, setup } from './helpers.js';

// Fixed "now": Wed 21 Oct 2026, 08:00 Malaysia time. Bookings are on Fri 23 Oct. A 2-hour cleaning is RM 60.00 = 6000 sen.
const at = (hhmm: string) => `2026-10-23T${hhmm}:00+08:00`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const TOTAL = 6000;

async function world(providerCount = 1) {
  const clock = makeClock();
  const ctx = await setup({}, { now: clock.now });
  const providers: Array<{ providerId: string; token: string }> = [];
  for (let i = 0; i < providerCount; i++) {
    const email = `cleaner${i + 1}@example.com`;
    const p = await makeProvider(ctx.db, { email, name: `Cleaner ${i + 1}` });
    providers.push({ providerId: p.providerId, token: (await login(ctx.app, ctx.mailer, email)).body.accessToken });
  }
  const token = (await login(ctx.app, ctx.mailer, 'sam@example.com')).body.accessToken as string;
  const other = (await login(ctx.app, ctx.mailer, 'eve@example.com')).body.accessToken as string;
  const addressId = await makeAddress(ctx.app, token);
  const admin = await loginAdmin(ctx.app, ctx.mailer, ctx.db);

  const book = async (time = '09:00') => {
    const res = await request(ctx.app).post('/bookings').set(bearer(token)).send({ serviceSlug: 'home-cleaning', addressId, scheduledAt: at(time), units: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const view = async (id: string) => (await request(ctx.app).get(`/bookings/${id}`).set(bearer(token))).body;
  const pay = (id: string, method: unknown = 'fpx', t = token) => request(ctx.app).post(`/bookings/${id}/pay`).set(bearer(t)).send({ method });
  const payments = async (id: string) =>
    (await ctx.db.query<Record<string, any>>('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at, id', [id])).rows;
  const refunds = async (id: string) =>
    (await ctx.db.query<Record<string, any>>('SELECT r.* FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.booking_id = $1 ORDER BY r.created_at, r.id', [id])).rows;
  const webhook = (raw: Buffer, headers: Record<string, string>) => request(ctx.app).post('/payments/webhook').set(headers).send(raw.toString('utf8')); // a string is sent byte-for-byte; a Buffer would be JSON-encoded by superagent
  const event = (gatewayRef: string, type = 'payment.succeeded', amountCents = TOTAL, eventId = 'evt_1') =>
    ctx.gateway.signedEvent({ eventId, gatewayRef, type: type as any, amountCents });
  const offers = (p: { token: string }) => request(ctx.app).get('/provider/offers').set(bearer(p.token));
  const adminPost = (path: string, body: object = {}) => request(ctx.app).post(path).set(bearer(admin)).send(body);
  return { ...ctx, clock, providers, token, other, addressId, admin, book, view, pay, payments, refunds, webhook, event, offers, adminPost };
}

describe('paying for a booking', () => {
  it('after a successful payment the money is held and the booking goes out to providers', async () => {
    const w = await world();
    const id = await w.book();
    expect((await w.view(id)).payment).toBeNull();

    const started = await payBooking(w.app, w.token, id, 'success', 'ewallet');
    expect(started.amountCents).toBe(TOTAL);

    const v = await w.view(id);
    expect(v.status).toBe('offered');
    expect(v.payment).toMatchObject({ status: 'paid', method: 'ewallet', amountCents: TOTAL, refundedCents: 0, refundPending: false });
    expect(v.payment.paidAt).toBeTruthy();
    expect((await w.offers(w.providers[0]!)).body.offers).toHaveLength(1);
    const [row] = await w.payments(id);
    expect(row).toMatchObject({ status: 'held', gateway: 'fake', method: 'ewallet', amount_cents: TOTAL });
  });

  it('the price charged is the booking total, never something the client sends', async () => {
    const w = await world();
    const id = await w.book();
    const res = await request(w.app).post(`/bookings/${id}/pay`).set(bearer(w.token)).send({ method: 'fpx', amountCents: 1 });
    expect(res.status).toBe(400); // unknown field rejected
    const ok = await w.pay(id).expect(201);
    expect(ok.body.amountCents).toBe(TOTAL);
  });

  it('while the customer is still on the payment page, the booking stays pending', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201);
    const v = await w.view(id);
    expect(v.status).toBe('pending');
    expect(v.payment).toMatchObject({ status: 'pending', refundedCents: 0 });
    expect(JSON.stringify(v)).not.toMatch(/fake_/); // gateway references stay on the server
  });

  it('a declined or cancelled payment leaves the booking waiting, and the customer can try again', async () => {
    const w = await world();
    const id = await w.book();
    await payBooking(w.app, w.token, id, 'failed');
    expect((await w.view(id)).status).toBe('pending');
    expect((await w.view(id)).payment.status).toBe('failed');
    w.clock.advanceMinutes(1);
    await payBooking(w.app, w.token, id, 'cancelled');
    expect((await w.payments(id)).map((p) => [p.status, p.failure_reason])).toEqual([['failed', 'declined'], ['failed', 'cancelled']]);
    w.clock.advanceMinutes(1);
    await payBooking(w.app, w.token, id, 'success');
    expect((await w.view(id)).status).toBe('offered');
    expect((await w.payments(id)).map((p) => p.status)).toEqual(['failed', 'failed', 'held']);
  });

  it('starting again replaces an unfinished attempt', async () => {
    const w = await world();
    const id = await w.book();
    const first = await w.pay(id, 'fpx').expect(201);
    w.clock.advanceMinutes(1);
    const second = await w.pay(id, 'ewallet').expect(201);
    expect(second.body.paymentId).not.toBe(first.body.paymentId);
    expect((await w.payments(id)).map((p) => [p.status, p.failure_reason])).toEqual([['failed', 'superseded'], ['pending', null]]);
    await request(w.app).post(second.body.redirectUrl).type('form').send({ outcome: 'success' }).expect(303);
    expect((await w.view(id)).payment).toMatchObject({ status: 'paid', method: 'ewallet' });
  });

  it('only the owner can pay, only with a valid method, and only while the booking waits for payment', async () => {
    const w = await world();
    const id = await w.book();
    await request(w.app).post(`/bookings/${id}/pay`).send({ method: 'fpx' }).expect(401);
    await w.pay(id, 'fpx', w.other).expect(404); // someone else's booking looks like no booking
    await w.pay(id, 'bitcoin').expect(400);
    await w.pay('not-a-uuid').expect(404);

    await payBooking(w.app, w.token, id);
    const again = await w.pay(id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('booking_not_payable');

    const other = await w.book('13:00');
    await request(w.app).post(`/bookings/${other}/cancel`).set(bearer(w.token)).send({}).expect(200);
    expect((await w.pay(other)).body.error).toBe('booking_not_payable');
  });

  it('refuses to start paying once the hold has run out', async () => {
    const w = await world();
    const id = await w.book();
    w.clock.advanceMinutes(31);
    const res = await w.pay(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('booking_expired');
  });
});

describe('the gateway webhook', () => {
  it('rejects messages that are not genuinely signed', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201);
    const ref = (await w.payments(id))[0]!.gateway_ref as string;
    const good = w.event(ref);

    await w.webhook(good.raw, { 'content-type': 'application/json' }).expect(401); // no signature
    await w.webhook(good.raw, { 'content-type': 'application/json', 'x-signature': 'f'.repeat(64) }).expect(401); // wrong signature
    const tampered = Buffer.from(good.raw.toString().replace(String(TOTAL), '1'));
    await w.webhook(tampered, good.headers).expect(401); // signed for a different body
    expect((await w.view(id)).status).toBe('pending'); // nothing happened

    const junk = Buffer.from('not json');
    await w.webhook(junk, { 'content-type': 'application/json', 'x-signature': w.gateway.sign(junk) }).expect(400);
    const shapeless = Buffer.from('{"hello":1}');
    await w.webhook(shapeless, { 'content-type': 'application/json', 'x-signature': w.gateway.sign(shapeless) }).expect(400);
  });

  it('a genuine message for an unknown payment is refused, and a wrong amount changes nothing', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201);
    const ref = (await w.payments(id))[0]!.gateway_ref as string;

    const unknown = w.event('fake_does_not_exist');
    await w.webhook(unknown.raw, unknown.headers).expect(404);

    const cheap = w.event(ref, 'payment.succeeded', 100);
    const res = await w.webhook(cheap.raw, cheap.headers);
    expect(res.status).toBe(422);
    expect((await w.view(id)).status).toBe('pending');
    expect((await w.payments(id))[0]!.status).toBe('pending');
    const logged = await w.db.query("SELECT 1 FROM audit_log WHERE action = 'payment.amount_mismatch'");
    expect(logged.rowCount).toBe(1);
  });

  it('receiving the same success message twice (or a stale "failed" after it) does nothing more', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201);
    const ref = (await w.payments(id))[0]!.gateway_ref as string;

    const ok = w.event(ref);
    const first = await w.webhook(ok.raw, ok.headers).expect(200);
    expect(first.body.result).toBe('paid');
    const second = await w.webhook(ok.raw, ok.headers).expect(200);
    expect(second.body.result).toBe('duplicate');
    const stale = w.event(ref, 'payment.failed', TOTAL, 'evt_2');
    expect((await w.webhook(stale.raw, stale.headers).expect(200)).body.result).toBe('ignored');

    expect((await w.payments(id))[0]!.status).toBe('held');
    expect((await w.view(id)).status).toBe('offered');
    const received = await w.db.query<{ offers_received: number }>('SELECT offers_received FROM providers WHERE id = $1', [w.providers[0]!.providerId]);
    expect(received.rows[0]!.offers_received).toBe(1); // one offer, not two
  });

  it('two success messages at the same moment still pay once', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201);
    const ref = (await w.payments(id))[0]!.gateway_ref as string;
    const ok = w.event(ref);
    const [a, b] = await Promise.all([w.webhook(ok.raw, ok.headers), w.webhook(ok.raw, ok.headers)]);
    expect([a.body.result, b.body.result].sort()).toEqual(['duplicate', 'paid']);
    expect(await w.db.query('SELECT 1 FROM job_offers WHERE booking_id = $1', [id]).then((r) => r.rowCount)).toBe(1);
  });
});

describe('late and double payments', () => {
  it('money that arrives after the hold ran out is refunded automatically', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201);
    const ref = (await w.payments(id))[0]!.gateway_ref as string;

    w.clock.advanceMinutes(36); // 30-minute hold + 10-minute grace for a payment in progress: both gone
    await expireStalePending(w.db, w.clock.now(), await loadBookingSettings(w.db));
    expect((await w.view(id)).status).toBe('cancelled');

    const late = w.event(ref);
    expect((await w.webhook(late.raw, late.headers).expect(200)).body.result).toBe('paid_late_refunded');
    const v = await w.view(id);
    expect(v.status).toBe('cancelled'); // the slot is gone; we do not resurrect the booking
    expect(v.payment).toMatchObject({ status: 'refunded', refundedCents: TOTAL, refundPending: false });
    expect(w.gateway.refundCalls).toHaveLength(1);
    expect(w.gateway.refundCalls[0]).toMatchObject({ amountCents: TOTAL, paymentGatewayRef: ref });
  });

  it('a customer who is mid-payment when the hold ends keeps the booking (short grace)', async () => {
    const w = await world();
    const id = await w.book();
    w.clock.advanceMinutes(28);
    await w.pay(id).expect(201);
    const ref = (await w.payments(id))[0]!.gateway_ref as string;

    w.clock.advanceMinutes(4); // 32 minutes after booking: past the 30-minute hold, but they paid 4 minutes ago
    await expireStalePending(w.db, w.clock.now(), await loadBookingSettings(w.db));
    expect((await w.view(id)).status).toBe('pending');

    const ok = w.event(ref);
    expect((await w.webhook(ok.raw, ok.headers).expect(200)).body.result).toBe('paid');
    expect((await w.view(id)).status).toBe('offered');
  });

  it('paying twice for one booking refunds the extra payment', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201);
    const [first] = await w.payments(id);
    w.clock.advanceMinutes(1);
    const second = await w.pay(id).expect(201);
    await request(w.app).post(second.body.redirectUrl).type('form').send({ outcome: 'success' }).expect(303); // second attempt pays

    // ...and then the abandoned first attempt's money turns up too
    const late = w.event(first!.gateway_ref as string, 'payment.succeeded', TOTAL, 'evt_late');
    expect((await w.webhook(late.raw, late.headers).expect(200)).body.result).toBe('paid_late_refunded');

    const rows = await w.payments(id);
    expect(rows.map((p) => p.status).sort()).toEqual(['held', 'refunded']);
    expect((await w.view(id)).status).toBe('offered');
    expect(w.gateway.refundCalls).toHaveLength(1);
  });
});

describe('refunds when a booking is cancelled', () => {
  it('the customer cancelling a paid, unassigned booking gets everything back', async () => {
    const w = await world();
    const id = await w.book();
    await payBooking(w.app, w.token, id);
    const res = await request(w.app).post(`/bookings/${id}/cancel`).set(bearer(w.token)).send({}).expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.payment).toMatchObject({ status: 'refunded', refundedCents: TOTAL, refundPending: false });
    expect(w.gateway.refundCalls).toHaveLength(1);
    expect((await w.refunds(id))[0]).toMatchObject({ amount_cents: TOTAL, status: 'succeeded', reason: 'customer_cancelled', created_by: null });
  });

  it('cancelling a confirmed booking in time refunds it too, but too close to the start it is refused and nothing moves', async () => {
    const w = await world();
    const a = await w.book('09:00');
    const b = await w.book('13:00');
    await payBooking(w.app, w.token, a);
    await payBooking(w.app, w.token, b);
    await request(w.app).post(`/provider/offers/${a}/accept`).set(bearer(w.providers[0]!.token)).expect(200);
    await request(w.app).post(`/provider/offers/${b}/accept`).set(bearer(w.providers[0]!.token)).expect(200);

    await request(w.app).post(`/bookings/${a}/cancel`).set(bearer(w.token)).send({}).expect(200);
    expect((await w.view(a)).payment.status).toBe('refunded');

    w.clock.set('2026-10-23T05:00:00Z'); // 13:00 MYT, the job at 13:00 is about to start
    const late = await request(w.app).post(`/bookings/${b}/cancel`).set(bearer(w.token)).send({});
    expect(late.status).toBe(400);
    expect((await w.view(b)).payment).toMatchObject({ status: 'paid', refundedCents: 0 });
    expect(w.gateway.refundCalls).toHaveLength(1);
  });

  it('cancelling an unpaid booking refunds nothing', async () => {
    const w = await world();
    const id = await w.book();
    await w.pay(id).expect(201); // started but never finished
    await request(w.app).post(`/bookings/${id}/cancel`).set(bearer(w.token)).send({}).expect(200);
    expect(w.gateway.refundCalls).toHaveLength(0);
    expect(await w.refunds(id)).toHaveLength(0);
  });

  it('an admin cancelling a paid booking refunds it', async () => {
    const w = await world();
    const id = await w.book();
    await payBooking(w.app, w.token, id);
    const res = await w.adminPost(`/admin/bookings/${id}/status`, { status: 'cancelled', reason: 'no_provider_available' }).expect(200);
    expect(res.body.payment).toMatchObject({ status: 'refunded', refundedCents: TOTAL });
    expect((await w.refunds(id))[0]).toMatchObject({ reason: 'no_provider_available' });
    expect((await w.refunds(id))[0]!.created_by).toBeTruthy(); // the admin who did it
  });

  it('cancelling twice cannot refund twice', async () => {
    const w = await world();
    const id = await w.book();
    await payBooking(w.app, w.token, id);
    await request(w.app).post(`/bookings/${id}/cancel`).set(bearer(w.token)).send({}).expect(200);
    await request(w.app).post(`/bookings/${id}/cancel`).set(bearer(w.token)).send({}).expect(409);
    await w.adminPost(`/admin/bookings/${id}/status`, { status: 'cancelled' }).expect(409);
    expect(w.gateway.refundCalls).toHaveLength(1);
  });

  it('if the gateway fails the refund, it is kept on record and an admin can retry it', async () => {
    const w = await world();
    const id = await w.book();
    await payBooking(w.app, w.token, id);
    w.gateway.failRefunds = true;
    const res = await request(w.app).post(`/bookings/${id}/cancel`).set(bearer(w.token)).send({}).expect(200);
    expect(res.body.payment).toMatchObject({ status: 'refunded', refundedCents: TOTAL, refundPending: true });
    expect((await w.refunds(id))[0]!.status).toBe('failed');

    const list = await request(w.app).get('/admin/bookings').set(bearer(w.admin)).expect(200);
    expect(list.body.bookings[0].payment).toMatchObject({ status: 'refunded', refundPending: true });

    w.gateway.failRefunds = false;
    const retry = await w.adminPost(`/admin/bookings/${id}/refund/retry`).expect(200);
    expect(retry.body.refunds).toEqual([expect.objectContaining({ amountCents: TOTAL, status: 'succeeded' })]);
    expect((await w.view(id)).payment.refundPending).toBe(false);
    // the same refund id is sent both times, so a real gateway can recognise the retry instead of paying out twice
    expect(w.gateway.refundCalls).toHaveLength(2);
    expect(w.gateway.refundCalls[0]!.refundId).toBe(w.gateway.refundCalls[1]!.refundId);
    await w.adminPost(`/admin/bookings/${id}/refund/retry`).expect(200);
    expect(w.gateway.refundCalls).toHaveLength(2); // nothing left to retry
  });
});

describe('admin refunds', () => {
  it('can refund part, then the rest, but never more than was paid', async () => {
    const w = await world();
    const id = await w.book();
    await payBooking(w.app, w.token, id);

    const part = await w.adminPost(`/admin/bookings/${id}/refund`, { amountCents: 1000, reason: 'goodwill' }).expect(200);
    expect(part.body).toMatchObject({ amountCents: 1000, status: 'succeeded' });
    expect(part.body.booking.payment).toMatchObject({ status: 'partially_refunded', refundedCents: 1000 });

    const tooMuch = await w.adminPost(`/admin/bookings/${id}/refund`, { amountCents: TOTAL });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toBe('refund_too_large');

    const rest = await w.adminPost(`/admin/bookings/${id}/refund`).expect(200);
    expect(rest.body.amountCents).toBe(TOTAL - 1000);
    expect(rest.body.booking.payment).toMatchObject({ status: 'refunded', refundedCents: TOTAL });

    expect((await w.adminPost(`/admin/bookings/${id}/refund`)).status).toBe(409);
    expect(w.gateway.refundCalls.map((c) => c.amountCents)).toEqual([1000, TOTAL - 1000]);
  });

  it('two refunds at the same moment cannot add up to more than was paid', async () => {
    const w = await world();
    const id = await w.book();
    await payBooking(w.app, w.token, id);
    const [a, b] = await Promise.all([
      w.adminPost(`/admin/bookings/${id}/refund`, { amountCents: 4000 }),
      w.adminPost(`/admin/bookings/${id}/refund`, { amountCents: 4000 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect((await w.payments(id))[0]!.refunded_cents).toBe(4000);
  });

  it('is admin-only, and an unpaid booking has nothing to refund', async () => {
    const w = await world();
    const id = await w.book();
    await request(w.app).post(`/admin/bookings/${id}/refund`).set(bearer(w.token)).send({}).expect(403);
    expect((await w.adminPost(`/admin/bookings/${id}/refund`)).status).toBe(409);
    await w.adminPost(`/admin/bookings/${id}/refund`, { amountCents: -5 }).expect(400);
    await request(w.app).post(`/admin/bookings/${id}/refund/retry`).set(bearer(w.token)).send({}).expect(403);
  });

  it('the admin booking list shows each booking\'s payment', async () => {
    const w = await world();
    const paid = await w.book('09:00');
    const unpaid = await w.book('13:00');
    await payBooking(w.app, w.token, paid);
    const list = (await request(w.app).get('/admin/bookings').set(bearer(w.admin)).expect(200)).body.bookings;
    expect(list.find((b: any) => b.id === paid).payment).toEqual({ status: 'held', refundedCents: 0, refundPending: false });
    expect(list.find((b: any) => b.id === unpaid).payment).toBeNull();
  });
});

describe('the pretend payment page', () => {
  it('shows the amount, escapes everything, and is gone once the payment is done', async () => {
    const w = await world();
    const id = await w.book();
    const started = await w.pay(id, 'fpx').expect(201);

    const page = await request(w.app).get(started.body.redirectUrl).expect(200);
    expect(page.text).toContain('RM 60.00');
    expect(page.text).toContain('No real money');
    expect(page.headers['cache-control']).toBe('no-store');

    await request(w.app).get('/fake-pay/fake_nope').expect(404);
    await request(w.app).post(started.body.redirectUrl).type('form').send({ outcome: 'explode' }).expect(400);

    await request(w.app).post(started.body.redirectUrl).type('form').send({ outcome: 'success' }).expect(303).expect('Location', `/#/bookings/${id}?pay=return`);
    const after = await request(w.app).get(started.body.redirectUrl).expect(200);
    expect(after.text).toContain('no longer waiting');
    // pressing the button again changes nothing
    await request(w.app).post(started.body.redirectUrl).type('form').send({ outcome: 'failed' }).expect(303);
    expect((await w.payments(id))[0]!.status).toBe('held');
  });
});

describe('configuration', () => {
  it('refuses to run production on the pretend gateway', () => {
    const base = {
      JWT_SECRET: 'x'.repeat(40),
      OTP_SECRET: 'y'.repeat(40),
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@localhost/db',
      SMTP_HOST: 'smtp.example.com',
      DATA_KEY: 'z'.repeat(40),
    };
    expect(() => loadConfig(base)).toThrow(/PAYMENT_GATEWAY/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'development' })).not.toThrow();
  });
});
