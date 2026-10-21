import { Router } from 'express';
import { z } from 'zod';
import { DisputeError, resolveDispute } from '../disputes/service.js';
import type { Db } from '../db/index.js';
import type { PaymentGateway } from '../payments/gateway.js';
import { paymentErrorStatus } from '../payments/routes.js';
import { PaymentError } from '../payments/service.js';
import { loadProviderSettings } from '../provider/settings.js';

const UUID = z.string().uuid();
const resolveBody = z
  .object({
    outcome: z.enum(['refund', 'redo', 'reject']),
    note: z.string().trim().min(3).max(500),
    amountCents: z.number().int().positive().optional(),
    chargeProvider: z.boolean().optional(),
  })
  .strict();

/** Dispute desk. Mounted behind requireAuth + requireRole('admin'). */
export function adminDisputesRouter(db: Db, gateway: PaymentGateway, now: () => Date): Router {
  const router = Router();

  router.get('/disputes', async (req, res, next) => {
    try {
      const status = req.query.status === 'all' ? 'all' : 'open';
      const { rows } = await db.query<Record<string, any>>(
        `SELECT d.id, d.booking_id, d.status, d.reason, d.resolution_note, d.refund_cents, d.created_at, d.resolved_at,
                b.total_cents, b.scheduled_at, s.name_en AS service,
                cu.email AS customer_email, cu.full_name AS customer_name,
                pu.email AS provider_email, pu.full_name AS provider_name,
                ba.checkin_photo_url IS NOT NULL AS has_before, ba.checkout_photo_url IS NOT NULL AS has_after,
                (SELECT count(*) FROM messages m WHERE m.booking_id = b.id) AS messages,
                (SELECT status FROM payments p WHERE p.booking_id = b.id AND p.status IN ('held','refunded','released') ORDER BY p.created_at DESC LIMIT 1) AS payment_status,
                (SELECT amount_cents - refunded_cents FROM payments p WHERE p.booking_id = b.id AND p.status = 'held' LIMIT 1) AS refundable_cents,
                (SELECT net_cents FROM payouts po WHERE po.booking_id = b.id LIMIT 1) AS payout_cents
           FROM disputes d
           JOIN bookings b ON b.id = d.booking_id
           JOIN services s ON s.id = b.service_id
           JOIN users cu ON cu.id = b.customer_id
           LEFT JOIN booking_assignments ba ON ba.booking_id = b.id
           LEFT JOIN providers pr ON pr.id = ba.provider_id
           LEFT JOIN users pu ON pu.id = pr.user_id
          WHERE ($1 = 'all' OR d.status = 'open')
          ORDER BY d.created_at DESC LIMIT 100`,
        [status],
      );
      res.json({
        disputes: rows.map((r) => ({
          id: r.id as string,
          bookingId: r.booking_id as string,
          status: r.status as string,
          reason: r.reason as string,
          resolutionNote: (r.resolution_note as string | null) ?? null,
          refundCents: (r.refund_cents as number | null) ?? null,
          openedAt: new Date(r.created_at).toISOString(),
          resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
          service: r.service as string,
          scheduledAt: new Date(r.scheduled_at).toISOString(),
          totalCents: r.total_cents as number,
          customer: (r.customer_name as string | null) ?? (r.customer_email as string),
          provider: ((r.provider_name as string | null) ?? (r.provider_email as string | null)) ?? null,
          photos: { before: r.has_before as boolean, after: r.has_after as boolean },
          messages: Number(r.messages),
          paymentStatus: (r.payment_status as string | null) ?? null,
          refundableCents: (r.refundable_cents as number | null) ?? 0,
          payoutCents: (r.payout_cents as number | null) ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Read-only look at the chat of a booking, for judging a dispute. */
  router.get('/bookings/:id/messages', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const { rows } = await db.query<Record<string, any>>(
        `SELECT m.id, m.body, m.created_at, (m.sender_id = b.customer_id) AS from_customer
           FROM messages m JOIN bookings b ON b.id = m.booking_id WHERE m.booking_id = $1 ORDER BY m.created_at, m.id LIMIT 300`,
        [id.data],
      );
      res.json({ messages: rows.map((r) => ({ id: r.id as string, from: r.from_customer ? 'customer' : 'provider', body: r.body as string, createdAt: new Date(r.created_at).toISOString() })) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/disputes/:id/resolve', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = resolveBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request', message: 'Choose an outcome and write a short note.' });
      if (body.data.outcome !== 'refund' && (body.data.amountCents !== undefined || body.data.chargeProvider)) {
        return res.status(400).json({ error: 'invalid_request', message: 'Amount and charge-provider only apply to refunds.' });
      }
      try {
        await resolveDispute(db, gateway, req.user!.id, id.data, body.data, await loadProviderSettings(db), now());
      } catch (err) {
        if (err instanceof DisputeError) return res.status(err.code === 'not_found' ? 404 : 409).json({ error: err.code, message: err.message });
        if (err instanceof PaymentError) return res.status(paymentErrorStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
      res.json({ id: id.data, resolved: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
