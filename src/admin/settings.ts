import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { audit } from './audit.js';

type Kind = 'int' | 'fraction' | 'hhmm' | 'bool';
interface Def {
  key: string;
  kind: Kind;
  group: 'booking' | 'matching' | 'money' | 'provider';
  label: string;
  min?: number;
  max?: number;
  default: string;
}

/** Every setting the admin may change, with the same limits the loaders enforce. Anything else in app_config is not editable from the web. */
export const SETTINGS: Def[] = [
  { key: 'day_start', kind: 'hhmm', group: 'booking', label: 'Earliest job start (Malaysia time)', default: '08:00' },
  { key: 'day_end', kind: 'hhmm', group: 'booking', label: 'Jobs must finish by (Malaysia time)', default: '20:00' },
  { key: 'slot_interval_minutes', kind: 'int', group: 'booking', label: 'Start-time grid (minutes)', min: 15, max: 240, default: '60' },
  { key: 'job_buffer_minutes', kind: 'int', group: 'booking', label: 'Gap between two jobs (minutes)', min: 0, max: 240, default: '30' },
  { key: 'min_lead_hours', kind: 'int', group: 'booking', label: 'Minimum notice before a booking (hours)', min: 0, max: 720, default: '24' },
  { key: 'max_advance_days', kind: 'int', group: 'booking', label: 'How far ahead customers can book (days)', min: 1, max: 365, default: '60' },
  { key: 'pending_expiry_minutes', kind: 'int', group: 'booking', label: 'Unpaid bookings expire after (minutes)', min: 1, max: 1440, default: '30' },
  { key: 'free_cancel_hours', kind: 'int', group: 'booking', label: 'Free cancellation until (hours before start)', min: 0, max: 720, default: '12' },
  { key: 'offers_per_booking', kind: 'int', group: 'matching', label: 'Providers asked per job', min: 1, max: 10, default: '3' },
  { key: 'offer_timeout_minutes', kind: 'int', group: 'matching', label: 'Offer expires after (minutes)', min: 1, max: 1440, default: '15' },
  { key: 'commission_rate', kind: 'fraction', group: 'money', label: 'Commission (0 to 1, e.g. 0.20 = 20%)', default: '0.20' },
  { key: 'sst_enabled', kind: 'bool', group: 'money', label: 'Charge SST', default: 'false' },
  { key: 'sst_rate', kind: 'fraction', group: 'money', label: 'SST rate (0 to 1)', default: '0.08' },
  { key: 'payout_hold_hours', kind: 'int', group: 'provider', label: 'Payout hold = customer dispute window (hours)', min: 0, max: 720, default: '24' },
  { key: 'min_payout_cents', kind: 'int', group: 'provider', label: 'Minimum withdrawal (sen, 5000 = RM 50)', min: 0, max: 10_000_000, default: '5000' },
  { key: 'require_after_photo', kind: 'bool', group: 'provider', label: 'Require an "after" photo to finish a job', default: 'true' },
];

/** Returns the cleaned value to store, or an error message. */
export function validateSetting(def: Def, raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const v = raw.trim();
  switch (def.kind) {
    case 'bool':
      return v === 'true' || v === 'false' ? { ok: true, value: v } : { ok: false, message: 'Use true or false.' };
    case 'hhmm':
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? { ok: true, value: v } : { ok: false, message: 'Use HH:MM, for example 08:00.' };
    case 'fraction': {
      const n = Number(v);
      return v !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? { ok: true, value: String(n) } : { ok: false, message: 'Enter a number from 0 to 1.' };
    }
    case 'int': {
      const n = Number(v);
      return v !== '' && Number.isInteger(n) && n >= def.min! && n <= def.max!
        ? { ok: true, value: String(n) }
        : { ok: false, message: `Enter a whole number from ${def.min} to ${def.max}.` };
    }
  }
}

const putBody = z.object({ value: z.string().max(20) }).strict();

export function adminSettingsRouter(db: Db, now: () => Date): Router {
  const router = Router();

  router.get('/settings', async (_req, res, next) => {
    try {
      const { rows } = await db.query<{ key: string; value: string; updated_at: Date }>('SELECT key, value, updated_at FROM app_config');
      const map = new Map(rows.map((r) => [r.key, r]));
      res.json({
        settings: SETTINGS.map((d) => ({
          key: d.key,
          kind: d.kind,
          group: d.group,
          label: d.label,
          min: d.min ?? null,
          max: d.max ?? null,
          value: map.get(d.key)?.value ?? d.default,
          isDefault: !map.has(d.key),
          updatedAt: map.get(d.key) ? new Date(map.get(d.key)!.updated_at).toISOString() : null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/settings/:key', async (req, res, next) => {
    try {
      const def = SETTINGS.find((d) => d.key === req.params.key);
      if (!def) return res.status(404).json({ error: 'not_found' });
      const body = putBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const checked = validateSetting(def, body.data.value);
      if (!checked.ok) return res.status(400).json({ error: 'invalid_value', message: checked.message });

      const out = await db.tx(async (tx) => {
        const cur = new Map((await tx.query<{ key: string; value: string }>('SELECT key, value FROM app_config')).rows.map((r) => [r.key, r.value]));
        const get = (k: string) => cur.get(k) ?? SETTINGS.find((d) => d.key === k)!.default;
        // The two ends of the working day must stay in order, or no slot could ever exist.
        const start = def.key === 'day_start' ? checked.value : get('day_start');
        const end = def.key === 'day_end' ? checked.value : get('day_end');
        if ((def.key === 'day_start' || def.key === 'day_end') && start >= end) return { fail: 'The working day must end after it starts.' };
        const before = get(def.key);
        await tx.query(
          `INSERT INTO app_config (key, value, updated_at) VALUES ($1,$2,$3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [def.key, checked.value, now()],
        );
        await audit(tx, req.user!.id, 'settings.update', 'app_config', def.key, { from: before, to: checked.value });
        return { value: checked.value };
      });
      if ('fail' in out) return res.status(400).json({ error: 'invalid_value', message: out.fail });
      res.json({ key: def.key, value: out.value });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
