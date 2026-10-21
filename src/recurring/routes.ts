import { Router } from 'express';
import { z } from 'zod';
import { createBooking } from '../bookings/create.js';
import type { Db } from '../db/index.js';

const UUID = z.string().uuid();
type Fail = { fail: { status: number; body: object } };
const MS_DAY = 86_400_000;
const MYT = 8 * 3_600_000;

const createBody = z
  .object({
    serviceSlug: z.string().min(1).max(60),
    addressId: z.string().uuid(),
    scheduledAt: z.string().datetime({ offset: true }),
    units: z.number().int().positive().max(50).optional(),
    options: z.array(z.object({ group: z.string().min(1).max(40), code: z.string().min(1).max(40) }).strict()).max(20).default([]),
    notes: z.string().trim().max(500).optional(),
    frequency: z.enum(['weekly', 'biweekly', 'monthly']),
    sessions: z.number().int().min(2).max(26).nullable().default(null), // null = until cancelled
    keepProvider: z.boolean().default(true),
  })
  .strict();
const nextBody = z.object({ scheduledAt: z.string().datetime({ offset: true }).optional() }).strict();
const patchBody = z.object({ status: z.enum(['active', 'paused', 'cancelled']) }).strict();

/** The date one frequency step after `from`. Monthly keeps the same day of month (clamped) and the same Malaysian clock time. */
export function addFrequency(from: Date, f: 'weekly' | 'biweekly' | 'monthly'): Date {
  if (f === 'weekly') return new Date(from.getTime() + 7 * MS_DAY);
  if (f === 'biweekly') return new Date(from.getTime() + 14 * MS_DAY);
  const l = new Date(from.getTime() + MYT); // shift so UTC getters read Malaysian wall time
  const day = l.getUTCDate();
  const target = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + 1, 1, l.getUTCHours(), l.getUTCMinutes()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return new Date(target.getTime() - MYT);
}

