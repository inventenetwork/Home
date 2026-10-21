import { Router } from 'express';
import { z } from 'zod';
import { langSchema } from '../catalog/repo.js';
import type { Db } from '../db/index.js';
import { createBooking, createBookingBody } from './create.js';
import type { PaymentGateway } from '../payments/gateway.js';
import { refundBooking } from '../payments/service.js';
import { loadBookingSettings } from './settings.js';
import { TransitionError } from './status.js';
import { setStatus, transitionHttpStatus } from './transition.js';
import { loadBookingView } from './view.js';

const UUID = z.string().uuid();

const cancelBody = z.object({ reason: z.string().trim().max(300).optional() }).strict();

const HOUR = 3600_000;

/** Customer bookings. Mounted behind requireAuth; every query is scoped to the logged-in user. */
export function bookingsRouter(db: Db, gateway: PaymentGateway, now: () => Date): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const lang = langSchema.parse(req.query.lang);
      const parsed = createBookingBody.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'invalid_request',
          details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
        });
      }
      const made = await createBooking(db, req.user!.id, parsed.data, now());
      if (!made.ok) return res.status(made.status).json(made.body);
      const bookingId = made.id;
      res.status(201).json(await loadBookingView(db, bookingId, lang, { customerId: req.user!.id }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const lang = langSchema.parse(req.query.lang);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
      const { rows } = await db.query<{ id: string }>(
        'SELECT id FROM bookings WHERE customer_id = $1 ORDER BY scheduled_at DESC, id LIMIT $2',
        [req.user!.id, limit],
      );
      const bookings = [];
      for (const r of rows) bookings.push(await loadBookingView(db, r.id, lang, { customerId: req.user!.id }));
      res.json({ bookings });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const lang = langSchema.parse(req.query.lang);
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const view = await loadBookingView(db, id.data, lang, { customerId: req.user!.id });
      if (!view) return res.status(404).json({ error: 'not_found' });
      res.json(view);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/cancel', async (req, res, next) => {
    try {
      const lang = langSchema.parse(req.query.lang);
      const id = UUID.safeParse(req.params.id);
      const body = cancelBody.safeParse(req.body ?? {});
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });

      const cur = (
        await db.query<{ status: string; scheduled_at: Date }>(
          'SELECT status, scheduled_at FROM bookings WHERE id = $1 AND customer_id = $2',
          [id.data, req.user!.id],
        )
      ).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });

      if (cur.status === 'confirmed') {
        const settings = await loadBookingSettings(db);
        const msUntil = new Date(cur.scheduled_at).getTime() - now().getTime();
        if (msUntil < settings.freeCancelHours * HOUR) {
          return res.status(400).json({
            error: 'too_late_to_cancel',
            message: `Confirmed bookings can be cancelled until ${settings.freeCancelHours} hours before they start. Please contact support.`,
          });
        }
      }

      try {
        await db.tx((tx) => setStatus(tx, id.data, 'cancelled', 'customer', now(), { reason: body.data.reason ?? 'customer_cancelled' }));
      } catch (err) {
        if (err instanceof TransitionError) return res.status(transitionHttpStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
      // Cancelled within the allowed window: whatever was paid goes back in full. (No payment yet = nothing to refund.)
      await refundBooking(db, gateway, id.data, { reason: 'customer_cancelled', createdBy: null }, now());
      res.json(await loadBookingView(db, id.data, lang, { customerId: req.user!.id }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
