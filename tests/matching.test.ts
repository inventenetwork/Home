import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, loginAdmin, makeAddress, makeClock, makeProvider, payBooking, setup } from './helpers.js';

// Fixed "now": Wed 21 Oct 2026, 08:00 Malaysia time. Bookings are on Fri 23 Oct.
const FRI = '2026-10-23';
const at = (hhmm: string) => `${FRI}T${hhmm}:00+08:00`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** N approved cleaners in PJ (with the given ratings), a customer with an address, and an admin. */
async function world(ratings: Array<[number, number]> = [[0, 0]]) {
  const clock = makeClock();
  const ctx = await setup({}, { now: clock.now });
  const providers: Array<{ userId: string; providerId: string; email: string; token: string }> = [];
  for (const [i, [avg, count]] of ratings.entries()) {
    const email = `cleaner${i + 1}@example.com`;
    const p = await makeProvider(ctx.db, { email, name: `Cleaner ${i + 1}` });
    await ctx.db.query('UPDATE providers SET rating_avg = $2, rating_count = $3 WHERE id = $1', [p.providerId, avg, count]);
    const token = (await login(ctx.app, ctx.mailer, email)).body.accessToken as string;
    providers.push({ ...p, email, token });
  }
  const customer = (await login(ctx.app, ctx.mailer, 'sam@example.com')).body;
  const token = customer.accessToken as string;
  const addressId = await makeAddress(ctx.app, token);
  const admin = await loginAdmin(ctx.app, ctx.mailer, ctx.db);

  const book = async (time = '09:00', units = 2, notes = 'Gate code 4321') => {
    const res = await request(ctx.app).post('/bookings').set(bearer(token))
      .send({ serviceSlug: 'home-cleaning', addressId, scheduledAt: at(time), units, notes });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  /** The customer pays through the (fake) gateway; its webhook starts the matching. */
  const markPaid = async (id: string) => {
    await payBooking(ctx.app, token, id);
  };
  const offers = (p: { token: string }) => request(ctx.app).get('/provider/offers').set(bearer(p.token));
  const accept = (p: { token: string }, id: string) => request(ctx.app).post(`/provider/offers/${id}/accept`).set(bearer(p.token));
  const decline = (p: { token: string }, id: string) => request(ctx.app).post(`/provider/offers/${id}/decline`).set(bearer(p.token));
  const adminList = (q = '') => request(ctx.app).get(`/admin/bookings${q}`).set(bearer(admin));
  const view = async (id: string) => (await request(ctx.app).get(`/bookings/${id}`).set(bearer(token))).body;
  const offerRows = async (id: string) =>
    (await ctx.db.query<{ provider_id: string; status: string }>('SELECT provider_id, status FROM job_offers WHERE booking_id = $1', [id])).rows;
  return { ...ctx, clock, providers, token, addressId, admin, book, markPaid, offers, accept, decline, adminList, view, offerRows };
}

describe('sending offers', () => {
  it('after payment, offers the job to the 3 best free providers and moves the booking to "offered"', async () => {
    // ratings: c1 3.0, c2 5.0, c3 4.0, c4 4.8, c5 3.5  -> best three are c2, c4, c3
    const w = await world([[3, 10], [5, 10], [4, 10], [4.8, 10], [3.5, 10]]);
    const id = await w.book();
    await w.markPaid(id);
    expect((await w.view(id)).status).toBe('offered');

    const rows = await w.offerRows(id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.provider_id).sort()).toEqual([w.providers[1]!.providerId, w.providers[2]!.providerId, w.providers[3]!.providerId].sort());
    expect(rows.every((r) => r.status === 'offered')).toBe(true);

    const counters = await w.db.query<{ offers_received: number }>('SELECT offers_received FROM providers WHERE id = $1', [w.providers[1]!.providerId]);
    expect(counters.rows[0]!.offers_received).toBe(1);
  });

  it('only offers to providers who are actually free at that time', async () => {
    const w = await world([[5, 10], [4, 10]]);
    // cleaner1 already has a 09:00-11:00 job, so a 10:00 booking can only go to cleaner2
    const first = await w.book('09:00');
    await w.markPaid(first);
    await w.accept(w.providers[0]!, first).expect(200);

    const second = await w.book('10:00');
    await w.markPaid(second);
    expect(await w.offerRows(second)).toHaveLength(1);
    expect((await w.offerRows(second))[0]!.provider_id).toBe(w.providers[1]!.providerId);
  });

  it('shows providers the area and pay but not the street address or notes, until they accept', async () => {
    const w = await world([[0, 0]]);
    const id = await w.book('09:00', 2, 'Gate code 4321');
    await w.markPaid(id);
    const list = await w.offers(w.providers[0]!).expect(200);
    expect(list.body.offers).toHaveLength(1);
    const o = list.body.offers[0];
    expect(o).toMatchObject({ bookingId: id, service: 'Home cleaning', area: 'Petaling Jaya', localTime: '09:00', durationMinutes: 120, secondsLeft: 900 });
    expect(o.earningsCents).toBe(4800); // 2h x RM30 = RM60, minus 20% commission
    expect(JSON.stringify(o)).not.toMatch(/Jalan|4321|47300/);

    await w.accept(w.providers[0]!, id).expect(200);
    const jobs = await request(w.app).get('/provider/jobs').set(bearer(w.providers[0]!.token)).expect(200);
    expect(jobs.body.jobs[0].address.line1).toContain('Jalan');
    expect(jobs.body.jobs[0].notes).toBe('Gate code 4321');
  });
});

