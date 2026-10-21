import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, loginAdmin, makeAddress, makeClock, makeProvider, payBooking, png, setup } from './helpers.js';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const FRI = '2026-10-23';
const at = (hhmm: string) => `${FRI}T${hhmm}:00+08:00`;

/** A brand-new provider who signed up through the app (not yet approved), plus an admin. */
async function applicantWorld(opts: Parameters<typeof setup>[1] = {}) {
  const ctx = await setup({}, opts);
  const email = 'newbie@example.com';
  const res = await login(ctx.app, ctx.mailer, email, { role: 'provider' });
  const token = res.body.accessToken as string;
  const admin = await loginAdmin(ctx.app, ctx.mailer, ctx.db);
  const get = (path: string, t = token) => request(ctx.app).get(path).set(bearer(t));
  const send = (method: 'post' | 'put' | 'delete', path: string, body?: object, t = token) => request(ctx.app)[method](path).set(bearer(t)).send(body);
  const fillAll = async () => {
    await send('put', '/provider/profile', { fullName: 'Nora Lee', phone: '012-345 6789', bio: 'Careful and punctual.', areaSlugs: ['petaling-jaya'], skillCodes: ['cleaning'] }).expect(200);
    await send('put', '/provider/bank', { bankName: 'Maybank', accountName: 'Nora Lee', accountNumber: '1122 3344 5566' }).expect(200);
    for (const [i, docType] of (['id_front', 'id_back', 'selfie'] as const).entries()) {
      await send('post', '/provider/documents', { docType, image: png(i) }).expect(201);
    }
  };
  const providerId = async () => (await ctx.db.query<{ id: string }>('SELECT p.id FROM providers p JOIN users u ON u.id = p.user_id WHERE u.email = $1', [email])).rows[0]!.id;
  return { ...ctx, token, admin, get, send, fillAll, providerId };
}

