import type { Db } from '../db/index.js';
import type { BookingSettings } from './settings.js';

/**
 * Availability maths. Malaysia is UTC+8 all year (no daylight saving), so "local time" here is a fixed +08:00 offset.
 * Provider availability windows are stored as local times; bookings are stored as UTC instants.
 */

const MS_PER_MIN = 60_000;
const MYT_OFFSET_MIN = 8 * 60;

export interface Interval {
  start: Date;
  end: Date;
}

export interface AvailabilityRow {
  weekday: number | null;
  start_time: string | null; // 'HH:MM'
  end_time: string | null;
  on_date: string | null; // 'YYYY-MM-DD'
  is_available: boolean;
}

// ───────────── pure helpers ─────────────

export function localDateString(d: Date): string {
  return new Date(d.getTime() + MYT_OFFSET_MIN * MS_PER_MIN).toISOString().slice(0, 10);
}

export function localMinutes(d: Date): number {
  const t = new Date(d.getTime() + MYT_OFFSET_MIN * MS_PER_MIN);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

export function localDayStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+08:00`);
}

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = localDayStart(s);
  return !Number.isNaN(d.getTime()) && localDateString(d) === s;
}

/** 0 = Sunday ... 6 = Saturday, for the local date. */
export function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00+08:00`).getUTCDay();
}