describe('accepting and declining', () => {
  it('first provider to accept gets the job; everyone else is told it was taken; the customer sees who is coming', async () => {
    const w = await world([[5, 10], [4.8, 10], [4, 10]]);
    const id = await w.book();
    await w.markPaid(id);

    await w.accept(w.providers[1]!, id).expect(200);
    const late = await w.accept(w.providers[0]!, id);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('offer_taken');

    const rows = await w.offerRows(id);
    expect(rows.find((r) => r.provider_id === w.providers[1]!.providerId)!.status).toBe('accepted');
    expect(rows.filter((r) => r.status === 'withdrawn')).toHaveLength(2);
    expect((await w.offers(w.providers[0]!)).body.offers).toHaveLength(0);

    const v = await w.view(id);
    expect(v.status).toBe('confirmed');
    expect(v.provider.name).toBe('Cleaner 2');
    const counters = await w.db.query<{ offers_accepted: number }>('SELECT offers_accepted FROM providers WHERE id = $1', [w.providers[1]!.providerId]);
    expect(counters.rows[0]!.offers_accepted).toBe(1);
  });

  it('when two providers tap Accept at the same moment, exactly one wins', async () => {
    const w = await world([[5, 10], [4.8, 10]]);
    const id = await w.book();
    await w.markPaid(id);
    const [a, b] = await Promise.all([w.accept(w.providers[0]!, id), w.accept(w.providers[1]!, id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const assigned = await w.db.query('SELECT 1 FROM booking_assignments WHERE booking_id = $1', [id]);
    expect(assigned.rowCount).toBe(1);
  });

  it('a declined offer disappears and cannot be accepted later', async () => {
    const w = await world([[5, 10], [4, 10]]);
    const id = await w.book();
    await w.markPaid(id);
    await w.decline(w.providers[0]!, id).expect(200);
    expect((await w.offers(w.providers[0]!)).body.offers).toHaveLength(0);
    expect((await w.accept(w.providers[0]!, id)).status).toBe(404);
    await w.decline(w.providers[0]!, id).expect(404); // nothing left to decline
    // the other provider can still take it
    await w.accept(w.providers[1]!, id).expect(200);
  });

  it('a provider cannot accept a job nobody offered them', async () => {
    const w = await world([[5, 10], [4.5, 10], [4, 10], [3, 10]]); // clearly separated, so the order is certain
    const id = await w.book();
    await w.markPaid(id);
    const outsider = w.providers[3]!; // only three offers go out; the lowest-ranked gets none
    expect((await w.accept(outsider, id)).status).toBe(404);
    expect((await w.offers(outsider)).body.offers).toHaveLength(0);
    await request(w.app).post('/provider/offers/not-a-uuid/accept').set(bearer(outsider.token)).expect(404);
  });

  it('customers cannot use the provider endpoints', async () => {
    const w = await world([[5, 10]]);
    await request(w.app).get('/provider/offers').set(bearer(w.token)).expect(403);
    await request(w.app).get('/provider/offers').expect(401);
  });

  it('refuses a second job that overlaps one the provider just accepted', async () => {
    const w = await world([[5, 10], [4, 10]]);
    const a = await w.book('09:00');
    const b = await w.book('10:00');
    await w.markPaid(a);
    await w.markPaid(b);
    // both providers are offered both jobs
    await w.accept(w.providers[0]!, a).expect(200);
    const clash = await w.accept(w.providers[0]!, b);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('provider_unavailable');
    await w.accept(w.providers[1]!, b).expect(200);
  });
});

describe('timeouts and the admin fallback', () => {
  it('offers expire after 15 minutes; the booking then needs an admin, who can assign someone', async () => {
    const w = await world([[5, 10], [4, 10]]);
    const id = await w.book();
    await w.markPaid(id);
    expect((await w.adminList('?attention=1')).body.bookings).toHaveLength(0); // offers still open

    w.clock.advanceMinutes(14);
    expect((await w.offers(w.providers[0]!)).body.offers).toHaveLength(1);
    w.clock.advanceMinutes(2); // 16 minutes in

    expect((await w.offers(w.providers[0]!)).body.offers).toHaveLength(0);
    const late = await w.accept(w.providers[0]!, id);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('offer_expired');

    const att = await w.adminList('?attention=1').expect(200);
    expect(att.body.bookings).toHaveLength(1);
    expect(att.body.bookings[0]).toMatchObject({ id, status: 'offered', needsAttention: true, offers: { open: 0, declined: 0, expired: 2 } });

    const cands = await request(w.app).get(`/admin/bookings/${id}/candidates`).set(bearer(w.admin)).expect(200);
    expect(cands.body.candidates.map((c: any) => c.email)).toEqual(['cleaner1@example.com', 'cleaner2@example.com']);

    await request(w.app).post(`/admin/bookings/${id}/assign`).set(bearer(w.admin)).send({ providerId: w.providers[1]!.providerId }).expect(200);
    expect((await w.view(id)).status).toBe('confirmed');
    expect((await w.adminList('?attention=1')).body.bookings).toHaveLength(0);
  });

  it('when every provider declines, the booking needs an admin straight away', async () => {
    const w = await world([[5, 10], [4, 10]]);
    const id = await w.book();
    await w.markPaid(id);
    await w.decline(w.providers[0]!, id);
    expect((await w.adminList('?attention=1')).body.bookings).toHaveLength(0); // one offer still open
    await w.decline(w.providers[1]!, id);
    const att = (await w.adminList('?attention=1')).body.bookings;
    expect(att).toHaveLength(1);
    expect(att[0].offers).toEqual({ open: 0, declined: 2, expired: 0 });
  });

  it('when nobody is free at payment time, the booking is offered with no offers and flagged for the admin', async () => {
    const w = await world([[5, 10]]);
    const id = await w.book();
    await w.db.query('DELETE FROM provider_availability WHERE provider_id = $1', [w.providers[0]!.providerId]); // provider went off duty
    await w.markPaid(id);
    expect((await w.view(id)).status).toBe('offered');
    expect(await w.offerRows(id)).toHaveLength(0);
    expect((await w.adminList('?attention=1')).body.bookings.map((b: any) => b.id)).toEqual([id]);
  });

  it('assigning or cancelling closes any offers still open', async () => {
    const w = await world([[5, 10], [4, 10]]);
    const a = await w.book('09:00');
    const b = await w.book('13:00');
    await w.markPaid(a);
    await w.markPaid(b);

    await request(w.app).post(`/admin/bookings/${a}/assign`).set(bearer(w.admin)).send({ providerId: w.providers[0]!.providerId }).expect(200);
    expect((await w.offerRows(a)).every((r) => r.status === 'withdrawn')).toBe(true);

    await request(w.app).post(`/bookings/${b}/cancel`).set(bearer(w.token)).send({}).expect(200);
    expect((await w.offerRows(b)).every((r) => r.status === 'withdrawn')).toBe(true);
    expect((await w.offers(w.providers[0]!)).body.offers).toHaveLength(0);
    expect((await w.accept(w.providers[1]!, b)).status).toBe(409);
  });

  it('a cancelled booking cannot be accepted', async () => {
    const w = await world([[5, 10]]);
    const id = await w.book();
    await w.markPaid(id);
    await request(w.app).post(`/bookings/${id}/cancel`).set(bearer(w.token)).send({}).expect(200);
    const res = await w.accept(w.providers[0]!, id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('booking_cancelled');
  });

  it('the attention list and candidates are admin-only', async () => {
    const w = await world([[5, 10]]);
    await request(w.app).get('/admin/bookings?attention=1').set(bearer(w.token)).expect(403);
    await request(w.app).get('/admin/bookings/00000000-0000-0000-0000-000000000000/candidates').set(bearer(w.token)).expect(403);
  });
});

describe('after acceptance', () => {
  it('the provider can work the job through to completion', async () => {
    const w = await world([[5, 10]]);
    const id = await w.book();
    await w.markPaid(id);
    await w.accept(w.providers[0]!, id).expect(200);
    for (const status of ['on_the_way', 'in_progress', 'completed']) {
      await request(w.app).post(`/provider/jobs/${id}/status`).set(bearer(w.providers[0]!.token)).send({ status }).expect(200);
    }
    expect((await w.view(id)).status).toBe('completed');
  });
});
