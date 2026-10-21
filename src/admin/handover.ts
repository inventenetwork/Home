import { Router } from 'express';
import { z } from 'zod';
import { loadBookingSettings } from '../bookings/settings.js';
import { localDateString } from '../bookings/availability.js';
import { TransitionError } from '../bookings/status.js';
import { setStatus, transitionHttpStatus } from '../bookings/transition.js';
import type { Db } from '../db/index.js';
import { startMatching } from '../matching/service.js';
import { audit } from './audit.js';

const UUID = z.string().uuid();

/**
 * Jobs that are booked with a provider who can no longer do them: the account or the application is suspended, or the
 * provider took that day off after accepting. The admin either assigns someone by hand (existing assign route) or sends the job back to matching.
 */
export function adminHandoverRouter(db: Db, now: () => Date): Router {
  const router = Router();

  router.get('/handover', async (_req, res, next) => {
    try {
      const t = now();
      const { rows } = await db.query<Record<string, any>>(
        `SELECT b.id, b.scheduled_at, b.duration_minutes, s.name_en AS service, ar.name AS area,
                cu.email AS customer_email, pu.email AS provider_email, pu.full_name AS provider_name,
                (pu.status <> 'active' OR p.vetting_status <> 'approved') AS blocked,
                EXISTS (SELECT 1 FROM provider_availability pa
                         WHERE pa.provider_id = p.id AND pa.on_date IS NOT NULL AND pa.is_available = false
                           AND pa.on_date = (b.scheduled_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AS day_off
           FROM bookings b
           JOIN booking_assignments ba ON ba.booking_id = b.id
           JOIN providers p ON p.id = ba.provider_id
           JOIN users pu ON pu.id = p.user_id
           JOIN users cu ON cu.id = b.customer_id
           JOIN services s ON s.id = b.service_id
           JOIN addresses a ON a.id = b.address_id
           LEFT JOIN areas ar ON ar.id = a.area_id
          WHERE b.status = 'confirmed' AND b.scheduled_at > $1
            AND (pu.status <> 'active' OR p.vetting_status <> 'approved'
                 OR EXISTS (SELECT 1 FROM provider_availability pa
                             WHERE pa.provider_id = p.id AND pa.on_date IS NOT NULL AND pa.is_available = false
                               AND pa.on_date = (b.scheduled_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
          ORDER BY b.scheduled_at LIMIT 200`,
        [t],
      );
      res.json({
        jobs: rows.map((r) => ({
          bookingId: r.id as string,
          service: r.service as string,
          area: (r.area as string | null) ?? null,
          scheduledAt: new Date(r.scheduled_at).toISOString(),
          localDate: localDateString(new Date(r.scheduled_at)),
          durationMinutes: r.duration_minutes as number,
          customer: r.customer_email as string,
          provider: (r.provider_name as string | null) ?? (r.provider_email as string),
          reason: r.blocked ? 'provider_blocked' : 'day_off',
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Takes the job away from its provider and offers it to others (never the same provider again). Only for jobs not yet started. */
  router.post('/bookings/:id/rematch', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const t = now();
      const settings = await loadBookingSettings(db);
      try {
        const out = await db.tx(async (tx) => {
          const prev = (await tx.query<{ provider_id: string }>('SELECT provider_id FROM booking_assignments WHERE booking_id = $1', [id.data])).rows[0];
          await setStatus(tx, id.data, 'offered', 'admin', t); // only a confirmed job may go back; anything else is refused by the status machine
          await tx.query('DELETE FROM booking_assignments WHERE booking_id = $1', [id.data]);
          const m = await startMatching(tx, id.data, 'admin', t, settings);
          await audit(tx, req.user!.id, 'booking.rematch', 'booking', id.data, { previousProviderId: prev?.provider_id ?? null, offeredTo: m.offeredTo.length });
          return { offered: m.offeredTo.length };
        });
        res.json({ id: id.data, status: 'offered', ...out });
      } catch (err) {
        if (err instanceof TransitionError) return res.status(transitionHttpStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
