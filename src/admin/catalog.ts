import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminOption, adminService, listOptions, listServices, type OptionRow, type ServiceRow } from '../catalog/repo.js';
import type { Db } from '../db/index.js';
import { audit } from './audit.js';

const UUID = z.string().uuid();
const slugRe = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const codeRe = /^[a-z0-9_]+$/;
const sen = z.number().int().min(0).max(10_000_000);

const serviceCreate = z
  .object({
    slug: z.string().max(60).regex(slugRe),
    nameEn: z.string().trim().min(1).max(120),
    nameMs: z.string().trim().min(1).max(120),
    descriptionEn: z.string().max(1000).nullable().optional(),
    descriptionMs: z.string().max(1000).nullable().optional(),
    pricingModel: z.enum(['hourly', 'per_unit', 'per_size', 'quote']),
    basePriceCents: sen.default(0),
    unitLabel: z.string().max(30).nullable().optional(),
    minUnits: z.number().int().min(1).max(50).default(1),
    fixedMinutes: z.number().int().min(0).max(1440).default(0),
    minutesPerUnit: z.number().int().min(0).max(1440).default(60),
    phase: z.number().int().min(1).max(9).default(2),
    active: z.boolean().default(false),
    skills: z.array(z.string().max(40)).max(20).default([]),
  })
  .strict()
  .refine((o) => o.fixedMinutes + o.minutesPerUnit > 0, 'A service needs a duration (fixedMinutes or minutesPerUnit)');