describe('provider application', () => {
  it('a new provider cannot take work until an admin approves', async () => {
    const w = await applicantWorld();
    const me = await w.get('/provider/me').expect(200);
    expect(me.body.status).toBe('pending');
    expect(me.body.canSubmit).toBe(false);
    expect(me.body.missing).toEqual(expect.arrayContaining(['fullName', 'phone', 'areas', 'skills', 'id_front', 'id_back', 'selfie', 'bank']));
    expect((await w.get('/provider/offers')).status).toBe(403);
    expect((await w.get('/provider/earnings')).status).toBe(403);
    expect((await w.get('/provider/availability')).status).toBe(403);
  });

  it('lists areas and skills to choose from', async () => {
    const w = await applicantWorld();
    const o = await w.get('/provider/options').expect(200);
    expect(o.body.areas.map((a: { slug: string }) => a.slug)).toContain('petaling-jaya');
    expect(o.body.skills.map((s: { code: string }) => s.code)).toContain('cleaning');
  });

  it('validates the profile: phone, areas and skills', async () => {
    const w = await applicantWorld();
    const base = { fullName: 'Nora Lee', phone: '012-345 6789', areaSlugs: ['petaling-jaya'], skillCodes: ['cleaning'] };
    expect((await w.send('put', '/provider/profile', { ...base, phone: '12345' })).body.error).toBe('invalid_phone');
    expect((await w.send('put', '/provider/profile', { ...base, areaSlugs: ['atlantis'] })).body.error).toBe('unknown_area');
    expect((await w.send('put', '/provider/profile', { ...base, skillCodes: ['wizardry'] })).body.error).toBe('unknown_skill');
    expect((await w.send('put', '/provider/profile', { ...base, extra: 1 })).status).toBe(400);
    const ok = await w.send('put', '/provider/profile', base).expect(200);
    expect(ok.body.profile).toMatchObject({ fullName: 'Nora Lee', phone: '+60123456789', areaSlugs: ['petaling-jaya'], skillCodes: ['cleaning'] });
  });

  it('stores the bank account encrypted and only ever shows the last 4 digits', async () => {
    const w = await applicantWorld();
    const r = await w.send('put', '/provider/bank', { bankName: 'Maybank', accountName: 'Nora Lee', accountNumber: '1122 3344 5566' }).expect(200);
    expect(r.body.bank).toEqual({ bankName: 'Maybank', accountName: 'Nora Lee', last4: '5566' });
    expect(JSON.stringify(r.body)).not.toContain('112233445566');
    const row = (await w.db.query<{ bank_account_enc: string }>('SELECT bank_account_enc FROM providers WHERE id = $1', [await w.providerId()])).rows[0]!;
    expect(row.bank_account_enc).not.toContain('5566');
    expect(row.bank_account_enc.startsWith('v1.')).toBe(true);
    expect((await w.send('put', '/provider/bank', { bankName: 'M', accountName: 'N', accountNumber: 'abc' })).status).toBe(400);
  });

  it('accepts real images only, replaces identity documents, and keeps them private', async () => {
    const w = await applicantWorld();
    const text = Buffer.from('this is definitely not an image, just some text '.repeat(5)).toString('base64');
    expect((await w.send('post', '/provider/documents', { docType: 'selfie', image: text })).body.error).toBe('invalid_image');
    expect((await w.send('post', '/provider/documents', { docType: 'passport', image: png() })).status).toBe(400);

    await w.send('post', '/provider/documents', { docType: 'selfie', image: png(1) }).expect(201);
    const again = await w.send('post', '/provider/documents', { docType: 'selfie', image: png(2) }).expect(201);
    expect(again.body.documents.filter((d: { docType: string }) => d.docType === 'selfie')).toHaveLength(1); // replaced, not added
    expect(w.store.size()).toBe(1); // the old file was deleted from storage too

    const doc = again.body.documents[0];
    const file = await w.get(`/provider/documents/${doc.id}/file`).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toContain('no-store');

    // Another provider cannot open it, and a customer cannot even reach the route.
    const other = (await login(w.app, w.mailer, 'other@example.com', { role: 'provider' })).body.accessToken as string;
    expect((await w.get(`/provider/documents/${doc.id}/file`, other)).status).toBe(404);
    const cust = (await login(w.app, w.mailer, 'cust@example.com')).body.accessToken as string;
    expect((await w.get(`/provider/documents/${doc.id}/file`, cust)).status).toBe(403);
  });

  it('refuses to submit an incomplete application, then queues a complete one for review', async () => {
    const w = await applicantWorld();
    const early = await w.send('post', '/provider/submit').expect(400);
    expect(early.body.error).toBe('application_incomplete');
    await w.fillAll();
    const me = await w.get('/provider/me').expect(200);
    expect(me.body.missing).toEqual([]);
    expect(me.body.canSubmit).toBe(true);

    // Not in the admin queue until submitted.
    expect((await w.get('/admin/providers', w.admin)).body.providers).toHaveLength(0);
    await w.send('post', '/provider/submit').expect(200);
    expect((await w.send('post', '/provider/submit')).body.error).toBe('already_submitted');
    const queue = await w.get('/admin/providers', w.admin).expect(200);
    expect(queue.body.providers).toHaveLength(1);
    expect(queue.body.providers[0]).toMatchObject({ email: 'newbie@example.com', fullName: 'Nora Lee', documents: 3 });
  });

  it('admin approves: the provider can work, and is audited', async () => {
    const w = await applicantWorld();
    await w.fillAll();
    await w.send('post', '/provider/submit').expect(200);
    const id = await w.providerId();

    const detail = await w.get(`/admin/providers/${id}`, w.admin).expect(200);
    expect(detail.body).toMatchObject({ status: 'pending', areas: ['Petaling Jaya'], bank: { bankName: 'Maybank', last4: '5566' } });
    expect(JSON.stringify(detail.body)).not.toContain('112233445566');
    const doc = detail.body.documents[0];
    const img = await w.get(`/admin/providers/${id}/documents/${doc.id}/file`, w.admin).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await w.get(`/admin/providers/${id}/documents/${doc.id}/file`)).status).toBe(403); // providers are not admins

    await w.send('post', `/admin/providers/${id}/approve`, {}, w.admin).expect(200);
    expect((await w.get('/provider/offers')).status).toBe(200);
    expect((await w.send('post', `/admin/providers/${id}/approve`, {}, w.admin)).status).toBe(409); // already approved
    const log = await w.db.query("SELECT action FROM audit_log WHERE entity = 'provider' AND entity_id = $1", [id]);
    expect(log.rows.map((r) => (r as { action: string }).action)).toContain('provider.approve');
    expect((await w.get('/provider/me')).body.status).toBe('approved');
  });

  it('rejection needs a reason, shows it to the provider, and they can fix and re-apply', async () => {
    const w = await applicantWorld();
    await w.fillAll();
    await w.send('post', '/provider/submit').expect(200);
    const id = await w.providerId();

    expect((await w.send('post', `/admin/providers/${id}/reject`, {}, w.admin)).status).toBe(400);
    await w.send('post', `/admin/providers/${id}/reject`, { reason: 'Selfie is blurry' }, w.admin).expect(200);
    const me = (await w.get('/provider/me')).body;
    expect(me).toMatchObject({ status: 'rejected', rejectionReason: 'Selfie is blurry', canSubmit: true });
    expect((await w.get('/provider/offers')).status).toBe(403);

    await w.send('post', '/provider/documents', { docType: 'selfie', image: png(9) }).expect(201);
    await w.send('post', '/provider/submit').expect(200);
    expect((await w.get('/provider/me')).body).toMatchObject({ status: 'pending', rejectionReason: null });
    await w.send('post', `/admin/providers/${id}/approve`, {}, w.admin).expect(200);
  });

  it('cannot approve a provider whose application is incomplete or has a rejected document', async () => {
    const w = await applicantWorld();
    const id = await w.providerId();
    expect((await w.send('post', `/admin/providers/${id}/approve`, {}, w.admin)).body.error).toBe('not_submitted');
    await w.fillAll();
    await w.send('post', '/provider/submit').expect(200);
    const detail = await w.get(`/admin/providers/${id}`, w.admin);
    const doc = detail.body.documents[0];
    await w.send('post', `/admin/providers/${id}/documents/${doc.id}/review`, { status: 'rejected' }, w.admin).expect(400); // note required
    await w.send('post', `/admin/providers/${id}/documents/${doc.id}/review`, { status: 'rejected', note: 'Cut off at the edge' }, w.admin).expect(200);
    expect((await w.send('post', `/admin/providers/${id}/approve`, {}, w.admin)).body.error).toBe('document_rejected');
    expect((await w.get('/provider/me')).body.documents.find((d: { id: string }) => d.id === doc.id)).toMatchObject({ reviewStatus: 'rejected', reviewNote: 'Cut off at the edge' });
  });

  it('suspending removes a provider from matching; reinstating brings them back', async () => {
    const w = await applicantWorld();
    await w.fillAll();
    await w.send('post', '/provider/submit').expect(200);
    const id = await w.providerId();
    await w.send('post', `/admin/providers/${id}/approve`, {}, w.admin).expect(200);
    await w.send('post', `/admin/providers/${id}/suspend`, { reason: 'Customer complaints' }, w.admin).expect(200);
    expect((await w.get('/provider/offers')).status).toBe(403);
    expect((await w.send('put', '/provider/bank', { bankName: 'CIMB', accountName: 'Nora Lee', accountNumber: '998877' })).status).toBe(403);
    await w.send('post', `/admin/providers/${id}/reinstate`, {}, w.admin).expect(200);
    expect((await w.get('/provider/offers')).status).toBe(200);
  });

  it('approved providers keep their approved skills and identity documents', async () => {
    const w = await applicantWorld();
    await w.fillAll();
    await w.send('post', '/provider/submit').expect(200);
    await w.send('post', `/admin/providers/${await w.providerId()}/approve`, {}, w.admin).expect(200);
    const base = { fullName: 'Nora Lee', phone: '0123456789', areaSlugs: ['petaling-jaya'] };
    expect((await w.send('put', '/provider/profile', { ...base, skillCodes: ['cleaning', 'aircon'] })).body.error).toBe('skills_locked');
    await w.send('put', '/provider/profile', { ...base, skillCodes: ['cleaning'], areaSlugs: ['petaling-jaya', 'subang'] }).expect(200); // areas may change
    expect((await w.send('post', '/provider/documents', { docType: 'selfie', image: png(5) })).body.error).toBe('documents_locked');
    await w.send('post', '/provider/documents', { docType: 'certificate', image: png(6) }).expect(201);
  });

  it('approved providers can give a service up themselves, but only an admin can add one', async () => {
    const w = await applicantWorld();
    await w.fillAll();
    await w.send('post', '/provider/submit').expect(200);
    const id = await w.providerId();
    await w.send('post', `/admin/providers/${id}/approve`, {}, w.admin).expect(200);
    const base = { fullName: 'Nora Lee', phone: '0123456789', areaSlugs: ['petaling-jaya'] };
    // Admin gives two services.
    const set = await w.send('put', `/admin/providers/${id}/skills`, { skillCodes: ['cleaning', 'aircon'] }, w.admin).expect(200);
    expect(set.body.skillCodes).toEqual(['aircon', 'cleaning']);
    const detail = await w.get(`/admin/providers/${id}`, w.admin).expect(200);
    expect(detail.body.skillCodes).toEqual(['aircon', 'cleaning']);
    expect(detail.body.allSkills.length).toBeGreaterThan(1);
    // Provider removes one: fine. Adding another: refused. Removing everything: refused.
    expect((await w.send('put', '/provider/profile', { ...base, skillCodes: ['cleaning', 'aircon', 'ironing'] })).body.error).toBe('skills_locked');
    expect((await w.send('put', '/provider/profile', { ...base, skillCodes: [] })).body.error).toBe('skills_required');
    await w.send('put', '/provider/profile', { ...base, skillCodes: ['cleaning'] }).expect(200);
    expect((await w.get('/provider/me')).body.profile.skillCodes).toEqual(['cleaning']);
    const log = await w.db.query<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('provider.skills_set','provider.skills_removed') ORDER BY created_at");
    expect(log.rows.map((r) => r.action)).toEqual(['provider.skills_set', 'provider.skills_removed']);
    // Admin input is checked.
    expect((await w.send('put', `/admin/providers/${id}/skills`, { skillCodes: [] }, w.admin)).status).toBe(400);
    expect((await w.send('put', `/admin/providers/${id}/skills`, { skillCodes: ['wizardry'] }, w.admin)).body.error).toBe('unknown_skill');
    expect((await w.send('put', '/admin/providers/00000000-0000-4000-8000-000000000000/skills', { skillCodes: ['cleaning'] }, w.admin)).status).toBe(404);
    expect((await w.send('put', `/admin/providers/${id}/skills`, { skillCodes: ['cleaning'] })).status).toBe(403);
  });

  it('only admins can use the vetting and payout tools', async () => {
    const w = await applicantWorld();
    expect((await w.get('/admin/providers')).status).toBe(403);
    expect((await w.get('/admin/payouts')).status).toBe(403);
  });
});

