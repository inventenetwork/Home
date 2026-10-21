import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { ReviewError, addReview } from './service.js';

const UUID = z.string().uuid();
const body = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }).strict();

/** POST /bookings/:id/review. Mounted at /bookings behind requireAuth. */
export function reviewsRouter(db: Db, now: () => Date): Router {
  const router = Router();
  router.post('/:id/review', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const b = body.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!b.success) return res.status(400).json({ error: 'invalid_request' });
      try {
        await addReview(db, req.user!.id, id.data, b.data.rating, b.data.comment || null, now());
      } catch (err) {
        if (err instanceof ReviewError) return res.status(err.code === 'not_found' ? 404 : 409).json({ error: err.code, message: err.message });
        throw err;
      }
      res.status(201).json({ id: id.data, rating: b.data.rating });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