/** Recurring plans. A plan remembers what to book; each visit is a normal booking the customer pays for. Mounted behind requireAuth. */
export function recurringRouter(db: Db, now: () => Date): Router {
  const router = Router();

  const view = (r: Record<string, any>) => ({
    id: r.id as string,
    status: r.status as string,
    frequency: r.frequency as string,
    sessionsTotal: (r.sessions_total as number | null) ?? null,
    sessionsRemaining: (r.sessions_remaining as number | null) ?? null,
    keepProvider: r.keep_provider as boolean,
    nextAt: r.next_at ? new Date(r.next_at).toISOString() : null,
    service: { slug: r.slug as string, name: r.name_en as string },
    addressLabel: r.addr_label as string,
    awaitingPaymentBookingId: (r.unpaid_booking as string | null) ?? null,
  });
  const SELECT = `SELECT rp.*, s.slug, s.name_en, a.label AS addr_label,
                         (SELECT id FROM bookings b WHERE b.recurring_plan_id = rp.id AND b.status = 'pending' ORDER BY b.created_at DESC LIMIT 1) AS unpaid_booking
                    FROM recurring_plans rp JOIN services s ON s.id = rp.service_id JOIN addresses a ON a.id = rp.address_id`;

  router.post('/', async (req, res, next) => {
    try {
      const p = createBody.safeParse(req.body);
      if (!p.success) return res.status(400).json({ error: 'invalid_request', details: p.error.flatten() });
      const d = p.data;
      const t = now();
      const first = new Date(d.scheduledAt);
      const planId = await db.tx<Fail | { fail?: undefined; planId: string; bookingId: string }>(async (tx) => {
        const svc = (await tx.query<{ id: string }>('SELECT id FROM services WHERE slug = $1 AND active', [d.serviceSlug])).rows[0];
        if (!svc) return { fail: { status: 404, body: { error: 'service_not_found' } } };
        const addr = (await tx.query('SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2', [d.addressId, req.user!.id])).rows[0];
        if (!addr) return { fail: { status: 404, body: { error: 'address_not_found' } } };
        const plan = await tx.query<{ id: string }>(
          `INSERT INTO recurring_plans (customer_id, service_id, address_id, frequency, sessions_total, sessions_remaining, units, options, notes, next_at, keep_provider, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$12) RETURNING id`,
          [req.user!.id, svc.id, d.addressId, d.frequency, d.sessions, d.sessions, d.units ?? null, JSON.stringify(d.options), d.notes ?? null, first, d.keepProvider, t],
        );
        const planId = plan.rows[0]!.id;
        const r = await createBooking(tx, req.user!.id, { serviceSlug: d.serviceSlug, addressId: d.addressId, scheduledAt: d.scheduledAt, units: d.units, options: d.options, notes: d.notes }, t, planId);
        if (!r.ok) return { fail: { status: r.status, body: r.body } };
        await advance(tx, planId, first, d.frequency, d.sessions, t);
        return { planId, bookingId: r.id };
      });
      if (planId.fail) return res.status(planId.fail.status).json(planId.fail.body);
      res.status(201).json({ id: planId.planId, bookingId: planId.bookingId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query<Record<string, any>>(`${SELECT} WHERE rp.customer_id = $1 ORDER BY rp.created_at DESC LIMIT 50`, [req.user!.id]);
      res.json({ plans: rows.map(view) });
    } catch (err) {
      next(err);
    }
  });

  /** "Book next visit": creates the next booking of an active plan. The customer then pays for it as usual. */
  router.post('/:id/next', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = nextBody.safeParse(req.body ?? {});
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const t = now();
      const out = await db.tx<Fail | { fail?: undefined; bookingId: string }>(async (tx) => {
        const plan = (await tx.query<Record<string, any>>('SELECT * FROM recurring_plans WHERE id = $1 AND customer_id = $2 FOR UPDATE', [id.data, req.user!.id])).rows[0];
        if (!plan) return { fail: { status: 404, body: { error: 'not_found' } } };
        if (plan.status !== 'active') return { fail: { status: 409, body: { error: 'plan_not_active', message: 'This plan is not active.' } } };
        const unpaid = (await tx.query('SELECT 1 FROM bookings WHERE recurring_plan_id = $1 AND status = $2', [id.data, 'pending'])).rows[0];
        if (unpaid) return { fail: { status: 409, body: { error: 'payment_pending', message: 'Pay for the current visit first.' } } };
        const slug = (await tx.query<{ slug: string }>('SELECT slug FROM services WHERE id = $1', [plan.service_id])).rows[0]!.slug;
        const at = body.data.scheduledAt ? new Date(body.data.scheduledAt) : plan.next_at ? new Date(plan.next_at) : null;
        if (!at) return { fail: { status: 409, body: { error: 'no_next_date' } } };
        const r = await createBooking(tx, req.user!.id, { serviceSlug: slug, addressId: plan.address_id, scheduledAt: at.toISOString(), units: plan.units ?? undefined, options: plan.options ?? [], notes: plan.notes ?? undefined }, t, id.data);
        if (!r.ok) return { fail: { status: r.status, body: r.body } };
        await advance(tx, id.data, at, plan.frequency, plan.sessions_remaining, t);
        return { bookingId: r.id };
      });
      if (out.fail) return res.status(out.fail.status).json(out.fail.body);
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const b = patchBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!b.success) return res.status(400).json({ error: 'invalid_request' });
      const cur = (await db.query<{ status: string }>('SELECT status FROM recurring_plans WHERE id = $1 AND customer_id = $2', [id.data, req.user!.id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      if (cur.status === 'cancelled' || cur.status === 'completed') return res.status(409).json({ error: 'plan_closed', message: 'This plan is already closed.' });
      await db.query('UPDATE recurring_plans SET status = $2, updated_at = $3 WHERE id = $1', [id.data, b.data.status, now()]);
      res.json({ id: id.data, status: b.data.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** One visit has been booked: use up a session, move next_at forward, close the plan when the last session is booked. */
async function advance(tx: Db, planId: string, booked: Date, f: 'weekly' | 'biweekly' | 'monthly', remaining: number | null, t: Date) {
  const left = remaining === null ? null : remaining - 1;
  await tx.query(
    `UPDATE recurring_plans SET sessions_remaining = $2, next_at = $3, status = CASE WHEN $2::int = 0 THEN 'completed' ELSE status END, updated_at = $4 WHERE id = $1`,
    [planId, left, left === 0 ? null : addFrequency(booked, f), t],
  );
}
