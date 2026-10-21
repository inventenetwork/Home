import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, loginAdmin, makeAddress, makeClock, makeProvider, setup } from './helpers.js';

// Fixed "now": Wed 21 Oct 2026, 08:00 in Malaysia. Fri 23 Oct is the day we book on.
const FRI = '2026-10-23';
const at = (hhmm: string, date = FRI) => `${date}T${hhmm}:00+08:00`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** App + one approved cleaner in PJ + a logged-in customer with a saved PJ address. */
async function world(overrides: { providers?: number } = {}) {
  const clock = makeClock();
  const ctx = await setup({}, { now: clock.now });
  const providers = [];
  for (let i = 0; i < (overrides.providers ?? 1); i++) {
    providers.push(await makeProvider(ctx.db, { email: `cleaner${i + 1}@example.com`, name: `Cleaner ${i + 1}` }));
  }
  const customer = await login(ctx.app, ctx.mailer, 'sam@example.com');
  const token = customer.body.accessToken as string;
  await ctx.db.query("UPDATE users SET full_name = 'Sam Tan' WHERE email = 'sam@example.com'");
  const addressId = await makeAddress(ctx.app, token);
  const book = (body: Record<string, unknown> = {}, t = token) =>
    request(ctx.app)
      .post('/bookings')
      .set(bearer(t))
      .send({ serviceSlug: 'home-cleaning', addressId, scheduledAt: at('09:00'), units: 2, ...body });
  return { ...ctx, clock, providers, token, addressId, book };
}

