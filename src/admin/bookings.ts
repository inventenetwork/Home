import { Router } from 'express';
import { z } from 'zod';
import { BOOKING_STATUSES, TransitionError } from '../bookings/status.js';
import {
  eligibleProviderIds,
  loadDayContext,
  localDateString,
  localMinutes,
  providerIsFree,
  slotStatus,
} from '../bookings/availability.js';
import { loadBookingSettings } from '../bookings/settings.js';
import { setStatus, transitionHttpStatus } from '../bookings/transition.js';
import { loadBookingView } from '../bookings/view.js';
import type { Db } from '../db/index.js';
import { rankCandidates } from '../matching/rank.js';
import { expireStaleOffers } from '../matching/service.js';
import type { PaymentGateway } from '../payments/gateway.js';
import { paymentErrorStatus } from '../payments/routes.js';
import { PaymentError, refundBooking, retryRefunds } from '../payments/service.js';
import { recordPayoutForCompletedBooking } from '../payouts/service.js';
import { loadProviderSettings } from '../provider/settings.js';
import { audit } from './audit.js';

const UUID = z.string().uuid();
const assignBody = z.object({ providerId: z.string().uuid() }).strict();
const statusBody = z
  .object({ status: z.enum(BOOKING_STATUSES), reason: z.string().trim().max(300).optional() })
  .strict();

