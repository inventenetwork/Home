import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db/index.js';
import { recordPayoutForCompletedBooking } from '../payouts/service.js';
import { loadProviderSettings } from '../provider/settings.js';
import { acceptOffer, declineOffer, expireStaleOffers } from '../matching/service.js';
import type { LineItem } from '../pricing/calculate.js';
import { formatLocalTime, localDateString } from './availability.js';
import { loadBookingSettings } from './settings.js';
import { TransitionError } from './status.js';
import { setStatus, transitionHttpStatus } from './transition.js';

const UUID = z.string().uuid();
const statusBody = z.object({ status: z.enum(['on_the_way', 'in_progress', 'completed']) }).strict();

/** Only approved providers may see or work jobs. Sets res.locals.providerId. */
export function requireApprovedProvider(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = (
        await db.query<{ id: string }>("SELECT id FROM providers WHERE user_id = $1 AND vetting_status = 'approved'", [req.user!.id])
      ).rows[0];
      if (!p) return res.status(403).json({ error: 'provider_not_approved' });
      res.locals.providerId = p.id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Jobs assigned to the logged-in provider. Mounted behind requireAuth + requireRole('provider'). */
export function providerRouter(db: Db, now: () => Date): Router {
  const router = Router();

  router.use(requireApprovedProvider(db));

  /**
   * Open offers for this provider. Deliberately shows only the area (not the street address) and no notes
   * until the provider accepts: the full address is released with the job in /provider/jobs.
   */
  router.get('/offers', async (req, res, next) => {
    try {
      const providerId = res.locals.providerId as string;
      const t = now();
      await expireStaleOffers(db, t);
      const { rows } = await db.query<Record<string, any>>(
        `SELECT b.id, b.scheduled_at, b.duration_minutes, b.units, b.price_breakdown,
                s.name_en, s.name_ms, ar.name AS area_name, jo.expires_at
           FROM job_offers jo
           JOIN bookings b ON b.id = jo.booking_id AND b.status = 'offered'
           JOIN services s ON s.id = b.service_id
           JOIN addresses a ON a.id = b.address_id
           LEFT JOIN areas ar ON ar.id = a.area_id
          WHERE jo.provider_id = $1 AND jo.status = 'offered' AND jo.expires_at > $2
          ORDER BY jo.expires_at, b.scheduled_at
          LIMIT 50`,
        [providerId, t],
      );
      const lang = req.query.lang === 'ms' ? 'ms' : 'en';
      res.json({
        offers: rows.map((r) => {
          const start = new Date(r.scheduled_at);
          const breakdown = r.price_breakdown as { providerEarningsCents?: number };
          return {
            bookingId: r.id as string,
            service: lang === 'ms' ? (r.name_ms as string) : (r.name_en as string),
            scheduledAt: start.toISOString(),
            localDate: localDateString(start),
            localTime: formatLocalTime(start),
            durationMinutes: r.duration_minutes as number,
            units: r.units as number,
            area: (r.area_name as string | null) ?? null,
            earningsCents: breakdown.providerEarningsCents ?? 0,
            expiresAt: new Date(r.expires_at).toISOString(),
            secondsLeft: Math.max(0, Math.floor((new Date(r.expires_at).getTime() - t.getTime()) / 1000)),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/offers/:id/accept', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const settings = await loadBookingSettings(db);
      const result = await acceptOffer(db, res.locals.providerId as string, id.data, now(), settings);
      if (result.ok) return res.json({ id: id.data, status: 'confirmed' });
      const status = result.code === 'offer_not_found' ? 404 : 409;
      res.status(status).json({ error: result.code });
    } catch (err) {
      next(err);
    }
  });

  router.post('/offers/:id/decline', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const ok = await declineOffer(db, res.locals.providerId as string, id.data, now());
      if (!ok) return res.status(404).json({ error: 'offer_not_found' });
      res.json({ id: id.data, declined: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs', async (req, res, next) => {
    try {
      const providerId = res.locals.providerId as string;
      const all = req.query.status === 'all';
      const { rows } = await db.query<Record<string, any>>(
        `SELECT b.id, b.status, b.scheduled_at, b.duration_minutes, b.units, b.notes, b.price_breakdown,
                s.name_en AS service_name, a.label, a.line1, a.line2, a.postcode, ar.name AS area_name,
                cu.full_name AS customer_name, ba.checked_in_at, ba.checked_out_at,
                ba.checkin_photo_url IS NOT NULL AS has_before, ba.checkout_photo_url IS NOT NULL AS has_after
           FROM booking_assignments ba
           JOIN bookings b ON b.id = ba.booking_id
           JOIN services s ON s.id = b.service_id
           JOIN addresses a ON a.id = b.address_id
           LEFT JOIN areas ar ON ar.id = a.area_id
           JOIN users cu ON cu.id = b.customer_id
          WHERE ba.provider_id = $1
            ${all ? '' : "AND b.status IN ('confirmed','on_the_way','in_progress')"}
          ORDER BY b.scheduled_at
          LIMIT 100`,
        [providerId],
      );
      const settings = await loadProviderSettings(db);
      res.json({
        requireAfterPhoto: settings.requireAfterPhoto,
        jobs: rows.map((r) => {
          const start = new Date(r.scheduled_at);
          const breakdown = r.price_breakdown as { providerEarningsCents?: number; lineItems?: LineItem[] };
          return {
            id: r.id as string,
            status: r.status as string,
            service: r.service_name as string,
            scheduledAt: start.toISOString(),
            localDate: localDateString(start),
            localTime: formatLocalTime(start),
            durationMinutes: r.duration_minutes as number,
            units: r.units as number,
            notes: (r.notes as string | null) ?? null,
            // The address is shared only because this provider is assigned. Phone numbers are never shared.
            address: { label: r.label, line1: r.line1, line2: r.line2 ?? null, postcode: r.postcode, area: r.area_name ?? null },
            customerFirstName: r.customer_name ? String(r.customer_name).split(' ')[0] : null,
            earningsCents: breakdown.providerEarningsCents ?? 0,
            checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
            checkedOutAt: r.checked_out_at ? new Date(r.checked_out_at).toISOString() : null,
            photos: { before: r.has_before as boolean, after: r.has_after as boolean },
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/status', async (req, res, next) => {
    try {
      const providerId = res.locals.providerId as string;
      const id = UUID.safeParse(req.params.id);
      const body = statusBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });

      const mine = await db.query('SELECT 1 FROM booking_assignments WHERE booking_id = $1 AND provider_id = $2', [id.data, providerId]);
      if (mine.rowCount === 0) return res.status(404).json({ error: 'not_found' }); // someone else's job looks like no job

      const to = body.data.status;
      const t = now();
      const settings = await loadProviderSettings(db);
      if (to === 'completed' && settings.requireAfterPhoto) {
        const ph = await db.query<{ checkout_photo_url: string | null }>('SELECT checkout_photo_url FROM booking_assignments WHERE booking_id = $1', [id.data]);
        if (!ph.rows[0]?.checkout_photo_url) {
          return res.status(409).json({ error: 'after_photo_required', message: 'Add an after photo before finishing the job.' });
        }
      }
      try {
        await db.tx(async (tx) => {
          await setStatus(tx, id.data, to, 'provider', t);
          if (to === 'in_progress') {
            await tx.query('UPDATE booking_assignments SET checked_in_at = $2 WHERE booking_id = $1', [id.data, t]);
          }
          if (to === 'completed') {
            await tx.query('UPDATE booking_assignments SET checked_out_at = $2 WHERE booking_id = $1', [id.data, t]);
            await tx.query('UPDATE providers SET jobs_completed = jobs_completed + 1 WHERE id = $1', [providerId]);
            await recordPayoutForCompletedBooking(tx, id.data, settings, t);
          }
        });
      } catch (err) {
        if (err instanceof TransitionError) return res.status(transitionHttpStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
      res.json({ id: id.data, status: to });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