/** An approved provider (made directly), a customer and an admin, with a clock. */
async function workWorld(opts: { requireAfterPhoto?: boolean } = {}) {
  const clock = makeClock();
  const ctx = await setup({}, { now: clock.now, requireAfterPhoto: opts.requireAfterPhoto });
  const p = await makeProvider(ctx.db, { email: 'cleaner@example.com', name: 'Aisha Rahman' });
  const ptoken = (await login(ctx.app, ctx.mailer, 'cleaner@example.com')).body.accessToken as string;
  const ctoken = (await login(ctx.app, ctx.mailer, 'sam@example.com')).body.accessToken as string;
  const addressId = await makeAddress(ctx.app, ctoken);
  const admin = await loginAdmin(ctx.app, ctx.mailer, ctx.db);
  const send = (method: 'post' | 'put' | 'delete', path: string, body: object | undefined, t: string) => request(ctx.app)[method](path).set(bearer(t)).send(body);
  const get = (path: string, t: string) => request(ctx.app).get(path).set(bearer(t));
  /** Booked, paid and accepted: the job is "confirmed" for the provider. */
  const confirmedJob = async (time = '09:00', units = 2) => {
    const b = await request(ctx.app).post('/bookings').set(bearer(ctoken)).send({ serviceSlug: 'home-cleaning', addressId, scheduledAt: at(time), units }).expect(201);
    await payBooking(ctx.app, ctoken, b.body.id);
    await send('post', `/provider/offers/${b.body.id}/accept`, undefined, ptoken).expect(200);
    return b.body.id as string;
  };
  const status = (id: string, s: string) => send('post', `/provider/jobs/${id}/status`, { status: s }, ptoken);
  const bank = () => send('put', '/provider/bank', { bankName: 'Maybank', accountName: 'Aisha Rahman', accountNumber: '5140 1234 5678' }, ptoken).expect(200);
  return { ...ctx, clock, p, ptoken, ctoken, admin, send, get, confirmedJob, status, bank, addressId };
}

