import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { ImageStore } from '../storage.js';
import { sendImage } from './onboarding.js';

const UUID = z.string().uuid();

/**
 * Before/after job photos, viewable by the customer who booked, the assigned provider, and admins.
 * Everyone else gets 404, exactly as if the photo did not exist. Mounted at /bookings behind requireAuth.
 */
export function bookingPhotosRouter(db: Db, store: ImageStore): Router {
  const router = Router();
  router.get('/:id/photos/:kind', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const kind = req.params.kind;
      if (!id.success || (kind !== 'before' && kind !== 'after')) return res.status(404).json({ error: 'not_found' });
      const u = req.user!;
      const row = (
        await db.query<{ customer_id: string; provider_user_id: string; checkin_photo_url: string | null; checkout_photo_url: string | null }>(
          `SELECT b.customer_id, p.user_id AS provider_user_id, ba.checkin_photo_url, ba.checkout_photo_url
             FROM bookings b
             JOIN booking_assignments ba ON ba.booking_id = b.id
             JOIN providers p ON p.id = ba.provider_id
            WHERE b.id = $1`,
          [id.data],
        )
      ).rows[0];
      const allowed = row && (u.role === 'admin' || row.customer_id === u.id || row.provider_user_id === u.id);
      const key = row ? (kind === 'before' ? row.checkin_photo_url : row.checkout_photo_url) : null;
      if (!allowed || !key) return res.status(404).json({ error: 'not_found' });
      sendImage(res, await store.read(key));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
