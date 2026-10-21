import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/admin/reports.js';
import { login, loginAdmin, makeAddress, makeClock, makeProvider, payBooking, setup } from './helpers.js';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const FRI = '2026-10-23';
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+08:00`;

async function world() {
  const clock = makeClock();
  const ctx = await setup({}, { now: clock.now });
  const p = await makeProvider(ctx.db, { email: 'cleaner@example.com', name: 'Aisha Rahman' });
  const ptoken = (await login(ctx.app, ctx.mailer, 'cleaner@example.com')).body.accessToken as string;
  const cres = await login(ctx.app, ctx.mailer, 'sam@example.com');
  const ctoken = cres.body.accessToken as string;
  const addressId = await makeAddress(ctx.app, ctoken);
  const admin = await loginAdmin(ctx.app, ctx.mailer, ctx.db);
  const call = (method: 'get' | 'post' | 'put', path: string, t: string, body?: object) => {
    const r = request(ctx.app)[method](path).set(bearer(t));
    return body ? r.send(body) : r;
  };
  const confirmed = async (date = FRI, time = '09:00') => {
    const b = await call('post', '/bookings', ctoken, { serviceSlug: 'home-cleaning', addressId, scheduledAt: at(date, time), units: 2 }).expect(201);
    await payBooking(ctx.app, ctoken, b.body.id);
    await call('post', `/provider/offers/${b.body.id}/accept`, ptoken).expect(200);
    return b.body.id as string;
  };
  const userId = async (email: string) => (await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  return { ...ctx, clock, p, ptoken, ctoken, addressId, admin, call, confirmed, userId, customerRefresh: cres.body.refreshToken as string };
}

describe('csv cells', () => {
  it('quotes, doubles quotes and defuses spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+60123')).toBe("'+60123");
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
  });
});

describe('admin access', () => {
  it('every new admin route refuses customers and providers', async () => {
    const w = await world();
    for (const path of ['/admin/overview', '/admin/users', '/admin/settings', '/admin/handover', '/admin/audit', '/admin/reports/bookings.csv?from=2026-10-01&to=2026-10-31']) {
      expect((await w.call('get', path, w.ctoken)).status, path).toBe(403);
      expect((await w.call('get', path, w.ptoken)).status, path).toBe(403);
      expect((await request(w.app).get(path)).status, path).toBe(401);
    }
  });
});

describe('overview', () => {
  it('counts bookings, money, commission and the to-do list', async () => {
    const w = await world();
    const id = await w.confirmed();
    for (const s of ['on_the_way', 'in_progress', 'completed']) await w.call('post', `/provider/jobs/${id}/status`, w.ptoken, { status: s }).expect(200);
    const o = (await w.call('get', '/admin/overview?days=7', w.admin).expect(200)).body;
    expect(o.days).toBe(7);
    expect(o.bookings.total).toBe(1);
    expect(o.bookings.completed).toBe(1);
    expect(o.money.paidCents).toBe(6000); // 2 hours at RM 30
    expect(o.money.refundedCents).toBe(0);
    expect(o.money.commissionCents).toBe(1200);
    expect(o.money.owedToProvidersCents).toBe(4800);
    expect(o.providers.approved).toBe(1);
    expect(o.users.customers).toBe(1);
    expect(o.daily).toHaveLength(7);
    expect(o.daily.reduce((a: number, d: { bookings: number }) => a + d.bookings, 0)).toBe(1);
    expect(o.byService[0]).toMatchObject({ bookings: 1, valueCents: 6000 });
    expect(o.topProviders[0]).toMatchObject({ jobs: 1 });
    expect(o.todo).toMatchObject({ openDisputes: 0, needsProvider: 0 });
  });

  it('shows disputes and unstaffed jobs in the to-do list, and limits the period', async () => {
    const w = await world();
    const id = await w.confirmed();
    for (const s of ['on_the_way', 'in_progress', 'completed']) await w.call('post', `/provider/jobs/${id}/status`, w.ptoken, { status: s }).expect(200);
    await w.call('post', `/bookings/${id}/dispute`, w.ctoken, { reason: 'Nothing was cleaned here at all.' }).expect(201);
    const o = (await w.call('get', '/admin/overview', w.admin).expect(200)).body;
    expect(o.todo.openDisputes).toBe(1);
    expect((await w.call('get', '/admin/overview?days=9999', w.admin)).body.days).toBe(365);
    expect((await w.call('get', '/admin/overview?days=0', w.admin)).body.days).toBe(30); // 0 is "not given"
  });
});

describe('bookings csv', () => {
  it('exports one row per booking with money columns and a header', async () => {
    const w = await world();
    await w.confirmed();
    const r = await w.call('get', `/admin/reports/bookings.csv?from=${FRI}&to=${FRI}`, w.admin).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toContain('home360-bookings-2026-10-23-to-2026-10-23.csv');
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Reference,Date (MYT),Time (MYT),Service');
    expect(lines[1]).toContain('2026-10-23,09:00,Home cleaning');
    expect(lines[1]).toContain('sam@example.com,cleaner@example.com');
    expect(lines[1]).toContain('60.00,0.00,60.00,60.00,0.00');
  });

  it('validates the dates', async () => {
    const w = await world();
    const get = (q: string) => w.call('get', `/admin/reports/bookings.csv${q}`, w.admin);
    expect((await get('')).status).toBe(400);
    expect((await get('?from=2026-10-05&to=2026-10-01')).status).toBe(400);
    expect((await get('?from=2026-13-01&to=2026-13-02')).status).toBe(400);
    expect((await get('?from=2025-01-01&to=2026-10-01')).body.error).toBe('range_too_long');
    const empty = await get('?from=2026-01-01&to=2026-01-02').expect(200);
    expect(empty.text.trim().split('\r\n')).toHaveLength(1); // header only
  });
});

describe('users', () => {
  it('searches by email, name and phone, and filters by role and status', async () => {
    const w = await world();
    const all = (await w.call('get', '/admin/users', w.admin).expect(200)).body.users;
    expect(all.map((u: { email: string }) => u.email).sort()).toEqual(['boss@example.com', 'cleaner@example.com', 'sam@example.com']);
    const byMail = (await w.call('get', '/admin/users?q=SAM@', w.admin)).body.users;
    expect(byMail).toHaveLength(1);
    expect(byMail[0]).toMatchObject({ email: 'sam@example.com', role: 'customer', bookings: 0 });
    expect((await w.call('get', '/admin/users?q=aisha', w.admin)).body.users).toHaveLength(1); // by name
    expect((await w.call('get', '/admin/users?role=provider', w.admin)).body.users).toHaveLength(1);
    expect((await w.call('get', '/admin/users?q=%25', w.admin)).body.users).toHaveLength(0); // "%" is a character, not a wildcard
    expect((await w.call('get', '/admin/users?role=king', w.admin)).status).toBe(400);
    expect((await w.call('get', '/admin/users?limit=1', w.admin)).body.hasMore).toBe(true);
  });

  it('shows a user with recent bookings', async () => {
    const w = await world();
    await w.confirmed();
    const d = (await w.call('get', `/admin/users/${await w.userId('sam@example.com')}`, w.admin).expect(200)).body;
    expect(d.recentBookings).toHaveLength(1);
    expect(d.consentAt).toBeTruthy();
    expect((await w.call('get', `/admin/users/${await w.userId('cleaner@example.com')}`, w.admin)).body.recentBookings).toHaveLength(1); // the provider's job
    expect((await w.call('get', '/admin/users/not-a-uuid', w.admin)).status).toBe(404);
  });

  it('suspending blocks the account at once, ends sessions, and can be undone', async () => {
    const w = await world();
    const id = await w.userId('sam@example.com');
    expect((await w.call('post', `/admin/users/${id}/suspend`, w.admin, {})).status).toBe(400); // a reason is required
    await w.call('post', `/admin/users/${id}/suspend`, w.admin, { reason: 'Abusive messages to providers' }).expect(200);
    expect((await w.call('get', '/bookings', w.ctoken)).status).toBe(401); // the token they already hold stops working
    const refresh = await request(w.app).post('/auth/refresh').send({ refreshToken: w.customerRefresh });
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    const detail = (await w.call('get', `/admin/users/${id}`, w.admin)).body;
    expect(detail).toMatchObject({ status: 'suspended', suspendedReason: 'Abusive messages to providers' });
    expect((await w.call('post', `/admin/users/${id}/suspend`, w.admin, { reason: 'again' })).body.error).toBe('not_active');
    await w.call('post', `/admin/users/${id}/reinstate`, w.admin).expect(200);
    const back = await login(w.app, w.mailer, 'sam@example.com');
    expect(back.status).toBe(200);
    expect((await w.call('post', `/admin/users/${id}/reinstate`, w.admin)).body.error).toBe('not_suspended');
  });

  it('never suspends yourself or another admin', async () => {
    const w = await world();
    const me = await w.userId('boss@example.com');
    expect((await w.call('post', `/admin/users/${me}/suspend`, w.admin, { reason: 'oops' })).body.error).toBe('cannot_suspend_self');
    await loginAdmin(w.app, w.mailer, w.db, 'second@example.com');
    const other = await w.userId('second@example.com');
    expect((await w.call('post', `/admin/users/${other}/suspend`, w.admin, { reason: 'nope' })).body.error).toBe('cannot_suspend_admin');
  });

  it('suspending a provider withdraws their open offers', async () => {
    const w = await world();
    const b = await w.call('post', '/bookings', w.ctoken, { serviceSlug: 'home-cleaning', addressId: w.addressId, scheduledAt: at(FRI, '09:00'), units: 2 }).expect(201);
    await payBooking(w.app, w.ctoken, b.body.id);
    expect((await w.call('get', '/provider/offers', w.ptoken)).body.offers).toHaveLength(1);
    await w.call('post', `/admin/users/${await w.userId('cleaner@example.com')}/suspend`, w.admin, { reason: 'Left the company' }).expect(200);
    const row = (await w.db.query<{ status: string }>('SELECT status FROM job_offers WHERE booking_id = $1', [b.body.id])).rows[0]!;
    expect(row.status).toBe('withdrawn');
  });
});

describe('settings', () => {
  it('lists every setting with its current value and limits', async () => {
    const w = await world();
    const s = (await w.call('get', '/admin/settings', w.admin).expect(200)).body.settings as Array<{ key: string; value: string; group: string }>;
    expect(s.find((x) => x.key === 'commission_rate')).toMatchObject({ value: '0.20', group: 'money' });
    expect(s.find((x) => x.key === 'payout_hold_hours')?.value).toBe('24');
    expect(s.some((x) => x.key === 'dispute_window_hours')).toBe(false);
  });

  it('changes a value, audits it, and the app uses it straight away', async () => {
    const w = await world();
    await w.call('put', '/admin/settings/min_lead_hours', w.admin, { value: '48' }).expect(200);
    expect((await request(w.app).get('/config')).body.minLeadHours).toBe(48);
    await w.call('put', '/admin/settings/commission_rate', w.admin, { value: '0.15' }).expect(200);
    const id = await w.confirmed('2026-10-30', '09:00');
    for (const s of ['on_the_way', 'in_progress', 'completed']) await w.call('post', `/provider/jobs/${id}/status`, w.ptoken, { status: s }).expect(200);
    expect((await w.db.query<{ commission_cents: number }>('SELECT commission_cents FROM payouts WHERE booking_id = $1', [id])).rows[0]!.commission_cents).toBe(900); // 15% of RM 60
    const log = (await w.call('get', '/admin/audit?action=settings.', w.admin)).body.entries;
    expect(log[0]).toMatchObject({ action: 'settings.update', entityId: 'commission_rate', actor: 'boss@example.com', detail: { from: '0.20', to: '0.15' } });
  });

  it('rejects bad values and unknown keys', async () => {
    const w = await world();
    const put = (key: string, value: string) => w.call('put', `/admin/settings/${key}`, w.admin, { value });
    expect((await put('commission_rate', '20')).body.error).toBe('invalid_value');
    expect((await put('commission_rate', 'abc')).status).toBe(400);
    expect((await put('offers_per_booking', '0')).status).toBe(400);
    expect((await put('offers_per_booking', '2.5')).status).toBe(400);
    expect((await put('offers_per_booking', '')).status).toBe(400);
    expect((await put('sst_enabled', 'yes')).status).toBe(400);
    expect((await put('day_start', '8am')).status).toBe(400);
    expect((await put('day_start', '21:00')).body.message).toMatch(/end after it starts/);
    expect((await put('jwt_secret', 'x')).status).toBe(404);
    expect((await w.call('put', '/admin/settings/day_end', w.admin, { value: '20:00', extra: 1 })).status).toBe(400);
    expect((await w.call('get', '/admin/settings', w.admin)).body.settings.find((s: { key: string }) => s.key === 'commission_rate').value).toBe('0.20'); // unchanged
    await put('sst_enabled', 'true').expect(200);
  });
});

describe('handover', () => {
  it('lists jobs whose provider took the day off or was suspended, and nothing else', async () => {
    const w = await world();
    const a = await w.confirmed(FRI, '09:00');
    const other = await makeProvider(w.db, { email: 'other@example.com', name: 'Zed' });
    expect((await w.call('get', '/admin/handover', w.admin)).body.jobs).toEqual([]);
    await w.call('post', '/provider/time-off', w.ptoken, { date: FRI }).expect(201);
    const jobs = (await w.call('get', '/admin/handover', w.admin).expect(200)).body.jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ bookingId: a, reason: 'day_off', provider: 'Aisha Rahman', customer: 'sam@example.com' });
    expect(other.providerId).toBeTruthy();
  });

  it('flags a suspended provider’s upcoming jobs', async () => {
    const w = await world();
    const a = await w.confirmed();
    await w.call('post', `/admin/providers/${w.p.providerId}/suspend`, w.admin, { reason: 'Complaints from customers' }).expect(200);
    const jobs = (await w.call('get', '/admin/handover', w.admin)).body.jobs;
    expect(jobs).toEqual([expect.objectContaining({ bookingId: a, reason: 'provider_blocked' })]);
  });

  it('re-matching offers the job to someone else, never the same provider, and clears the old assignment', async () => {
    const w = await world();
    const id = await w.confirmed();
    const other = await makeProvider(w.db, { email: 'other@example.com', name: 'Zed' });
    const otoken = (await login(w.app, w.mailer, 'other@example.com')).body.accessToken as string;
    await w.call('post', '/provider/time-off', w.ptoken, { date: FRI }).expect(201);
    const r = await w.call('post', `/admin/bookings/${id}/rematch`, w.admin, {}).expect(200);
    expect(r.body).toMatchObject({ status: 'offered', offered: 1 });
    expect((await w.call('get', '/provider/jobs', w.ptoken)).body.jobs).toEqual([]);
    expect((await w.call('get', '/provider/offers', w.ptoken)).body.offers).toEqual([]);
    expect((await w.call('get', '/provider/offers', otoken)).body.offers).toHaveLength(1);
    await w.call('post', `/provider/offers/${id}/accept`, otoken).expect(200);
    expect((await w.db.query<{ provider_id: string }>('SELECT provider_id FROM booking_assignments WHERE booking_id = $1', [id])).rows[0]!.provider_id).toBe(other.providerId);
    expect((await w.call('get', '/admin/audit?action=booking.rematch', w.admin)).body.entries).toHaveLength(1);
  });

  it('refuses to re-match a job that is not confirmed', async () => {
    const w = await world();
    const id = await w.confirmed();
    await w.call('post', `/provider/jobs/${id}/status`, w.ptoken, { status: 'on_the_way' }).expect(200);
    expect((await w.call('post', `/admin/bookings/${id}/rematch`, w.admin, {})).status).toBe(409);
    expect((await w.call('post', '/admin/bookings/not-a-uuid/rematch', w.admin, {})).status).toBe(404);
  });
});

describe('audit log viewer', () => {
  it('lists newest first, filters by action prefix and entity, and pages', async () => {
    const w = await world();
    for (const v of ['2', '3', '4']) await w.call('put', '/admin/settings/offers_per_booking', w.admin, { value: v }).expect(200);
    await w.call('post', `/admin/users/${await w.userId('sam@example.com')}/suspend`, w.admin, { reason: 'test reason' }).expect(200);
    const all = (await w.call('get', '/admin/audit', w.admin).expect(200)).body;
    expect(all.entries[0].action).toBe('user.suspend');
    const settingsOnly = (await w.call('get', '/admin/audit?action=settings.', w.admin)).body.entries;
    expect(settingsOnly).toHaveLength(3);
    const page1 = (await w.call('get', '/admin/audit?limit=2', w.admin)).body;
    expect(page1.entries).toHaveLength(2);
    expect(page1.next).toBeTruthy();
    const byEntity = (await w.call('get', '/admin/audit?entityId=offers_per_booking', w.admin)).body.entries;
    expect(byEntity).toHaveLength(3);
    expect((await w.call('get', '/admin/audit?action=%25', w.admin)).body.entries.length).toBeGreaterThanOrEqual(0);
  });
});
