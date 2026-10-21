import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION } from '../src/legal.js';
import { login, loginAdmin, makeAddress, makeClock, makeProvider, payBooking, setup } from './helpers.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const FRI = '2026-10-23T09:00:00+08:00';

async function world() {
  const clock = makeClock();
  const ctx = await setup({}, { now: clock.now });
  const p = await makeProvider(ctx.db, { email: 'cleaner@example.com', name: 'Aisha Rahman' });
  const ptoken = (await login(ctx.app, ctx.mailer, 'cleaner@example.com')).body.accessToken as string;
  const cres = await login(ctx.app, ctx.mailer, 'sam@example.com');
  const ctoken = cres.body.accessToken as string;
  const addressId = await makeAddress(ctx.app, ctoken);
  const call = (method: 'get' | 'post' | 'patch', path: string, t: string, body?: object) => {
    const r = request(ctx.app)[method](path).set(bearer(t));
    return body ? r.send(body) : r;
  };
  const book = async (when = FRI) => (await call('post', '/bookings', ctoken, { serviceSlug: 'home-cleaning', addressId, scheduledAt: when, units: 2 }).expect(201)).body.id as string;
  const confirmed = async () => {
    const id = await book();
    await payBooking(ctx.app, ctoken, id);
    await call('post', `/provider/offers/${id}/accept`, ptoken).expect(200);
    return id;
  };
  const finish = async (id: string) => {
    for (const s of ['on_the_way', 'in_progress', 'completed']) await call('post', `/provider/jobs/${id}/status`, ptoken, { status: s }).expect(200);
  };
  return { ...ctx, clock, p, ptoken, ctoken, cres, addressId, call, book, confirmed, finish };
}

describe('legal basics', () => {
  it('records which version of the terms a new account agreed to', async () => {
    const w = await world();
    const r = await w.db.query<{ consent_version: string }>("SELECT consent_version FROM users WHERE email = 'sam@example.com'");
    expect(r.rows[0]!.consent_version).toBe(LEGAL_VERSION);
  });
  it('exposes the company name and support email for the legal pages', async () => {
    const w = await setup({ COMPANY_NAME: 'Home360 Sdn Bhd', SUPPORT_EMAIL: 'help@home360.my' });
    const res = await request(w.app).get('/config').expect(200);
    expect(res.body.legal).toEqual({ company: 'Home360 Sdn Bhd', email: 'help@home360.my', version: LEGAL_VERSION });
  });
});

describe('PATCH /me', () => {
  it('corrects name, phone and language, and rejects bad input', async () => {
    const w = await world();
    const r = await w.call('patch', '/me', w.ctoken, { fullName: 'Sam Lee', phone: '012-345 6789', locale: 'ms' }).expect(200);
    expect(r.body).toMatchObject({ fullName: 'Sam Lee', phone: '+60123456789', locale: 'ms' });
    expect((await w.call('patch', '/me', w.ctoken, { phone: '12345' })).body.error).toBe('invalid_phone');
    await w.call('patch', '/me', w.ctoken, {}).expect(400);
    await w.call('patch', '/me', w.ctoken, { role: 'admin' }).expect(400);
    const cleared = await w.call('patch', '/me', w.ctoken, { phone: null }).expect(200);
    expect(cleared.body.phone).toBeNull();
    expect(cleared.body.fullName).toBe('Sam Lee');
  });
});

