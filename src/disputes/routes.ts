import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { DisputeError, openDispute } from './service.js';

const UUID = z.string().uuid();
const body = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();

/** POST /bookings/:id/dispute. Mounted at /bookings behind requireAuth. */
export function disputesRouter(db: Db, now: () => Date): Router {
  const router = Router();
  router.post('/:id/dispute', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const b = body.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!b.success) return res.status(400).json({ error: 'reason_too_short', message: 'Please describe the problem (at least 10 characters).' });
      try {
        const disputeId = await openDispute(db, req.user!.id, id.data, b.data.reason, now());
        res.status(201).json({ id: disputeId, bookingId: id.data, status: 'open' });
      } catch (err) {
        if (err instanceof DisputeError) return res.status(err.code === 'not_found' ? 404 : 409).json({ error: err.code, message: err.message });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });
  return router;
}
