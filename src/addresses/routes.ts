import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';

const UUID = z.string().uuid();

const addressBody = z
  .object({
    label: z.string().trim().min(1).max(40).default('Home'),
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    postcode: z.string().regex(/^\d{5}$/, 'Malaysian postcodes have 5 digits'),
    areaSlug: z.string().max(60),
    propertyType: z.enum(['apartment', 'terrace', 'semi_d', 'bungalow', 'other']).optional(),
    sizeSqft: z.number().int().min(100).max(100_000).optional(),
    notes: z.string().max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .strict();

const out = (r: Record<string, any>) => ({
  id: r.id as string,
  label: r.label as string,
  line1: r.line1 as string,
  line2: (r.line2 as string | null) ?? null,
  postcode: r.postcode as string,
  area: r.area_slug ? { slug: r.area_slug as string, name: r.area_name as string } : null,
  propertyType: (r.property_type as string | null) ?? null,
  sizeSqft: (r.size_sqft as number | null) ?? null,
  notes: (r.notes as string | null) ?? null,
});

const SELECT = `SELECT a.*, ar.slug AS area_slug, ar.name AS area_name
                  FROM addresses a LEFT JOIN areas ar ON ar.id = a.area_id`;

/** Public list of the areas we currently serve. */
export function areasRouter(db: Db): Router {
  const router = Router();
  router.get('/', async (_req, res, next) => {
    try {
      const { rows } = await db.query<{ slug: string; name: string; state: string }>(
        'SELECT slug, name, state FROM areas WHERE active ORDER BY state, name',
      );
      res.json({ areas: rows });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

/** A logged-in user's saved addresses. Mounted behind requireAuth. */
export function addressesRouter(db: Db): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(`${SELECT} WHERE a.user_id = $1 ORDER BY a.created_at`, [req.user!.id]);
      res.json({ addresses: rows.map(out) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const body = addressBody.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          error: 'invalid_request',
          details: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
        });
      }
      const b = body.data;
      const area = (await db.query<{ id: string }>('SELECT id FROM areas WHERE slug = $1 AND active', [b.areaSlug])).rows[0];
      if (!area) return res.status(400).json({ error: 'area_not_served', message: 'We do not serve that area yet.' });

      const ins = await db.query<{ id: string }>(
        `INSERT INTO addresses (user_id, label, line1, line2, postcode, area_id, lat, lng, property_type, size_sqft, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [req.user!.id, b.label, b.line1, b.line2 ?? null, b.postcode, area.id, b.lat ?? null, b.lng ?? null,
         b.propertyType ?? null, b.sizeSqft ?? null, b.notes ?? null],
      );
      const row = (await db.query(`${SELECT} WHERE a.id = $1`, [ins.rows[0]!.id])).rows[0]!;
      res.status(201).json(out(row));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const mine = await db.query('SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2', [id.data, req.user!.id]);
      if (mine.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      const used = await db.query('SELECT 1 FROM bookings WHERE address_id = $1 LIMIT 1', [id.data]);
      if (used.rowCount > 0) {
        return res.status(409).json({ error: 'address_in_use', message: 'This address has bookings, so it cannot be deleted.' });
      }
      await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [id.data, req.user!.id]);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