describe('areas and addresses', () => {
  it('lists the launch areas publicly', async () => {
    const { app } = await setup();
    const res = await request(app).get('/areas').expect(200);
    expect(res.body.areas.map((a: any) => a.slug).sort()).toEqual(['kepong', 'kuching', 'petaling-jaya', 'sibu', 'subang']);
  });

  it('saves, lists and deletes a user’s own addresses only', async () => {
    const { app, mailer } = await setup();
    const sam = (await login(app, mailer, 'sam@example.com')).body.accessToken;
    const ann = (await login(app, mailer, 'ann@example.com')).body.accessToken;

    await request(app).get('/addresses').expect(401);
    const created = await request(app).post('/addresses').set(bearer(sam))
      .send({ label: 'Home', line1: '12 Jalan SS2/24', postcode: '47300', areaSlug: 'petaling-jaya' }).expect(201);
    expect(created.body.area).toEqual({ slug: 'petaling-jaya', name: 'Petaling Jaya' });

    expect((await request(app).get('/addresses').set(bearer(sam))).body.addresses).toHaveLength(1);
    expect((await request(app).get('/addresses').set(bearer(ann))).body.addresses).toHaveLength(0);

    await request(app).delete(`/addresses/${created.body.id}`).set(bearer(ann)).expect(404);
    await request(app).delete(`/addresses/${created.body.id}`).set(bearer(sam)).expect(204);
  });

  it('rejects areas we do not serve and malformed postcodes', async () => {
    const { app, mailer } = await setup();
    const sam = (await login(app, mailer, 'sam@example.com')).body.accessToken;
    const bad = await request(app).post('/addresses').set(bearer(sam)).send({ line1: '1 Jalan Satu', postcode: '47300', areaSlug: 'penang' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('area_not_served');
    await request(app).post('/addresses').set(bearer(sam)).send({ line1: '1 Jalan Satu', postcode: '4730', areaSlug: 'kepong' }).expect(400);
  });
});

describe('slots', () => {
  it('offers every hourly start that finishes by 20:00 when a provider is free', async () => {
    const { app } = await world();
    const res = await request(app).get(`/services/home-cleaning/slots?date=${FRI}&area=petaling-jaya&units=2`).expect(200);
    expect(res.body.durationMinutes).toBe(120);
    expect(res.body.slots.map((s: any) => s.time)).toEqual(
      ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
    );
    expect(res.body.slots.every((s: any) => s.available)).toBe(true);
  });

  it('shows nothing available where no qualified provider works', async () => {
    const { app } = await world();
    const kuching = await request(app).get(`/services/home-cleaning/slots?date=${FRI}&area=kuching`).expect(200);
    expect(kuching.body.slots.every((s: any) => !s.available)).toBe(true);
    const aircon = await request(app).get(`/services/aircon-service/slots?date=${FRI}&area=petaling-jaya`).expect(200);
    expect(aircon.body.slots.every((s: any) => !s.available)).toBe(true); // our cleaner has no aircon skill
  });

  it('marks slots inside the 24-hour notice window as too soon', async () => {
    const { app } = await world();
    const today = await request(app).get('/services/home-cleaning/slots?date=2026-10-21&area=petaling-jaya').expect(200);
    expect(today.body.slots.every((s: any) => s.reason === 'too_soon')).toBe(true);
    const tomorrow = await request(app).get('/services/home-cleaning/slots?date=2026-10-22&area=petaling-jaya').expect(200);
    expect(tomorrow.body.slots[0]).toMatchObject({ time: '08:00', available: true }); // exactly 24h from now
  });

  it('respects a provider’s working hours and days off', async () => {
    const clock = makeClock();
    const { app, db } = await setup({}, { now: clock.now });
    await makeProvider(db, { email: 'p@example.com', windows: [{ weekday: 5, start: '10:00', end: '14:00' }] });
    const fri = await request(app).get(`/services/home-cleaning/slots?date=${FRI}&area=petaling-jaya&units=2`).expect(200);
    expect(fri.body.slots.filter((s: any) => s.available).map((s: any) => s.time)).toEqual(['10:00', '11:00', '12:00']);
    const sat = await request(app).get('/services/home-cleaning/slots?date=2026-10-24&area=petaling-jaya').expect(200);
    expect(sat.body.slots.every((s: any) => !s.available)).toBe(true);
  });

  it('validates its inputs', async () => {
    const { app } = await world();
    await request(app).get('/services/home-cleaning/slots?area=petaling-jaya').expect(400);
    await request(app).get('/services/home-cleaning/slots?date=2026-02-30&area=petaling-jaya').expect(400);
    await request(app).get('/services/home-cleaning/slots?date=2026-10-01&area=petaling-jaya').expect(400); // in the past
    await request(app).get('/services/home-cleaning/slots?date=2027-06-01&area=petaling-jaya').expect(400); // too far
    await request(app).get(`/services/home-cleaning/slots?date=${FRI}&area=nowhere`).expect(400);
    await request(app).get(`/services/home-cleaning/slots?date=${FRI}&area=petaling-jaya&units=1`).expect(400); // below 2h minimum
    await request(app).get(`/services/nope/slots?date=${FRI}&area=petaling-jaya`).expect(404);
  });
});

describe('creating a booking', () => {
  it('creates a pending booking with a server-calculated price snapshot', async () => {
    const { book, db } = await world();
    const res = await book({ options: [{ group: 'tools', code: 'bring_tools' }] }).expect(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      localDate: FRI,
      localTime: '09:00',
      durationMinutes: 120,
      units: 2,
      provider: null,
      service: { slug: 'home-cleaning', name: 'Home cleaning' },
      pricing: { subtotalCents: 11000, sstCents: 0, totalCents: 11000 }, // 2h x RM30 + RM50 equipment
    });
    expect(JSON.stringify(res.body)).not.toMatch(/commission|earnings/i);

    const row = (await db.query<any>('SELECT price_breakdown, commission_rate FROM bookings')).rows[0];
    expect(row.price_breakdown.commissionCents).toBe(2200);
    expect(row.price_breakdown.providerEarningsCents).toBe(8800);
    expect(Number(row.commission_rate)).toBe(0.2);
  });

  it('uses the right duration for fixed-length services', async () => {
    const { book } = await world();
    const ok = await book({ serviceSlug: 'deep-cleaning', units: undefined, scheduledAt: at('16:00') }).expect(201);
    expect(ok.body.durationMinutes).toBe(240);
    const late = await book({ serviceSlug: 'deep-cleaning', units: undefined, scheduledAt: at('17:00') });
    expect(late.body.error).toBe('outside_hours');
  });

  it('rejects bad times', async () => {
    const { book } = await world();
    expect((await book({ scheduledAt: at('09:30') })).body.error).toBe('invalid_slot');
    expect((await book({ scheduledAt: at('07:00') })).body.error).toBe('invalid_slot');
    expect((await book({ scheduledAt: '2026-10-23T09:00:30+08:00' })).body.error).toBe('invalid_slot'); // stray seconds
    expect((await book({ scheduledAt: at('20:00', '2026-10-21') })).body.error).toBe('too_soon');
    expect((await book({ scheduledAt: at('09:00', '2027-01-04') })).body.error).toBe('too_far');
    expect((await book({ units: 6, scheduledAt: at('17:00') })).body.error).toBe('outside_hours');
    expect((await book({ scheduledAt: 'tomorrow morning' })).status).toBe(400);
  });

  it('never accepts a price from the client', async () => {
    const { book } = await world();
    expect((await book({ totalCents: 1 })).status).toBe(400);
    expect((await book({ subtotalCents: 1, pricing: { totalCents: 1 } })).status).toBe(400);
  });

  it('applies pricing rules', async () => {
    const { book } = await world();
    expect((await book({ units: 1 })).body.error).toBe('units_below_minimum');
    expect((await book({ options: [{ group: 'tools', code: 'nope' }] })).body.error).toBe('unknown_option');
  });

  it('rejects unknown services, quote-only services and other people’s addresses', async () => {
    const { book, db, app, mailer } = await world();
    expect((await book({ serviceSlug: 'nope' })).status).toBe(404);

    await db.query("UPDATE services SET active = true WHERE slug = 'grass-cutting'");
    expect((await book({ serviceSlug: 'grass-cutting' })).body.error).toBe('quote_required');

    const ann = (await login(app, mailer, 'ann@example.com')).body.accessToken;
    expect((await book({}, ann)).body.error).toBe('address_not_found');
  });

  it('refuses when no qualified provider is free', async () => {
    const { book } = await world();
    const res = await book({ serviceSlug: 'aircon-service', units: 1 }); // cleaner has no aircon skill
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('slot_unavailable');
  });

  it('does not double-book a single provider, including the 30-minute buffer', async () => {
    const { book } = await world();
    await book().expect(201); // 09:00-11:00
    expect((await book()).status).toBe(409); // same time
    expect((await book({ scheduledAt: at('10:00') })).status).toBe(409); // overlaps
    expect((await book({ scheduledAt: at('11:00') })).status).toBe(409); // inside the buffer
    await book({ scheduledAt: at('12:00') }).expect(201); // clear of the buffer
    await book({ scheduledAt: at('08:00', '2026-10-24') }).expect(201); // another day
  });

  it('lets two providers take two bookings at the same time, but not three', async () => {
    const { book } = await world({ providers: 2 });
    await book().expect(201);
    await book().expect(201);
    expect((await book()).status).toBe(409);
  });

  it('releases an unpaid booking’s slot after 30 minutes', async () => {
    const { book, clock, app, token } = await world();
    const first = await book().expect(201);
    expect((await book()).status).toBe(409);

    clock.advanceMinutes(31);
    await book().expect(201);
    const old = await request(app).get(`/bookings/${first.body.id}`).set(bearer(token)).expect(200);
    expect(old.body).toMatchObject({ status: 'cancelled', cancelledReason: 'payment_timeout' });
  });

  it('shows slots as taken once booked', async () => {
    const { book, app } = await world();
    await book().expect(201); // 09:00-11:00
    const res = await request(app).get(`/services/home-cleaning/slots?date=${FRI}&area=petaling-jaya&units=2`);
    const open = res.body.slots.filter((s: any) => s.available).map((s: any) => s.time);
    expect(open).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
  });
});

describe('viewing and cancelling', () => {
  it('shows a customer only their own bookings, with a one-tap rebook payload', async () => {
    const { book, app, token, addressId, mailer } = await world();
    const created = await book({ options: [{ group: 'tools', code: 'bring_tools' }] }).expect(201);

    const mine = await request(app).get('/bookings').set(bearer(token)).expect(200);
    expect(mine.body.bookings).toHaveLength(1);
    expect(mine.body.bookings[0].rebook).toEqual({
      serviceSlug: 'home-cleaning',
      addressId,
      units: 2,
      options: [{ group: 'tools', code: 'bring_tools' }],
    });

    const ann = (await login(app, mailer, 'ann@example.com')).body.accessToken;
    await request(app).get(`/bookings/${created.body.id}`).set(bearer(ann)).expect(404);
    expect((await request(app).get('/bookings').set(bearer(ann))).body.bookings).toHaveLength(0);
    await request(app).get('/bookings').expect(401);
  });

  it('lets a customer cancel an unpaid booking, frees the slot, and cannot cancel twice', async () => {
    const { book, app, token } = await world();
    const created = await book().expect(201);

    const cancelled = await request(app).post(`/bookings/${created.body.id}/cancel`).set(bearer(token)).send({ reason: 'plans changed' }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelledReason: 'plans changed' });

    const again = await request(app).post(`/bookings/${created.body.id}/cancel`).set(bearer(token)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('invalid_transition');

    await book().expect(201); // slot is free again
  });

  it('does not let another customer cancel it', async () => {
    const { book, app, mailer } = await world();
    const created = await book().expect(201);
    const ann = (await login(app, mailer, 'ann@example.com')).body.accessToken;
    await request(app).post(`/bookings/${created.body.id}/cancel`).set(bearer(ann)).send({}).expect(404);
  });

  it('stops customers cancelling a confirmed booking inside the 12-hour window', async () => {
    const { book, app, token, db, mailer, providers, clock } = await world();
    const admin = await loginAdmin(app, mailer, db);
    const created = await book().expect(201); // Fri 09:00
    await request(app).post(`/admin/bookings/${created.body.id}/assign`).set(bearer(admin)).send({ providerId: providers[0]!.providerId }).expect(200);

    clock.set('2026-10-22T23:00:00+08:00'); // 10 hours before
    const late = await request(app).post(`/bookings/${created.body.id}/cancel`).set(bearer(token)).send({});
    expect(late.status).toBe(400);
    expect(late.body.error).toBe('too_late_to_cancel');

    clock.set('2026-10-22T20:00:00+08:00'); // 13 hours before
    await request(app).post(`/bookings/${created.body.id}/cancel`).set(bearer(token)).send({}).expect(200);
  });
});

describe('admin assignment and the provider job flow', () => {
  it('assigns a provider, who then works the job through to completion', async () => {
    const { book, app, db, mailer, providers, token } = await world();
    const admin = await loginAdmin(app, mailer, db);
    const created = await book().expect(201); // 2h x RM30 = RM60, provider earns 80% = RM48

    const assigned = await request(app).post(`/admin/bookings/${created.body.id}/assign`).set(bearer(admin))
      .send({ providerId: providers[0]!.providerId }).expect(200);
    expect(assigned.body).toMatchObject({ status: 'confirmed', provider: { name: 'Cleaner 1' } });

    const cleaner = (await login(app, mailer, 'cleaner1@example.com')).body.accessToken;
    const jobs = await request(app).get('/provider/jobs').set(bearer(cleaner)).expect(200);
    expect(jobs.body.jobs).toHaveLength(1);
    expect(jobs.body.jobs[0]).toMatchObject({
      status: 'confirmed',
      localTime: '09:00',
      earningsCents: 4800,
      customerFirstName: 'Sam',
      address: { line1: '12 Jalan SS2/24', area: 'Petaling Jaya' },
    });
    expect(JSON.stringify(jobs.body)).not.toMatch(/phone|email/i);

    const step = (status: string) => request(app).post(`/provider/jobs/${created.body.id}/status`).set(bearer(cleaner)).send({ status });
    expect((await step('completed')).status).toBe(409); // cannot skip ahead
    expect((await step('in_progress')).status).toBe(409);
    await step('on_the_way').expect(200);
    await step('in_progress').expect(200);
    await step('completed').expect(200);

    const done = await request(app).get(`/bookings/${created.body.id}`).set(bearer(token)).expect(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.checkedInAt).toBeTruthy();
    expect(done.body.checkedOutAt).toBeTruthy();
    const p = await db.query<{ jobs_completed: number }>('SELECT jobs_completed FROM providers WHERE id = $1', [providers[0]!.providerId]);
    expect(p.rows[0]!.jobs_completed).toBe(1);

    expect((await step('on_the_way')).status).toBe(409); // finished jobs are final
  });

  it('keeps jobs private to the assigned provider', async () => {
    const { book, app, db, mailer, providers } = await world({ providers: 2 });
    const admin = await loginAdmin(app, mailer, db);
    const created = await book().expect(201);
    await request(app).post(`/admin/bookings/${created.body.id}/assign`).set(bearer(admin)).send({ providerId: providers[0]!.providerId }).expect(200);

    const other = (await login(app, mailer, 'cleaner2@example.com')).body.accessToken;
    expect((await request(app).get('/provider/jobs').set(bearer(other))).body.jobs).toHaveLength(0);
    await request(app).post(`/provider/jobs/${created.body.id}/status`).set(bearer(other)).send({ status: 'on_the_way' }).expect(404);
  });

  it('keeps the provider area closed to customers and to unapproved providers', async () => {
    const { app, db, mailer, token } = await world();
    await request(app).get('/provider/jobs').expect(401);
    await request(app).get('/provider/jobs').set(bearer(token)).expect(403);

    await makeProvider(db, { email: 'new@example.com', approved: false });
    const pending = (await login(app, mailer, 'new@example.com')).body.accessToken;
    const res = await request(app).get('/provider/jobs').set(bearer(pending));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('provider_not_approved');
  });

  it('only lets admins assign, and only eligible, free providers', async () => {
    const { book, app, db, mailer, providers, token } = await world({ providers: 2 });
    const admin = await loginAdmin(app, mailer, db);
    const first = await book().expect(201);
    const second = await book().expect(201); // same time, handled by the second provider

    const assign = (bookingId: string, providerId: string, t = admin) =>
      request(app).post(`/admin/bookings/${bookingId}/assign`).set(bearer(t)).send({ providerId });

    expect((await assign(first.body.id, providers[0]!.providerId, token)).status).toBe(403);
    await assign(first.body.id, providers[0]!.providerId).expect(200);

    const busy = await assign(second.body.id, providers[0]!.providerId);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('provider_unavailable');
    await assign(second.body.id, providers[1]!.providerId).expect(200);

    // unapproved and out-of-area providers are refused
    const unapproved = await makeProvider(db, { email: 'u@example.com', approved: false });
    const kuching = await makeProvider(db, { email: 'k@example.com', areas: ['kuching'] });
    const third = await book({ scheduledAt: at('15:00') }); // both approved providers are free again by then
    expect(third.status).toBe(201);
    expect((await assign(third.body.id, unapproved.providerId)).body.error).toBe('provider_not_eligible');
    expect((await assign(third.body.id, kuching.providerId)).body.error).toBe('provider_not_eligible');
  });

  it('can reassign a confirmed booking to another provider', async () => {
    const { book, app, db, mailer, providers } = await world({ providers: 2 });
    const admin = await loginAdmin(app, mailer, db);
    const created = await book().expect(201);
    const assign = (providerId: string) => request(app).post(`/admin/bookings/${created.body.id}/assign`).set(bearer(admin)).send({ providerId });
    await assign(providers[0]!.providerId).expect(200);
    const res = await assign(providers[1]!.providerId).expect(200);
    expect(res.body.provider.name).toBe('Cleaner 2');
    const rows = await db.query('SELECT 1 FROM booking_assignments WHERE booking_id = $1', [created.body.id]);
    expect(rows.rowCount).toBe(1);
  });

  it('writes assignments and status overrides to the audit log', async () => {
    const { book, app, db, mailer, providers } = await world();
    const admin = await loginAdmin(app, mailer, db);
    const created = await book().expect(201);
    await request(app).post(`/admin/bookings/${created.body.id}/assign`).set(bearer(admin)).send({ providerId: providers[0]!.providerId }).expect(200);
    await request(app).post(`/admin/bookings/${created.body.id}/status`).set(bearer(admin)).send({ status: 'cancelled', reason: 'customer called' }).expect(200);
    const log = await db.query<{ action: string }>("SELECT action FROM audit_log WHERE entity = 'booking' ORDER BY created_at");
    expect(log.rows.map((r) => r.action)).toEqual(['booking.assign', 'booking.status']);
  });

  it('refuses status changes the machine does not allow, even for admins', async () => {
    const { book, app, db, mailer } = await world();
    const admin = await loginAdmin(app, mailer, db);
    const created = await book().expect(201);
    await request(app).post(`/admin/bookings/${created.body.id}/status`).set(bearer(admin)).send({ status: 'completed' }).expect(409);
    await request(app).post(`/admin/bookings/${created.body.id}/status`).set(bearer(admin)).send({ status: 'cancelled' }).expect(200);
    await request(app).post(`/admin/bookings/${created.body.id}/status`).set(bearer(admin)).send({ status: 'pending' }).expect(409);
    await request(app).post(`/admin/bookings/${created.body.id}/status`).set(bearer(admin)).send({ status: 'bogus' }).expect(400);
  });

  it('lists bookings for admins, filterable by status', async () => {
    const { book, app, db, mailer, token } = await world();
    const admin = await loginAdmin(app, mailer, db);
    await book().expect(201);
    await request(app).get('/admin/bookings').set(bearer(token)).expect(403);

    const all = await request(app).get('/admin/bookings').set(bearer(admin)).expect(200);
    expect(all.body.bookings).toHaveLength(1);
    expect(all.body.bookings[0]).toMatchObject({ status: 'pending', service: 'home-cleaning', area: 'petaling-jaya', customerEmail: 'sam@example.com' });
    expect((await request(app).get('/admin/bookings?status=cancelled').set(bearer(admin))).body.bookings).toHaveLength(0);
    await request(app).get('/admin/bookings?status=bogus').set(bearer(admin)).expect(400);
  });

  it('refuses to delete an address that has bookings', async () => {
    const { book, app, token, addressId } = await world();
    await book().expect(201);
    const res = await request(app).delete(`/addresses/${addressId}`).set(bearer(token));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('address_in_use');
  });
});