describe('GET /me/export', () => {
  it('returns my own data as a download and nothing about other people', async () => {
    const w = await world();
    const id = await w.confirmed();
    await w.finish(id);
    await w.call('post', `/bookings/${id}/review`, w.ctoken, { rating: 5, comment: 'Lovely' }).expect(201);
    await w.call('post', `/bookings/${id}/messages`, w.ctoken, { body: 'Please bring a ladder' }).expect(201);
    const res = await w.call('get', '/me/export', w.ctoken).expect(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const data = JSON.parse(res.text);
    expect(data.account).toMatchObject({ email: 'sam@example.com', consentVersion: LEGAL_VERSION });
    expect(data.addresses).toHaveLength(1);
    expect(data.bookings).toHaveLength(1);
    expect(data.payments).toHaveLength(1);
    expect(data.reviews[0]).toMatchObject({ rating: 5, comment: 'Lovely' });
    expect(data.messages[0]).toMatchObject({ from: 'you', body: 'Please bring a ladder' });
    expect(data.provider).toBeNull();
    expect(res.text).not.toContain('cleaner@example.com');
    expect(res.text).not.toContain('Aisha');
    expect(res.text).not.toContain('refresh');
  });
  it('includes provider details but never the full bank account number', async () => {
    const w = await world();
    await w.db.query("UPDATE providers SET bank_name = 'Maybank', bank_account_name = 'Aisha R', bank_account_enc = 'SECRETBLOB', bank_account_last4 = '4321' WHERE id = $1", [w.p.providerId]);
    const res = await w.call('get', '/me/export', w.ptoken).expect(200);
    const data = JSON.parse(res.text);
    expect(data.provider.bank).toEqual({ bankName: 'Maybank', accountName: 'Aisha R', accountEndingIn: '4321' });
    expect(data.provider.areas).toContain('Petaling Jaya');
    expect(res.text).not.toContain('SECRETBLOB');
  });
});

describe('POST /me/delete', () => {
  it('needs the exact confirmation word, and admins cannot use it', async () => {
    const w = await world();
    await w.call('post', '/me/delete', w.ctoken, {}).expect(400);
    await w.call('post', '/me/delete', w.ctoken, { confirm: 'delete' }).expect(400);
    const admin = await loginAdmin(w.app, w.mailer, w.db);
    expect((await w.call('post', '/me/delete', admin, { confirm: 'DELETE' })).status).toBe(403);
  });

  it('is refused while a booking is active or a payout is owed', async () => {
    const w = await world();
    const id = await w.confirmed();
    const c = await w.call('post', '/me/delete', w.ctoken, { confirm: 'DELETE' }).expect(409);
    expect(c.body).toMatchObject({ error: 'cannot_delete', reasons: ['active_bookings'] });
    const p = await w.call('post', '/me/delete', w.ptoken, { confirm: 'DELETE' }).expect(409);
    expect(p.body.reasons).toContain('active_bookings');
    await w.finish(id);
    // Completed: the customer is free to go, the provider still has a payout pending.
    const p2 = await w.call('post', '/me/delete', w.ptoken, { confirm: 'DELETE' }).expect(409);
    expect(p2.body.reasons).toEqual(['payouts_outstanding']);
    // Nothing was changed by the refusals.
    const u = await w.db.query<{ status: string; email: string }>("SELECT status, email FROM users WHERE id = $1", [w.p.userId]);
    expect(u.rows[0]).toEqual({ status: 'active', email: 'cleaner@example.com' });
  });

  it('erases a customer\'s personal details, keeps the money records, and kills their sessions', async () => {
    const w = await world();
    await w.call('patch', '/me', w.ctoken, { fullName: 'Sam Lee', phone: '0123456789' }).expect(200);
    const done = await w.confirmed();
    await w.finish(done);
    await w.call('post', `/bookings/${done}/review`, w.ctoken, { rating: 5, comment: 'Lovely' }).expect(201);
    await w.call('post', `/bookings/${done}/messages`, w.ctoken, { body: 'my secret gate code 1234' }).expect(201);
    await w.db.query("UPDATE bookings SET notes = 'dog at the gate' WHERE id = $1", [done]);
    const unpaid = await w.book('2026-10-26T09:00:00+08:00'); // a pending booking lapses
    const userId = (await w.db.query<{ id: string }>("SELECT id FROM users WHERE email = 'sam@example.com'")).rows[0]!.id;
    const refresh = w.cres.body.refreshToken as string;

    await w.call('post', '/me/delete', w.ctoken, { confirm: 'DELETE' }).expect(200);

    const u = (await w.db.query<Record<string, any>>('SELECT email, full_name, phone, status, deleted_at FROM users WHERE id = $1', [userId])).rows[0]!;
    expect(u.email).not.toContain('sam');
    expect(u).toMatchObject({ full_name: null, phone: null, status: 'deleted' });
    expect(u.deleted_at).toBeTruthy();
    const a = (await w.db.query<Record<string, any>>('SELECT label, line1, postcode, notes FROM addresses WHERE user_id = $1', [userId])).rows[0]!;
    expect(a).toMatchObject({ label: 'Deleted', line1: '[deleted]', postcode: '00000', notes: null });
    expect((await w.db.query<{ body: string }>('SELECT body FROM messages WHERE sender_id = $1', [userId])).rows[0]!.body).toBe('[deleted]');
    expect((await w.db.query<{ comment: string | null }>('SELECT comment FROM reviews WHERE customer_id = $1', [userId])).rows[0]!.comment).toBeNull();
    expect((await w.db.query<{ notes: string | null }>('SELECT notes FROM bookings WHERE id = $1', [done])).rows[0]!.notes).toBeNull();
    // Money records stay.
    expect((await w.db.query<{ n: string }>('SELECT count(*)::text AS n FROM payments')).rows[0]!.n).toBe('1');
    expect((await w.db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [unpaid])).rows[0]!.status).toBe('cancelled');
    expect((await w.db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [done])).rows[0]!.status).toBe('completed');
    const log = await w.db.query<{ detail: unknown }>("SELECT detail FROM audit_log WHERE action = 'user.delete_self'");
    expect(log.rows).toHaveLength(1);
    expect(JSON.stringify(log.rows[0])).not.toContain('sam');

    // Sessions are dead straight away.
    await w.call('get', '/auth/me', w.ctoken).expect(401);
    await request(w.app).post('/auth/refresh').send({ refreshToken: refresh }).expect(401);
    // The same email can sign up again as a brand-new account.
    const again = await login(w.app, w.mailer, 'sam@example.com');
    expect(again.status).toBe(201);
    expect(again.body.user.id).not.toBe(userId);
  });

  it('removes a provider\'s documents, bank details and offers, and stops them being matched', async () => {
    const w = await world();
    const key = await w.store.save(Buffer.from('idphoto'), 'png');
    await w.db.query("INSERT INTO provider_documents (provider_id, doc_type, file_url) VALUES ($1, 'id_front', $2)", [w.p.providerId, key]);
    await w.db.query("UPDATE providers SET bio = 'Ten years of experience', bank_name = 'Maybank', bank_account_name = 'Aisha', bank_account_enc = 'blob', bank_account_last4 = '4321' WHERE id = $1", [w.p.providerId]);
    const open = await w.book(); // unpaid: no offers yet, so nothing blocks deletion
    void open;
    await w.call('post', '/me/delete', w.ptoken, { confirm: 'DELETE' }).expect(200);
    const p = (await w.db.query<Record<string, any>>('SELECT vetting_status, bio, bank_name, bank_account_name, bank_account_enc, bank_account_last4 FROM providers WHERE id = $1', [w.p.providerId])).rows[0]!;
    expect(p).toMatchObject({ vetting_status: 'suspended', bio: null, bank_name: null, bank_account_name: null, bank_account_enc: null, bank_account_last4: null });
    expect((await w.db.query('SELECT 1 FROM provider_documents WHERE provider_id = $1', [w.p.providerId])).rows).toHaveLength(0);
    expect((await w.db.query('SELECT 1 FROM provider_areas WHERE provider_id = $1', [w.p.providerId])).rows).toHaveLength(0);
    await expect(w.store.read(key)).resolves.toBeNull();
  });
});