/** Admin booking tools. Mounted behind requireAuth + requireRole('admin'). */
export function adminBookingsRouter(db: Db, gateway: PaymentGateway, now: () => Date): Router {
  const router = Router();

  /**
   * GET /admin/bookings?status=&attention=1
   * "Needs attention" = paid and offered, but no provider has it and no offer is still open (nobody free, everyone
   * declined, or the offers timed out). These are the bookings an admin must assign by hand.
   */
  router.get('/bookings', async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status && !(BOOKING_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      const attention = req.query.attention === '1';
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      await expireStaleOffers(db, now());

      const needs = `(b.status = 'offered' AND ba.booking_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM job_offers jo WHERE jo.booking_id = b.id AND jo.status = 'offered'))`;
      const where: string[] = [];
      const params: unknown[] = [];
      if (status) {
        params.push(status);
        where.push(`b.status = $${params.length}`);
      }
      if (attention) where.push(needs);
      params.push(limit);

      const { rows } = await db.query<Record<string, any>>(
        `SELECT b.id, b.status, b.scheduled_at, b.duration_minutes, b.total_cents, b.created_at,
                s.slug AS service_slug, cu.email AS customer_email, ar.slug AS area_slug,
                pu.email AS provider_email, ${needs} AS needs_attention,
                (SELECT count(*) FROM job_offers jo WHERE jo.booking_id = b.id AND jo.status = 'offered')::int AS offers_open,
                (SELECT count(*) FROM job_offers jo WHERE jo.booking_id = b.id AND jo.status = 'declined')::int AS offers_declined,
                (SELECT count(*) FROM job_offers jo WHERE jo.booking_id = b.id AND jo.status = 'expired')::int AS offers_expired,
                pay.status AS payment_status, pay.refunded_cents AS payment_refunded_cents,
                EXISTS (SELECT 1 FROM refunds r JOIN payments p2 ON p2.id = r.payment_id
                         WHERE p2.booking_id = b.id AND r.status <> 'succeeded') AS refund_pending
           FROM bookings b
           JOIN services s ON s.id = b.service_id
           JOIN users cu ON cu.id = b.customer_id
           JOIN addresses a ON a.id = b.address_id
           LEFT JOIN areas ar ON ar.id = a.area_id
           LEFT JOIN booking_assignments ba ON ba.booking_id = b.id
           LEFT JOIN providers p ON p.id = ba.provider_id
           LEFT JOIN users pu ON pu.id = p.user_id
           LEFT JOIN LATERAL (SELECT status, refunded_cents FROM payments pm WHERE pm.booking_id = b.id
                               ORDER BY (pm.status IN ('held','released','refunded')) DESC, pm.created_at DESC LIMIT 1) pay ON true
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY b.scheduled_at DESC, b.id
          LIMIT $${params.length}`,
        params,
      );
      res.json({
        bookings: rows.map((r) => ({
          id: r.id,
          status: r.status,
          service: r.service_slug,
          area: r.area_slug ?? null,
          scheduledAt: new Date(r.scheduled_at).toISOString(),
          durationMinutes: r.duration_minutes,
          totalCents: r.total_cents,
          customerEmail: r.customer_email,
          providerEmail: r.provider_email ?? null,
          needsAttention: r.needs_attention === true,
          offers: { open: r.offers_open, declined: r.offers_declined, expired: r.offers_expired },
          payment: r.payment_status ? { status: r.payment_status as string, refundedCents: r.payment_refunded_cents as number, refundPending: r.refund_pending === true } : null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Providers an admin could assign right now: qualified, in the area, and free at that time. Best match first. */
  router.get('/bookings/:id/candidates', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const b = (
        await db.query<{ service_id: string; area_id: string | null; scheduled_at: Date; duration_minutes: number }>(
          `SELECT b.service_id, a.area_id, b.scheduled_at, b.duration_minutes
             FROM bookings b JOIN addresses a ON a.id = b.address_id WHERE b.id = $1`,
          [id.data],
        )
      ).rows[0];
      if (!b) return res.status(404).json({ error: 'not_found' });
      if (!b.area_id) return res.json({ candidates: [] });

      const settings = await loadBookingSettings(db);
      const start = new Date(b.scheduled_at);
      const eligible = await eligibleProviderIds(db, b.service_id, b.area_id);
      const ctx = await loadDayContext(db, eligible, b.area_id, localDateString(start), id.data);
      const free = eligible.filter((pid) => providerIsFree(ctx, pid, localMinutes(start), b.duration_minutes, settings));
      if (free.length === 0) return res.json({ candidates: [] });

      const ph = free.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await db.query<Record<string, any>>(
        `SELECT p.id, u.email, u.full_name, p.rating_avg, p.rating_count, p.jobs_completed, p.offers_received
           FROM providers p JOIN users u ON u.id = p.user_id WHERE p.id IN (${ph})`,
        free,
      );
      const ranked = rankCandidates(
        rows.map((r) => ({
          providerId: r.id as string,
          ratingAvg: Number(r.rating_avg),
          ratingCount: r.rating_count as number,
          offersReceived: r.offers_received as number,
          row: r,
        })),
      );
      res.json({
        candidates: ranked.map((c) => ({
          providerId: c.providerId,
          email: c.row.email,
          name: c.row.full_name ?? null,
          ratingAvg: c.ratingAvg,
          ratingCount: c.ratingCount,
          jobsCompleted: c.row.jobs_completed,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Assign (or reassign) a provider. The provider must be approved, qualified, cover the area, and be free. */
  router.post('/bookings/:id/assign', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = assignBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });

      const b = (
        await db.query<{ status: string; service_id: string; area_id: string | null; scheduled_at: Date; duration_minutes: number }>(
          `SELECT b.status, b.service_id, a.area_id, b.scheduled_at, b.duration_minutes
             FROM bookings b JOIN addresses a ON a.id = b.address_id WHERE b.id = $1`,
          [id.data],
        )
      ).rows[0];
      if (!b) return res.status(404).json({ error: 'not_found' });
      if (!['pending', 'offered', 'confirmed'].includes(b.status)) {
        return res.status(409).json({ error: 'invalid_transition', message: `A ${b.status} booking cannot be assigned.` });
      }
      if (!b.area_id) return res.status(400).json({ error: 'area_not_served' });

      const eligible = await eligibleProviderIds(db, b.service_id, b.area_id);
      if (!eligible.includes(body.data.providerId)) {
        return res.status(400).json({
          error: 'provider_not_eligible',
          message: 'That provider is not approved, lacks the required skills, or does not cover this area.',
        });
      }

      const settings = await loadBookingSettings(db);
      const start = new Date(b.scheduled_at);
      const ctx = await loadDayContext(db, [body.data.providerId], b.area_id, localDateString(start), id.data);
      const free = slotStatus({ ...ctx, unassigned: [] }, localMinutes(start), b.duration_minutes, settings).free;
      if (free < 1) {
        return res.status(409).json({ error: 'provider_unavailable', message: 'That provider is not free at that time.' });
      }

      const t = now();
      try {
        await db.tx(async (tx) => {
          await tx.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [id.data]);
          const existing = await tx.query('SELECT 1 FROM booking_assignments WHERE booking_id = $1', [id.data]);
          if (existing.rowCount > 0) {
            await tx.query('UPDATE booking_assignments SET provider_id = $2, accepted_at = $3 WHERE booking_id = $1', [id.data, body.data.providerId, t]);
          } else {
            await tx.query('INSERT INTO booking_assignments (booking_id, provider_id, accepted_at) VALUES ($1,$2,$3)', [id.data, body.data.providerId, t]);
          }
          if (b.status !== 'confirmed') await setStatus(tx, id.data, 'confirmed', 'admin', t);
          await audit(tx, req.user!.id, 'booking.assign', 'booking', id.data, { providerId: body.data.providerId, from: b.status });
        });
      } catch (err) {
        if (err instanceof TransitionError) return res.status(transitionHttpStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
      res.json(await loadBookingView(db, id.data));
    } catch (err) {
      next(err);
    }
  });

  /** Admin override of a status, still limited to what the status machine allows an admin to do. */
  router.post('/bookings/:id/status', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = statusBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const providerSettings = await loadProviderSettings(db);
      try {
        await db.tx(async (tx) => {
          const from = await setStatus(tx, id.data, body.data.status, 'admin', now(), { reason: body.data.reason ?? 'admin_cancelled' });
          if (body.data.status === 'cancelled') {
            await tx.query("UPDATE payouts SET status = 'failed', updated_at = $2 WHERE booking_id = $1 AND status IN ('pending','requested')", [id.data, now()]);
          }
          if (body.data.status === 'completed' && from !== 'disputed') await recordPayoutForCompletedBooking(tx, id.data, providerSettings, now());
          await audit(tx, req.user!.id, 'booking.status', 'booking', id.data, { from, to: body.data.status, reason: body.data.reason ?? null });
        });
      } catch (err) {
        if (err instanceof TransitionError) return res.status(transitionHttpStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
      if (body.data.status === 'cancelled') await refundBooking(db, gateway, id.data, { reason: body.data.reason ?? 'admin_cancelled', createdBy: req.user!.id }, now());
      res.json(await loadBookingView(db, id.data));
    } catch (err) {
      next(err);
    }
  });

  const refundBody = z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().trim().max(300).optional() }).strict();

  /** Refund all or part of what a customer paid for a booking (goodwill, a problem with the job...). */
  router.post('/bookings/:id/refund', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = refundBody.safeParse(req.body ?? {});
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      try {
        const out = await refundBooking(db, gateway, id.data, { reason: body.data.reason ?? 'admin_refund', createdBy: req.user!.id, amountCents: body.data.amountCents }, now());
        if (!out) return res.status(409).json({ error: 'no_payment_to_refund', message: 'There is no held payment on this booking to refund.' });
        res.json({ ...out, booking: await loadBookingView(db, id.data) });
      } catch (err) {
        if (err instanceof PaymentError) return res.status(paymentErrorStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  /** Ask the gateway again for refunds it has not confirmed. */
  router.post('/bookings/:id/refund/retry', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const refunds = await retryRefunds(db, gateway, id.data, now());
      await audit(db, req.user!.id, 'payment.refund_retry', 'booking', id.data, { refunds });
      res.json({ refunds });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
