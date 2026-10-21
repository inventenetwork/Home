import type { Db } from '../db/index.js';

export interface BookingSettings {
  dayStartMin: number; // earliest job start, minutes after local midnight
  dayEndMin: number; // jobs must finish by this time
  slotIntervalMin: number; // start times are on this grid
  bufferMin: number; // travel/rest gap a provider needs between two jobs
  minLeadHours: number;
  maxAdvanceDays: number;
  pendingExpiryMin: number; // unpaid bookings release their slot after this long
  freeCancelHours: number; // customers may cancel a confirmed booking free of restriction until this long before start
  offersPerBooking: number; // how many providers get each job offer
  offerTimeoutMin: number; // an unanswered offer expires after this long; then the booking needs an admin
}

const DEFAULTS: Record<string, string> = {
  day_start: '08:00',
  day_end: '20:00',
  slot_interval_minutes: '60',
  job_buffer_minutes: '30',
  min_lead_hours: '24',
  max_advance_days: '60',
  pending_expiry_minutes: '30',
  free_cancel_hours: '12',
  offers_per_booking: '3',
  offer_timeout_minutes: '15',
};

function hhmm(key: string, raw: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!m) throw new Error(`Invalid app_config "${key}": "${raw}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function int(key: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid app_config "${key}": "${raw}" (expected a whole number from ${min} to ${max})`);
  }
  return n;
}

export async function loadBookingSettings(db: Db): Promise<BookingSettings> {
  const { rows } = await db.query<{ key: string; value: string }>('SELECT key, value FROM app_config');
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string) => map.get(k) ?? DEFAULTS[k]!;

  const s: BookingSettings = {
    dayStartMin: hhmm('day_start', get('day_start')),
    dayEndMin: hhmm('day_end', get('day_end')),
    slotIntervalMin: int('slot_interval_minutes', get('slot_interval_minutes'), 15, 240),
    bufferMin: int('job_buffer_minutes', get('job_buffer_minutes'), 0, 240),
    minLeadHours: int('min_lead_hours', get('min_lead_hours'), 0, 720),
    maxAdvanceDays: int('max_advance_days', get('max_advance_days'), 1, 365),
    pendingExpiryMin: int('pending_expiry_minutes', get('pending_expiry_minutes'), 1, 1440),
    freeCancelHours: int('free_cancel_hours', get('free_cancel_hours'), 0, 720),
    offersPerBooking: int('offers_per_booking', get('offers_per_booking'), 1, 10),
    offerTimeoutMin: int('offer_timeout_minutes', get('offer_timeout_minutes'), 1, 1440),
  };
  if (s.dayEndMin <= s.dayStartMin) throw new Error('Invalid app_config: day_end must be after day_start');
  return s;
}
