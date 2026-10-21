import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { OptionInput, ServiceInput, Settings } from '../pricing/calculate.js';

export type Lang = 'en' | 'ms' | 'zh';
export const langSchema = z.enum(['en', 'ms', 'zh']).catch('en');
const pick = (lang: Lang, en: string, ms: string) => (lang === 'ms' ? ms : en); // zh falls back to English for now

export interface ServiceRow extends ServiceInput {
  id: string;
  slug: string;
  description_en: string | null;
  description_ms: string | null;
  phase: number;
  active: boolean;
  sort_order: number;
  fixed_minutes: number;
  minutes_per_unit: number;
}

export interface OptionRow extends OptionInput {
  service_id: string;
  active: boolean;
}

const SERVICE_COLS =
  'id, slug, name_en, name_ms, description_en, description_ms, pricing_model, base_price_cents, unit_label, min_units, phase, active, sort_order, fixed_minutes, minutes_per_unit';
const OPTION_COLS =
  'id, service_id, kind, group_key, code, label_en, label_ms, price_cents, per_unit, is_default, active';

export async function listServices(db: Db, opts: { includeInactive?: boolean } = {}): Promise<ServiceRow[]> {
  const where = opts.includeInactive ? '' : 'WHERE active';
  const { rows } = await db.query<ServiceRow>(`SELECT ${SERVICE_COLS} FROM services ${where} ORDER BY sort_order, slug`);
  return rows;
}

export async function findServiceBySlug(db: Db, slug: string, opts: { includeInactive?: boolean } = {}) {
  const { rows } = await db.query<ServiceRow>(
    `SELECT ${SERVICE_COLS} FROM services WHERE slug = $1 ${opts.includeInactive ? '' : 'AND active'}`,
    [slug],
  );
  return rows[0];
}

export async function listOptions(db: Db, serviceId: string, opts: { includeInactive?: boolean } = {}) {
  const { rows } = await db.query<OptionRow>(
    `SELECT ${OPTION_COLS} FROM service_options
      WHERE service_id = $1 ${opts.includeInactive ? '' : 'AND active'}
      ORDER BY group_key, price_cents, code`,
    [serviceId],
  );
  return rows;
}

export async function loadSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: string }>('SELECT key, value FROM app_config');
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const fraction = (key: string, fallback: number) => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Invalid app_config "${key}": "${raw}" (expected 0 to 1)`);
    return n;
  };
  return {
    commissionRate: fraction('commission_rate', 0.2),
    sstEnabled: map.get('sst_enabled') === 'true',
    sstRate: fraction('sst_rate', 0.08),
  };
}

// ── response shapes ──

export function publicService(s: ServiceRow, lang: Lang) {
  return {
    id: s.id,
    slug: s.slug,
    name: pick(lang, s.name_en, s.name_ms),
    description: pick(lang, s.description_en ?? '', s.description_ms ?? ''),
    pricingModel: s.pricing_model,
    basePriceCents: s.base_price_cents,
    unitLabel: s.unit_label,
    minUnits: s.min_units,
    fixedMinutes: s.fixed_minutes,
    minutesPerUnit: s.minutes_per_unit,
  };
}

export function publicOptionGroups(options: OptionRow[], lang: Lang) {
  const groups = new Map<string, { key: string; required: boolean; options: unknown[] }>();
  for (const o of options) {
    const g = groups.get(o.group_key) ?? { key: o.group_key, required: false, options: [] };
    if (o.kind !== 'addon') g.required = true;
    g.options.push({
      code: o.code,
      kind: o.kind,
      label: pick(lang, o.label_en, o.label_ms),
      priceCents: o.price_cents,
      perUnit: o.per_unit,
      isDefault: o.is_default,
    });
    groups.set(o.group_key, g);
  }
  return [...groups.values()];
}

export function adminService(s: ServiceRow) {
  return {
    id: s.id,
    slug: s.slug,
    nameEn: s.name_en,
    nameMs: s.name_ms,
    descriptionEn: s.description_en,
    descriptionMs: s.description_ms,
    pricingModel: s.pricing_model,
    basePriceCents: s.base_price_cents,
    unitLabel: s.unit_label,
    minUnits: s.min_units,
    fixedMinutes: s.fixed_minutes,
    minutesPerUnit: s.minutes_per_unit,
    phase: s.phase,
    active: s.active,
    sortOrder: s.sort_order,
  };
}

export function adminOption(o: OptionRow) {
  return {
    id: o.id,
    serviceId: o.service_id,
    kind: o.kind,
    groupKey: o.group_key,
    code: o.code,
    labelEn: o.label_en,
    labelMs: o.label_ms,
    priceCents: o.price_cents,
    perUnit: o.per_unit,
    isDefault: o.is_default,
    active: o.active,
  };
}