describe('working hours and days off', () => {
  it('saves a weekly schedule, replacing the old one', async () => {
    const w = await workWorld();
    const r = await w.send('put', '/provider/availability', { windows: [{ weekday: 1, start: '08:00', end: '12:00' }, { weekday: 1, start: '14:00', end: '18:00' }, { weekday: 3, start: '09:00', end: '17:00' }] }, w.ptoken).expect(200);
    expect(r.body.windows).toEqual([
      { weekday: 1, start: '08:00', end: '12:00' },
      { weekday: 1, start: '14:00', end: '18:00' },
      { weekday: 3, start: '09:00', end: '17:00' },
    ]);
    const cleared = await w.send('put', '/provider/availability', { windows: [] }, w.ptoken).expect(200);
    expect(cleared.body.windows).toEqual([]);
  });

  it('rejects backwards, overlapping and malformed windows', async () => {
    const w = await workWorld();
    const put = (windows: object[]) => w.send('put', '/provider/availability', { windows }, w.ptoken);
    expect((await put([{ weekday: 1, start: '18:00', end: '08:00' }])).body.error).toBe('invalid_window');
    expect((await put([{ weekday: 1, start: '08:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '15:00' }])).body.error).toBe('overlapping_windows');
    expect((await put([{ weekday: 9, start: '08:00', end: '12:00' }])).status).toBe(400);
    expect((await put([{ weekday: 1, start: '8am', end: '12:00' }])).status).toBe(400);
    expect((await w.get('/provider/availability', w.ptoken)).body.windows).toHaveLength(7); // unchanged by the failures
  });

  it('days off: add, list, remove; past days refused; is idempotent', async () => {
    const w = await workWorld();
    const add = await w.send('post', '/provider/time-off', { date: '2026-10-30' }, w.ptoken).expect(201);
    expect(add.body.timeOff).toEqual([expect.objectContaining({ date: '2026-10-30' })]);
    await w.send('post', '/provider/time-off', { date: '2026-10-30' }, w.ptoken).expect(201);
    expect((await w.get('/provider/availability', w.ptoken)).body.timeOff).toHaveLength(1);
    expect((await w.send('post', '/provider/time-off', { date: '2026-10-01' }, w.ptoken)).body.error).toBe('date_in_past');
    expect((await w.send('post', '/provider/time-off', { date: '2026-02-30' }, w.ptoken)).status).toBe(400);
    expect((await w.send('post', '/provider/time-off', { date: '2030-01-01' }, w.ptoken)).body.error).toBe('date_too_far');
    const id = add.body.timeOff[0].id;
    await w.send('delete', `/provider/time-off/${id}`, undefined, w.ptoken).expect(200);
    expect((await w.send('delete', `/provider/time-off/${id}`, undefined, w.ptoken)).status).toBe(404);
    expect((await w.get('/provider/availability', w.ptoken)).body.timeOff).toEqual([]);
  });

  it('a day off stops customers booking that provider, and warns about jobs already booked', async () => {
    const w = await workWorld();
    const id = await w.confirmedJob('09:00');
    const warn = await w.send('post', '/provider/time-off', { date: FRI }, w.ptoken).expect(201);
    expect(warn.body.bookedJobsThatDay).toBe(1);
    expect(id).toBeTruthy();
    // A second customer trying to book that day finds no one available.
    const c2 = (await login(w.app, w.mailer, 'lee@example.com')).body.accessToken as string;
    const a2 = await makeAddress(w.app, c2);
    const res = await request(w.app).post('/bookings').set(bearer(c2)).send({ serviceSlug: 'home-cleaning', addressId: a2, scheduledAt: at('14:00'), units: 2 });
    expect(res.status).not.toBe(201);
  });

  it("one provider cannot remove another's day off", async () => {
    const w = await workWorld();
    const add = await w.send('post', '/provider/time-off', { date: '2026-10-30' }, w.ptoken).expect(201);
    await makeProvider(w.db, { email: 'rival@example.com' });
    const rival = (await login(w.app, w.mailer, 'rival@example.com')).body.accessToken as string;
    expect((await w.send('delete', `/provider/time-off/${add.body.timeOff[0].id}`, undefined, rival)).status).toBe(404);
  });
});

describe('job photos', () => {
  it('only at the right stage, only for your own job, and real images only', async () => {
    const w = await workWorld();
    const id = await w.confirmedJob();
    expect((await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'before', image: png() }, w.ptoken)).body.error).toBe('wrong_job_state'); // not started yet
    await w.status(id, 'on_the_way').expect(200);
    await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'before', image: png(1) }, w.ptoken).expect(201);
    expect((await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'after', image: png() }, w.ptoken)).body.error).toBe('wrong_job_state');
    await w.status(id, 'in_progress').expect(200);
    await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'after', image: png(2) }, w.ptoken).expect(201);
    expect((await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'after', image: 'bm90IGFuIGltYWdl'.repeat(10) }, w.ptoken)).body.error).toBe('invalid_image');
    expect((await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'during', image: png() }, w.ptoken)).status).toBe(400);

    await makeProvider(w.db, { email: 'rival@example.com' });
    const rival = (await login(w.app, w.mailer, 'rival@example.com')).body.accessToken as string;
    expect((await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'after', image: png() }, rival)).status).toBe(404);
  });

  it('retaking a photo replaces the old file', async () => {
    const w = await workWorld();
    const id = await w.confirmedJob();
    await w.status(id, 'on_the_way').expect(200);
    await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'before', image: png(1) }, w.ptoken).expect(201);
    await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'before', image: png(2) }, w.ptoken).expect(201);
    expect(w.store.size()).toBe(1);
  });

  it('when required, a job cannot be finished without an after photo', async () => {
    const w = await workWorld({ requireAfterPhoto: true });
    const id = await w.confirmedJob();
    await w.status(id, 'on_the_way').expect(200);
    await w.status(id, 'in_progress').expect(200);
    const jobs = await w.get('/provider/jobs', w.ptoken);
    expect(jobs.body.requireAfterPhoto).toBe(true);
    expect(jobs.body.jobs[0].photos).toEqual({ before: false, after: false });
    const blocked = await w.status(id, 'completed');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('after_photo_required');
    await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'after', image: png(3) }, w.ptoken).expect(201);
    await w.status(id, 'completed').expect(200);
    expect((await w.get('/provider/jobs?status=all', w.ptoken)).body.jobs[0].photos.after).toBe(true);
  });

  it('can be switched off in settings', async () => {
    const w = await workWorld({ requireAfterPhoto: false });
    const id = await w.confirmedJob();
    await w.status(id, 'on_the_way').expect(200);
    await w.status(id, 'in_progress').expect(200);
    await w.status(id, 'completed').expect(200);
  });

  it('the customer, the provider and admins can see the photos; nobody else', async () => {
    const w = await workWorld();
    const id = await w.confirmedJob();
    await w.status(id, 'on_the_way').expect(200);
    await w.send('post', `/provider/jobs/${id}/photos`, { kind: 'before', image: png(4) }, w.ptoken).expect(201);

    expect((await w.get(`/bookings/${id}`, w.ctoken)).body.photos).toEqual({ before: true, after: false });
    const mine = await w.get(`/bookings/${id}/photos/before`, w.ctoken).expect(200);
    expect(mine.headers['content-type']).toBe('image/png');
    expect(mine.headers['cache-control']).toContain('no-store');
    await w.get(`/bookings/${id}/photos/before`, w.ptoken).expect(200);
    await w.get(`/bookings/${id}/photos/before`, w.admin).expect(200);
    expect((await w.get(`/bookings/${id}/photos/after`, w.ctoken)).status).toBe(404); // not taken yet

    const stranger = (await login(w.app, w.mailer, 'stranger@example.com')).body.accessToken as string;
    expect((await w.get(`/bookings/${id}/photos/before`, stranger)).status).toBe(404);
    await makeProvider(w.db, { email: 'rival@example.com' });
    const rival = (await login(w.app, w.mailer, 'rival@example.com')).body.accessToken as string;
    expect((await w.get(`/bookings/${id}/photos/before`, rival)).status).toBe(404);
    expect((await request(w.app).get(`/bookings/${id}/photos/before`)).status).toBe(401);
  });
});

