import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, loginAdmin, setup } from './helpers.js';

describe('public catalogue', () => {
  it('lists only active services, in English by default', async () => {
    const { app } = await setup();
    const res = await request(app).get('/services').expect(200);
    expect(res.body.services.map((s: any) => s.slug)).toEqual([
      'home-cleaning',
      'ironing-laundry',
      'deep-cleaning',
      'aircon-service',
    ]);
    expect(res.body.services[0].name).toBe('Home cleaning');
  });

  it('serves Bahasa Malaysia on request and falls back to English for unknown languages', async () => {
    const { app } = await setup();
    const ms = await request(app).get('/services?lang=ms').expect(200);
    expect(ms.body.services[0].name).toBe('Pembersihan rumah');
    const odd = await request(app).get('/services?lang=xx').expect(200);
    expect(odd.body.services[0].name).toBe('Home cleaning');
  });

  it('returns a service with grouped options, and hides inactive services', async () => {
    const { app } = await setup();
    const res = await request(app).get('/services/aircon-service').expect(200);
    const keys = res.body.optionGroups.map((g: any) => g.key);
    expect(keys).toEqual(['aircon_type', 'gas']);
    const type = res.body.optionGroups.find((g: any) => g.key === 'aircon_type');
    expect(type.required).toBe(true);
    expect(type.options.map((o: any) => o.code).sort()).toEqual(['chemical_wash', 'general']);

    await request(app).get('/services/grass-cutting').expect(404);
    await request(app).get('/services/does-not-exist').expect(404);
  });
});

describe('price estimate', () => {
  it('returns an itemised price in sen without exposing commission', async () => {
    const { app } = await setup();
    const res = await request(app)
      .post('/services/home-cleaning/estimate')
      .send({ units: 3, options: [{ group: 'tools', code: 'bring_tools' }] })
      .expect(200);
    expect(res.body).toMatchObject({ currency: 'MYR', units: 3, subtotalCents: 14000, sstCents: 0, totalCents: 14000 });
    expect(res.body.lineItems).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toMatch(/commission|providerEarnings/i);
  });

  it('translates line item labels', async () => {
    const { app } = await setup();
    const res = await request(app).post('/services/home-cleaning/estimate?lang=ms').send({ units: 2 }).expect(200);
    expect(res.body.lineItems[0].label).toBe('Pembersihan rumah');
  });

  it('maps pricing errors to 400 with a code', async () => {
    const { app } = await setup();
    const low = await request(app).post('/services/home-cleaning/estimate').send({ units: 1 });
    expect(low.status).toBe(400);
    expect(low.body.error).toBe('units_below_minimum');

    const bad = await request(app).post('/services/aircon-service/estimate').send({ options: [{ group: 'aircon_type', code: 'nope' }] });
    expect(bad.body.error).toBe('unknown_option');

    await request(app).post('/services/aircon-service/estimate').send({ units: 'two' }).expect(400);
    await request(app).post('/services/nope/estimate').send({}).expect(404);
  });

  it('adds SST only when enabled in app_config', async () => {
    const { app, db } = await setup();
    await db.query("UPDATE app_config SET value = 'true' WHERE key = 'sst_enabled'");
    const res = await request(app).post('/services/home-cleaning/estimate').send({ units: 3 }).expect(200);
    expect(res.body).toMatchObject({ subtotalCents: 9000, sstCents: 720, totalCents: 9720 });
  });

  it('reports quote-only services instead of a price', async () => {
    const { app, db } = await setup();
    await db.query("UPDATE services SET active = true WHERE slug = 'grass-cutting'");
    const res = await request(app).post('/services/grass-cutting/estimate').send({}).expect(200);
    expect(res.body).toEqual({ serviceSlug: 'grass-cutting', quoteOnly: true });
  });
});

