import type { Db } from '../db/index.js';

export interface ProviderSettings {
  payoutHoldHours: number; // after a job is completed, its payout waits this long (customer dispute window)
  minPayoutCents: number; // smallest payout a provider may request
  requireAfterPhoto: boolean; // a provider must upload an "after" photo before finishing a job
}

const DEFAULTS: Record<string, string> = {
  payout_hold_hours: '24',
  min_payout_cents: '5000',
  require_after_photo: 'true',
};

function int(key: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid app_config "${key}": "${raw}" (expected a whole number from ${min} to ${max})`);
  return n;
}

export async function loadProviderSettings(db: Db): Promise<ProviderSettings> {
  const { rows } = await db.query<{ key: string; value: string }>('SELECT key, value FROM app_config');
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string) => map.get(k) ?? DEFAULTS[k]!;
  const flag = get('require_after_photo');
  if (flag !== 'true' && flag !== 'false') throw new Error(`Invalid app_config "require_after_photo": "${flag}" (expected true or false)`);
  return {
    payoutHoldHours: int('payout_hold_hours', get('payout_hold_hours'), 0, 720),
    minPayoutCents: int('min_payout_cents', get('min_payout_cents'), 0, 10_000_000),
    requireAfterPhoto: flag === 'true',
  };
}