describe('earnings and payouts', () => {
  it('completing a job creates a payout line that waits out the dispute window', async () => {
    const w = await workWorld();
    const id = await w.confirmedJob();
    await w.status(id, 'on_the_way').expect(200);
    await w.status(id, 'in_progress').expect(200);
    expect((await w.get('/provider/earnings', w.ptoken)).body.items).toHaveLength(0); // nothing earned before it is done
    await w.status(id, 'completed').expect(200);

    const e = (await w.get('/provider/earnings', w.ptoken)).body;
    expect(e).toMatchObject({ waitingCents: 4800, availableCents: 0, requestedCents: 0, paidCents: 0 });
    expect(e.items[0]).toMatchObject({ bookingId: id, netCents: 4800, grossCents: 6000, commissionCents: 1200, status: 'waiting' });

    w.clock.advanceMinutes(24 * 60 + 1);
    const later = (await w.get('/provider/earnings', w.ptoken)).body;
    expect(later).toMatchObject({ availableCents: 4800, waitingCents: 0 });
    expect(later.items[0].status).toBe('available');
  });

  it('a completed job is only counted once even if completion is replayed', async () => {
    const w = await workWorld();
    const id = await w.confirmedJob();
    await w.status(id, 'on_the_way').expect(200);
    await w.status(id, 'in_progress').expect(200);
    await w.status(id, 'completed').expect(200);
    expect((await w.status(id, 'completed')).status).toBe(409);
    expect((await w.db.query('SELECT 1 FROM payouts WHERE booking_id = $1', [id])).rowCount).toBe(1);
  });

  async function finishedJob(w: Awaited<ReturnType<typeof workWorld>>, time = '09:00') {
    const id = await w.confirmedJob(time);
    await w.status(id, 'on_the_way').expect(200);
    await w.status(id, 'in_progress').expect(200);
    await w.status(id, 'completed').expect(200);
    return id;
  }
  const request_ = (w: Awaited<ReturnType<typeof workWorld>>) => w.send('post', '/provider/payouts/request', undefined, w.ptoken);

  it('withdrawal rules: not before the hold ends, needs bank details, needs the minimum', async () => {
    const w = await workWorld();
    await finishedJob(w);
    expect((await request_(w)).body.error).toBe('nothing_to_pay'); // still inside the 24h window
    w.clock.advanceMinutes(25 * 60);
    expect((await request_(w)).body.error).toBe('no_bank_details');
    await w.bank();
    const low = await request_(w);
    expect(low.status).toBe(409);
    expect(low.body.error).toBe('below_minimum'); // RM 48.00 < RM 50.00
    await w.db.query("INSERT INTO app_config (key, value) VALUES ('min_payout_cents', '1000') ON CONFLICT (key) DO UPDATE SET value = '1000'");
    const ok = await request_(w);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ count: 1, totalCents: 4800 });
    expect((await request_(w)).body.error).toBe('nothing_to_pay'); // cannot request the same money twice
    expect((await w.get('/provider/earnings', w.ptoken)).body).toMatchObject({ requestedCents: 4800, availableCents: 0 });
  });

  it('two jobs are withdrawn together and admin pays them in one transfer', async () => {
    const w = await workWorld();
    await w.db.query("INSERT INTO app_config (key, value) VALUES ('min_payout_cents', '1000') ON CONFLICT (key) DO UPDATE SET value = '1000'");
    const a = await finishedJob(w, '09:00');
    const b = await finishedJob(w, '14:00');
    await w.bank();
    w.clock.advanceMinutes(25 * 60);
    expect((await request_(w)).body).toEqual({ count: 2, totalCents: 9600 });

    const list = (await w.get('/admin/payouts', w.admin).expect(200)).body.requests;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      providerName: 'Aisha Rahman',
      jobs: 2,
      totalCents: 9600,
      bank: { bankName: 'Maybank', accountName: 'Aisha Rahman', accountNumber: '514012345678' },
    });

    expect((await w.send('post', `/admin/payouts/${w.p.providerId}/pay`, {}, w.admin)).body.error).toBe('reference_required');
    const paid = await w.send('post', `/admin/payouts/${w.p.providerId}/pay`, { reference: 'MBB-20261022-001' }, w.admin).expect(200);
    expect(paid.body).toEqual({ count: 2, totalCents: 9600 });
    expect((await w.send('post', `/admin/payouts/${w.p.providerId}/pay`, { reference: 'again' }, w.admin)).body.error).toBe('nothing_requested');

    for (const id of [a, b]) {
      expect((await w.get(`/bookings/${id}`, w.ctoken)).body.status).toBe('paid_out');
      const pay = await w.db.query<{ status: string }>('SELECT status FROM payments WHERE booking_id = $1', [id]);
      expect(pay.rows[0]!.status).toBe('released');
    }
    expect((await w.get('/provider/earnings', w.ptoken)).body).toMatchObject({ paidCents: 9600, requestedCents: 0 });
    expect((await w.get('/admin/payouts', w.admin)).body.requests).toEqual([]);
    const log = await w.db.query("SELECT detail FROM audit_log WHERE action = 'payout.paid'");
    expect(log.rowCount).toBe(1);
  });

  it('a disputed job is held back from withdrawal', async () => {
    const w = await workWorld();
    await w.db.query("INSERT INTO app_config (key, value) VALUES ('min_payout_cents', '1000') ON CONFLICT (key) DO UPDATE SET value = '1000'");
    const id = await finishedJob(w);
    await w.bank();
    await w.db.query("UPDATE bookings SET status = 'disputed' WHERE id = $1", [id]);
    w.clock.advanceMinutes(25 * 60);
    expect((await w.get('/provider/earnings', w.ptoken)).body.items[0].status).toBe('on_hold');
    expect((await request_(w)).body.error).toBe('nothing_to_pay');
  });

  it('cancelling a booking in admin voids its unpaid payout', async () => {
    const w = await workWorld();
    const id = await finishedJob(w);
    await w.db.query("UPDATE bookings SET status = 'disputed' WHERE id = $1", [id]);
    await w.send('post', `/admin/bookings/${id}/status`, { status: 'cancelled', reason: 'upheld complaint' }, w.admin).expect(200);
    expect((await w.db.query<{ status: string }>('SELECT status FROM payouts WHERE booking_id = $1', [id])).rows[0]!.status).toBe('failed');
    expect((await w.get('/provider/earnings', w.ptoken)).body.items).toHaveLength(0);
  });

  it('one provider never sees another provider’s earnings', async () => {
    const w = await workWorld();
    await finishedJob(w);
    await makeProvider(w.db, { email: 'rival@example.com' });
    const rival = (await login(w.app, w.mailer, 'rival@example.com')).body.accessToken as string;
    expect((await w.get('/provider/earnings', rival)).body).toMatchObject({ availableCents: 0, waitingCents: 0, items: [] });
  });
});