describe('admin catalogue', () => {
  it('is closed to anonymous users and customers', async () => {
    const { app, mailer } = await setup();
    await request(app).get('/admin/services').expect(401);
    const customer = await login(app, mailer, 'sam@example.com');
    await request(app).get('/admin/services').set('Authorization', `Bearer ${customer.body.accessToken}`).expect(403);
    await request(app).patch('/admin/services/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${customer.body.accessToken}`).send({ active: true }).expect(403);
  });

  it('lists everything, including inactive services', async () => {
    const { app, mailer, db } = await setup();
    const token = await loginAdmin(app, mailer, db);
    const res = await request(app).get('/admin/services').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.services).toHaveLength(15);
    expect(res.body.services.filter((s: any) => s.active).map((s: any) => s.slug)).toEqual(['home-cleaning', 'ironing-laundry', 'deep-cleaning', 'aircon-service']);
    expect(res.body.services.find((s: any) => s.slug === 'grass-cutting').active).toBe(false);
  });

  it('a price change shows up in estimates immediately and is written to the audit log', async () => {
    const { app, mailer, db } = await setup();
    const token = await loginAdmin(app, mailer, db);
    const list = await request(app).get('/admin/services').set('Authorization', `Bearer ${token}`);
    const cleaning = list.body.services.find((s: any) => s.slug === 'home-cleaning');

    await request(app)
      .patch(`/admin/services/${cleaning.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ basePriceCents: 3500 })
      .expect(200);

    const est = await request(app).post('/services/home-cleaning/estimate').send({ units: 2 }).expect(200);
    expect(est.body.subtotalCents).toBe(7000);

    const log = await db.query<{ action: string; detail: any }>("SELECT action, detail FROM audit_log WHERE action = 'service.update'");
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]!.detail.basePriceCents).toEqual({ from: 3000, to: 3500 });
  });

  it('rejects unknown fields, negative prices and attempts to change the pricing model', async () => {
    const { app, mailer, db } = await setup();
    const token = await loginAdmin(app, mailer, db);
    const list = await request(app).get('/admin/services').set('Authorization', `Bearer ${token}`);
    const id = list.body.services[0].id;
    const auth = { Authorization: `Bearer ${token}` };

    await request(app).patch(`/admin/services/${id}`).set(auth).send({ pricingModel: 'quote' }).expect(400);
    await request(app).patch(`/admin/services/${id}`).set(auth).send({ basePriceCents: -5 }).expect(400);
    await request(app).patch(`/admin/services/${id}`).set(auth).send({}).expect(400);
    await request(app).patch('/admin/services/not-a-uuid').set(auth).send({ active: true }).expect(404);
  });

  it('can create a new service and options with no code change, then switch it on', async () => {
    const { app, mailer, db } = await setup();
    const token = await loginAdmin(app, mailer, db);
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(app)
      .post('/admin/services')
      .set(auth)
      .send({
        slug: 'pest-control',
        nameEn: 'Pest control',
        nameMs: 'Kawalan perosak',
        pricingModel: 'per_unit',
        unitLabel: 'room',
        basePriceCents: 12000,
        phase: 2,
        skills: ['cleaning'],
      })
      .expect(201);
    expect(created.body.active).toBe(false);
    await request(app).get('/services/pest-control').expect(404); // hidden until switched on

    const opt = await request(app)
      .post(`/admin/services/${created.body.id}/options`)
      .set(auth)
      .send({ kind: 'addon', groupKey: 'followup', code: 'revisit', labelEn: 'Free revisit', labelMs: 'Lawatan semula', priceCents: 3000 })
      .expect(201);
    expect(opt.body.priceCents).toBe(3000);

    await request(app).patch(`/admin/services/${created.body.id}`).set(auth).send({ active: true }).expect(200);
    const est = await request(app)
      .post('/services/pest-control/estimate')
      .send({ units: 2, options: [{ group: 'followup', code: 'revisit' }] })
      .expect(200);
    expect(est.body.subtotalCents).toBe(12000 * 2 + 3000);
  });

  it('rejects duplicate slugs, unknown skills and bad option kinds', async () => {
    const { app, mailer, db } = await setup();
    const token = await loginAdmin(app, mailer, db);
    const auth = { Authorization: `Bearer ${token}` };
    const base = { nameEn: 'X', nameMs: 'X', pricingModel: 'hourly' };

    await request(app).post('/admin/services').set(auth).send({ ...base, slug: 'home-cleaning' }).expect(409);
    await request(app).post('/admin/services').set(auth).send({ ...base, slug: 'new-one', skills: ['nope'] }).expect(400);
    await request(app).post('/admin/services').set(auth).send({ ...base, slug: 'Bad Slug' }).expect(400);

    const list = await request(app).get('/admin/services').set(auth);
    const hourly = list.body.services.find((s: any) => s.slug === 'home-cleaning');
    const sizeOnHourly = { kind: 'size', groupKey: 'sz', code: 'a', labelEn: 'A', labelMs: 'A', priceCents: 100 };
    await request(app).post(`/admin/services/${hourly.id}/options`).set(auth).send(sizeOnHourly).expect(400);

    const kindClash = { kind: 'choice', groupKey: 'tools', code: 'x', labelEn: 'X', labelMs: 'X' };
    const clash = await request(app).post(`/admin/services/${hourly.id}/options`).set(auth).send(kindClash);
    expect(clash.status).toBe(400);
    expect(clash.body.error).toBe('group_kind_mismatch');

    const dup = { kind: 'addon', groupKey: 'tools', code: 'bring_tools', labelEn: 'X', labelMs: 'X' };
    await request(app).post(`/admin/services/${hourly.id}/options`).set(auth).send(dup).expect(409);
  });

  it('keeps only one default option per group and lets options be switched off', async () => {
    const { app, mailer, db } = await setup();
    const token = await loginAdmin(app, mailer, db);
    const auth = { Authorization: `Bearer ${token}` };
    const list = await request(app).get('/admin/services').set(auth);
    const aircon = list.body.services.find((s: any) => s.slug === 'aircon-service');
    const chem = aircon.options.find((o: any) => o.code === 'chemical_wash');
    const general = aircon.options.find((o: any) => o.code === 'general');
    expect(general.isDefault).toBe(true);

    await request(app).patch(`/admin/options/${chem.id}`).set(auth).send({ isDefault: true }).expect(200);
    const after = await request(app).get('/admin/services').set(auth);
    const opts = after.body.services.find((s: any) => s.slug === 'aircon-service').options;
    expect(opts.filter((o: any) => o.groupKey === 'aircon_type' && o.isDefault).map((o: any) => o.code)).toEqual(['chemical_wash']);

    // Default now applies to estimates: 1 unit of chemical wash = RM150
    const est = await request(app).post('/services/aircon-service/estimate').send({ units: 1 }).expect(200);
    expect(est.body.subtotalCents).toBe(15000);

    // Switching an option off removes it from the public catalogue
    await request(app).patch(`/admin/options/${general.id}`).set(auth).send({ active: false }).expect(200);
    const pub = await request(app).get('/services/aircon-service').expect(200);
    const codes = pub.body.optionGroups.find((g: any) => g.key === 'aircon_type').options.map((o: any) => o.code);
    expect(codes).toEqual(['chemical_wash']);
  });

  it('rolls back a failed write completely (transaction safety)', async () => {
    const { db } = await setup();
    await expect(
      db.tx(async (tx) => {
        await tx.query("UPDATE app_config SET value = '0.99' WHERE key = 'commission_rate'");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const r = await db.query<{ value: string }>("SELECT value FROM app_config WHERE key = 'commission_rate'");
    expect(r.rows[0]!.value).toBe('0.20');
  });
});