describe('every private endpoint refuses visitors who are not logged in', () => {
  const routes: Array<['get' | 'post' | 'patch' | 'put', string]> = [
    ['get', '/auth/me'], ['get', '/addresses'], ['post', '/addresses'], ['get', '/bookings'], ['post', '/bookings'], ['get', '/bookings/abc'],
    ['post', '/bookings/abc/pay'], ['post', '/bookings/abc/cancel'], ['post', '/bookings/abc/review'], ['post', '/bookings/abc/dispute'],
    ['get', '/bookings/abc/messages'], ['post', '/bookings/abc/messages'], ['get', '/chat/unread'], ['get', '/recurring'], ['post', '/recurring'],
    ['get', '/provider/me'], ['get', '/provider/earnings'], ['get', '/provider/reviews'], ['get', '/provider/availability'],
    ['get', '/me/export'], ['patch', '/me'], ['post', '/me/delete'],
    ['get', '/admin/overview'], ['get', '/admin/users'], ['get', '/admin/settings'], ['put', '/admin/settings/commission_rate'], ['get', '/admin/audit'],
    ['get', '/admin/reports/bookings.csv'], ['get', '/admin/disputes'], ['get', '/admin/handover'],
  ];
  it.each(routes)('%s %s', async (method, path) => {
    const w = await setup();
    const res = await request(w.app)[method](path).send({});
    expect(res.status).toBe(401);
  });
  it('and customers cannot reach admin or provider areas', async () => {
    const w = await setup();
    const t = (await login(w.app, w.mailer, 'sam@example.com')).body.accessToken as string;
    for (const path of ['/admin/overview', '/admin/users', '/admin/audit', '/provider/earnings', '/provider/reviews']) {
      expect((await request(w.app).get(path).set(bearer(t))).status, path).toBe(403);
    }
  });
});