// pricing_model is deliberately NOT editable: changing it would invalidate the service's options.
const servicePatch = z
  .object({
    nameEn: z.string().trim().min(1).max(120),
    nameMs: z.string().trim().min(1).max(120),
    descriptionEn: z.string().max(1000).nullable(),
    descriptionMs: z.string().max(1000).nullable(),
    basePriceCents: sen,
    unitLabel: z.string().max(30).nullable(),
    minUnits: z.number().int().min(1).max(50),
    fixedMinutes: z.number().int().min(0).max(1440),
    minutesPerUnit: z.number().int().min(0).max(1440),
    active: z.boolean(),
    sortOrder: z.number().int().min(0).max(100000),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'No changes given');

const optionCreate = z
  .object({
    kind: z.enum(['choice', 'addon', 'size']),
    groupKey: z.string().max(40).regex(codeRe),
    code: z.string().max(40).regex(codeRe),
    labelEn: z.string().trim().min(1).max(120),
    labelMs: z.string().trim().min(1).max(120),
    priceCents: sen.default(0),
    perUnit: z.boolean().default(false),
    isDefault: z.boolean().default(false),
  })
  .strict();

const optionPatch = z
  .object({
    labelEn: z.string().trim().min(1).max(120),
    labelMs: z.string().trim().min(1).max(120),
    priceCents: sen,
    perUnit: z.boolean(),
    isDefault: z.boolean(),
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'No changes given');

const SERVICE_FIELDS = {
  nameEn: 'name_en',
  nameMs: 'name_ms',
  descriptionEn: 'description_en',
  descriptionMs: 'description_ms',
  basePriceCents: 'base_price_cents',
  unitLabel: 'unit_label',
  minUnits: 'min_units',
  fixedMinutes: 'fixed_minutes',
  minutesPerUnit: 'minutes_per_unit',
  active: 'active',
  sortOrder: 'sort_order',
} as const;

const OPTION_FIELDS = {
  labelEn: 'label_en',
  labelMs: 'label_ms',
  priceCents: 'price_cents',
  perUnit: 'per_unit',
  isDefault: 'is_default',
  active: 'active',
} as const;

function invalid(res: Response, error: z.ZodError) {
  return res.status(400).json({
    error: 'invalid_request',
    details: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
  });
}

/**
 * Generic partial update. Column names come from the constant maps above (never from user input),
 * values are always bound parameters. Returns null when the row does not exist.
 */
async function applyPatch(
  tx: Db,
  table: 'services' | 'service_options',
  id: string,
  fields: Record<string, string>,
  body: Record<string, unknown>,
) {
  const cur = await tx.query<Record<string, any>>(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const before = cur.rows[0];
  if (!before) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, column] of Object.entries(fields)) {
    if (body[key] === undefined) continue;
    params.push(body[key]);
    sets.push(`${column} = $${params.length}`);
    changes[key] = { from: before[column], to: body[key] };
  }
  params.push(id);
  const upd = await tx.query<Record<string, any>>(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return { after: upd.rows[0]!, changes };
}

export function adminCatalogRouter(db: Db): Router {
  const router = Router();
  const actor = (req: Request) => req.user!.id;

  // Everything, including inactive services and options.
  router.get('/services', async (_req, res, next) => {
    try {
      const services = await listServices(db, { includeInactive: true });
      const out = [];
      for (const s of services) {
        out.push({ ...adminService(s), options: (await listOptions(db, s.id, { includeInactive: true })).map(adminOption) });
      }
      res.json({ services: out });
    } catch (err) {
      next(err);
    }
  });

  // Add a brand-new service (e.g. grass cutting) without touching code. Created inactive unless told otherwise.
  router.post('/services', async (req, res, next) => {
    try {
      const body = serviceCreate.safeParse(req.body);
      if (!body.success) return invalid(res, body.error);
      const b = body.data;

      const skillIds: string[] = [];
      for (const code of b.skills) {
        const s = await db.query<{ id: string }>('SELECT id FROM skills WHERE code = $1', [code]);
        if (!s.rows[0]) return res.status(400).json({ error: 'unknown_skill', message: `Skill "${code}" does not exist.` });
        skillIds.push(s.rows[0].id);
      }
      const dup = await db.query('SELECT 1 FROM services WHERE slug = $1', [b.slug]);
      if (dup.rowCount > 0) return res.status(409).json({ error: 'slug_taken' });

      const created = await db.tx(async (tx) => {
        const ins = await tx.query<ServiceRow>(
          `INSERT INTO services
             (slug, name_en, name_ms, description_en, description_ms, pricing_model, base_price_cents,
              unit_label, min_units, phase, active, sort_order, fixed_minutes, minutes_per_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                   (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM services), $12, $13)
           RETURNING *`,
          [b.slug, b.nameEn, b.nameMs, b.descriptionEn ?? null, b.descriptionMs ?? null, b.pricingModel,
           b.basePriceCents, b.unitLabel ?? null, b.minUnits, b.phase, b.active, b.fixedMinutes, b.minutesPerUnit],
        );
        const row = ins.rows[0]!;
        for (const skillId of skillIds) {
          await tx.query('INSERT INTO service_skills (service_id, skill_id) VALUES ($1,$2)', [row.id, skillId]);
        }
        await audit(tx, actor(req), 'service.create', 'service', row.id, { slug: b.slug, pricingModel: b.pricingModel, skills: b.skills });
        return row;
      });
      res.status(201).json(adminService(created));
    } catch (err) {
      // Two admins creating the same slug at once: the unique constraint is the real guard.
      if ((err as { code?: string }).code === '23505') return res.status(409).json({ error: 'slug_taken' });
      next(err);
    }
  });

  router.patch('/services/:id', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const body = servicePatch.safeParse(req.body);
      if (!body.success) return invalid(res, body.error);

      const result = await db.tx(async (tx) => {
        const r = await applyPatch(tx, 'services', id.data, SERVICE_FIELDS, body.data);
        if (r) await audit(tx, actor(req), 'service.update', 'service', id.data, r.changes);
        return r;
      });
      if (!result) return res.status(404).json({ error: 'not_found' });
      res.json(adminService(result.after as ServiceRow));
    } catch (err) {
      // e.g. setting both durations to 0 trips the database CHECK constraint
      if ((err as { code?: string }).code === '23514') {
        return res.status(400).json({ error: 'invalid_request', details: ['A service needs a duration (fixedMinutes or minutesPerUnit)'] });
      }
      next(err);
    }
  });

  router.post('/services/:id/options', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const body = optionCreate.safeParse(req.body);
      if (!body.success) return invalid(res, body.error);
      const b = body.data;

      const svc = await db.query<{ pricing_model: string }>('SELECT pricing_model FROM services WHERE id = $1', [id.data]);
      if (!svc.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (b.kind === 'size' && svc.rows[0].pricing_model !== 'per_size') {
        return res.status(400).json({ error: 'kind_not_allowed', message: 'Size options are only for per_size services.' });
      }
      if (b.kind === 'size' && b.perUnit) {
        return res.status(400).json({ error: 'invalid_request', details: ['perUnit: size options cannot be per-unit'] });
      }
      const existing = await db.query<{ kind: string }>(
        'SELECT kind FROM service_options WHERE service_id = $1 AND group_key = $2 LIMIT 1',
        [id.data, b.groupKey],
      );
      if (existing.rows[0] && existing.rows[0].kind !== b.kind) {
        return res.status(400).json({ error: 'group_kind_mismatch', message: `Group "${b.groupKey}" already holds "${existing.rows[0].kind}" options; every option in a group must have the same kind.` });
      }
      const dup = await db.query('SELECT 1 FROM service_options WHERE service_id = $1 AND group_key = $2 AND code = $3', [id.data, b.groupKey, b.code]);
      if (dup.rowCount > 0) return res.status(409).json({ error: 'option_exists' });

      const created = await db.tx(async (tx) => {
        if (b.isDefault) {
          await tx.query('UPDATE service_options SET is_default = false WHERE service_id = $1 AND group_key = $2', [id.data, b.groupKey]);
        }
        const ins = await tx.query<OptionRow>(
          `INSERT INTO service_options (service_id, kind, group_key, code, label_en, label_ms, price_cents, per_unit, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [id.data, b.kind, b.groupKey, b.code, b.labelEn, b.labelMs, b.priceCents, b.perUnit, b.isDefault],
        );
        const row = ins.rows[0]!;
        await audit(tx, actor(req), 'option.create', 'service_option', row.id, { serviceId: id.data, group: b.groupKey, code: b.code, priceCents: b.priceCents });
        return row;
      });
      res.status(201).json(adminOption(created));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/options/:id', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const body = optionPatch.safeParse(req.body);
      if (!body.success) return invalid(res, body.error);

      const result = await db.tx(async (tx) => {
        if (body.data.isDefault === true) {
          // Only one default per group.
          await tx.query(
            `UPDATE service_options SET is_default = false
              WHERE id <> $1 AND (service_id, group_key) = (SELECT service_id, group_key FROM service_options WHERE id = $1)`,
            [id.data],
          );
        }
        const r = await applyPatch(tx, 'service_options', id.data, OPTION_FIELDS, body.data);
        if (r) await audit(tx, actor(req), 'option.update', 'service_option', id.data, r.changes);
        return r;
      });
      if (!result) return res.status(404).json({ error: 'not_found' });
      res.json(adminOption(result.after as OptionRow));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