export function toMinutes(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function formatLocalTime(d: Date): string {
  const m = localMinutes(d);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function durationMinutes(service: { fixed_minutes: number; minutes_per_unit: number }, units: number): number {
  return service.fixed_minutes + service.minutes_per_unit * units;
}

/** Start times (minutes after local midnight) for a job of this length, on the slot grid, finishing by day end. */
export function slotStartMinutes(s: BookingSettings, durationMin: number): number[] {
  const out: number[] = [];
  for (let m = s.dayStartMin; m + durationMin <= s.dayEndMin; m += s.slotIntervalMin) out.push(m);
  return out;
}

/**
 * Working windows and time-off for one provider on one date.
 *  - dated rows with is_available = true REPLACE the weekly pattern for that date (extra/different hours)
 *  - dated rows with is_available = false are time off (whole day when no times are given)
 */
export function windowsForDate(rows: AvailabilityRow[], dateStr: string) {
  const weekday = weekdayOf(dateStr);
  const dated = rows.filter((r) => r.on_date === dateStr);
  const extra = dated.filter((r) => r.is_available && r.start_time && r.end_time);
  const weekly = rows.filter(
    (r) => r.on_date === null && r.is_available && r.weekday === weekday && r.start_time && r.end_time,
  );
  const source = extra.length > 0 ? extra : weekly;
  const windows = source.map((r) => [toMinutes(r.start_time!), toMinutes(r.end_time!)] as [number, number]);
  const off = dated
    .filter((r) => !r.is_available)
    .map((r) =>
      r.start_time && r.end_time
        ? ([toMinutes(r.start_time), toMinutes(r.end_time)] as [number, number])
        : ([0, 24 * 60] as [number, number]),
    );
  return { windows, off };
}

export function coversInterval(
  av: { windows: Array<[number, number]>; off: Array<[number, number]> },
  startMin: number,
  endMin: number,
): boolean {
  const inWindow = av.windows.some(([ws, we]) => ws <= startMin && endMin <= we);
  const inTimeOff = av.off.some(([os, oe]) => startMin < oe && os < endMin);
  return inWindow && !inTimeOff;
}

/** Two jobs clash if they overlap, or are closer together than the buffer. */
export function conflicts(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date, bufferMin: number): boolean {
  const buf = bufferMin * MS_PER_MIN;
  return aStart.getTime() < bEnd.getTime() + buf && bStart.getTime() < aEnd.getTime() + buf;
}

// ───────────── per-day context (loaded once, then queried in memory) ─────────────

export interface DayContext {
  dateStr: string;
  avail: Map<string, AvailabilityRow[]>; // every eligible provider, even with no rows
  busy: Map<string, Interval[]>; // provider's existing (non-cancelled) assigned jobs around this date
  unassigned: Interval[]; // pending/offered bookings in the area that no provider has yet; they will need someone
}

export interface SlotStatus {
  free: number;
  demand: number;
  available: boolean;
}

/**
 * A slot is bookable when there are more free, qualified providers than bookings already waiting for one.
 * (An approximation: it does not try to find the perfect assignment, step 5's matching does that.)
 */
export function slotStatus(ctx: DayContext, startMin: number, durationMin: number, s: BookingSettings): SlotStatus {
  const start = new Date(localDayStart(ctx.dateStr).getTime() + startMin * MS_PER_MIN);
  const end = new Date(start.getTime() + durationMin * MS_PER_MIN);

  let free = 0;
  for (const providerId of ctx.avail.keys()) {
    if (providerIsFree(ctx, providerId, startMin, durationMin, s)) free++;
  }
  const demand = ctx.unassigned.filter((iv) => conflicts(start, end, iv.start, iv.end, s.bufferMin)).length;
  return { free, demand, available: free > demand };
}

/** Is this one provider inside their working hours, not on time off, and clear of other jobs (plus buffer) for the whole job? */
export function providerIsFree(
  ctx: DayContext,
  providerId: string,
  startMin: number,
  durationMin: number,
  s: BookingSettings,
): boolean {
  const rows = ctx.avail.get(providerId);
  if (!rows) return false;
  const start = new Date(localDayStart(ctx.dateStr).getTime() + startMin * MS_PER_MIN);
  const end = new Date(start.getTime() + durationMin * MS_PER_MIN);
  const av = windowsForDate(rows, ctx.dateStr);
  if (!coversInterval(av, startMin, startMin + durationMin)) return false;
  const busy = ctx.busy.get(providerId) ?? [];
  return !busy.some((iv) => conflicts(start, end, iv.start, iv.end, s.bufferMin));
}

// ───────────── database queries ─────────────

const placeholders = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => `$${i + 1 + offset}`).join(',');

/** Approved, active providers who serve the area and hold every skill the service requires. */
export async function eligibleProviderIds(db: Db, serviceId: string, areaId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id
       FROM providers p
       JOIN users u ON u.id = p.user_id AND u.status = 'active'
       JOIN provider_areas pa ON pa.provider_id = p.id AND pa.area_id = $2
      WHERE p.vetting_status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM service_skills ss
           WHERE ss.service_id = $1
             AND NOT EXISTS (SELECT 1 FROM provider_skills ps WHERE ps.provider_id = p.id AND ps.skill_id = ss.skill_id)
        )
      ORDER BY p.id`,
    [serviceId, areaId],
  );
  return rows.map((r) => r.id);
}

export async function loadDayContext(
  db: Db,
  providerIds: string[],
  areaId: string,
  dateStr: string,
  excludeBookingId?: string,
): Promise<DayContext> {
  const dayStart = localDayStart(dateStr).getTime();
  const from = new Date(dayStart - 24 * 3600_000);
  const to = new Date(dayStart + 48 * 3600_000);

  const avail = new Map<string, AvailabilityRow[]>();
  const busy = new Map<string, Interval[]>();
  for (const id of providerIds) {
    avail.set(id, []);
    busy.set(id, []);
  }

  if (providerIds.length > 0) {
    const n = providerIds.length;
    const ph = placeholders(n);

    const a = await db.query<AvailabilityRow & { provider_id: string }>(
      `SELECT provider_id, weekday,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time,
              to_char(on_date, 'YYYY-MM-DD') AS on_date,
              is_available
         FROM provider_availability WHERE provider_id IN (${ph})`,
      providerIds,
    );
    for (const r of a.rows) avail.get(r.provider_id)?.push(r);

    const b = await db.query<{ provider_id: string; scheduled_at: Date; duration_minutes: number }>(
      `SELECT ba.provider_id, b.scheduled_at, b.duration_minutes
         FROM booking_assignments ba
         JOIN bookings b ON b.id = ba.booking_id
        WHERE ba.provider_id IN (${ph})
          AND b.status <> 'cancelled'
          AND b.scheduled_at >= $${n + 1} AND b.scheduled_at < $${n + 2}
          AND ($${n + 3}::uuid IS NULL OR b.id <> $${n + 3}::uuid)`,
      [...providerIds, from, to, excludeBookingId ?? null],
    );
    for (const r of b.rows) {
      const start = new Date(r.scheduled_at);
      busy.get(r.provider_id)?.push({ start, end: new Date(start.getTime() + r.duration_minutes * MS_PER_MIN) });
    }
  }

  const u = await db.query<{ scheduled_at: Date; duration_minutes: number }>(
    `SELECT b.scheduled_at, b.duration_minutes
       FROM bookings b
       JOIN addresses a ON a.id = b.address_id
      WHERE a.area_id = $1
        AND b.status IN ('pending', 'offered')
        AND NOT EXISTS (SELECT 1 FROM booking_assignments ba WHERE ba.booking_id = b.id)
        AND b.scheduled_at >= $2 AND b.scheduled_at < $3
        AND ($4::uuid IS NULL OR b.id <> $4::uuid)`,
    [areaId, from, to, excludeBookingId ?? null],
  );
  const unassigned = u.rows.map((r) => {
    const start = new Date(r.scheduled_at);
    return { start, end: new Date(start.getTime() + r.duration_minutes * MS_PER_MIN) };
  });

  return { dateStr, avail, busy, unassigned };
}

/** A customer who is in the middle of paying gets this much extra time before the booking is released. */
export const PAYMENT_GRACE_MIN = 10;

/** Lazily cancels unpaid bookings that have held a slot too long. Call before reading availability. */

export async function expireStalePending(db: Db, now: Date, s: BookingSettings): Promise<number> {
  const cutoff = new Date(now.getTime() - s.pendingExpiryMin * MS_PER_MIN);
  const graceCutoff = new Date(now.getTime() - PAYMENT_GRACE_MIN * MS_PER_MIN);
  const r = await db.query(
    `UPDATE bookings
        SET status = 'cancelled', cancelled_reason = 'payment_timeout', updated_at = $1
      WHERE status = 'pending' AND created_at < $2
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = bookings.id AND p.status = 'pending' AND p.created_at > $3)
      RETURNING id`,
    [now, cutoff, graceCutoff],
  );
  return r.rowCount;
}
