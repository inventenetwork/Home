import { describe, expect, it } from 'vitest';
import {
  conflicts,
  coversInterval,
  durationMinutes,
  formatLocalTime,
  isValidDateString,
  localDateString,
  localMinutes,
  slotStartMinutes,
  slotStatus,
  weekdayOf,
  windowsForDate,
  type AvailabilityRow,
  type DayContext,
} from '../src/bookings/availability.js';
import type { BookingSettings } from '../src/bookings/settings.js';

const S: BookingSettings = {
  dayStartMin: 8 * 60,
  dayEndMin: 20 * 60,
  slotIntervalMin: 60,
  bufferMin: 30,
  minLeadHours: 24,
  maxAdvanceDays: 60,
  pendingExpiryMin: 30,
  freeCancelHours: 12,
  offersPerBooking: 3,
  offerTimeoutMin: 15,
};

const weekly = (weekday: number, start: string, end: string): AvailabilityRow => ({
  weekday, start_time: start, end_time: end, on_date: null, is_available: true,
});

describe('Malaysia local time', () => {
  it('converts instants to local date and minutes (UTC+8)', () => {
    const d = new Date('2026-10-23T01:30:00Z'); // 09:30 in Kuala Lumpur
    expect(localDateString(d)).toBe('2026-10-23');
    expect(localMinutes(d)).toBe(9 * 60 + 30);
    expect(formatLocalTime(d)).toBe('09:30');
  });
  it('rolls the date forward late in the UTC day', () => {
    expect(localDateString(new Date('2026-10-23T17:00:00Z'))).toBe('2026-10-24'); // 01:00 local
  });
  it('knows the weekday', () => {
    expect(weekdayOf('2026-10-23')).toBe(5); // Friday
    expect(weekdayOf('2026-10-25')).toBe(0); // Sunday
  });
  it('validates date strings', () => {
    expect(isValidDateString('2026-10-23')).toBe(true);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('23/10/2026')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
  });
});

describe('durations and slot grid', () => {
  it('adds fixed time and per-unit time', () => {
    expect(durationMinutes({ fixed_minutes: 0, minutes_per_unit: 60 }, 3)).toBe(180);
    expect(durationMinutes({ fixed_minutes: 240, minutes_per_unit: 0 }, 1)).toBe(240);
  });
  it('only offers starts that finish by closing time', () => {
    expect(slotStartMinutes(S, 120)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((h) => h * 60));
    expect(slotStartMinutes(S, 240).at(-1)).toBe(16 * 60);
    expect(slotStartMinutes(S, 13 * 60)).toEqual([]);
  });
});

describe('provider windows', () => {
  it('uses the weekly pattern', () => {
    const rows = [weekly(5, '09:00', '17:00')];
    const w = windowsForDate(rows, '2026-10-23'); // Friday
    expect(w.windows).toEqual([[540, 1020]]);
    expect(windowsForDate(rows, '2026-10-24').windows).toEqual([]); // Saturday: nothing
  });
  it('a whole-day exception removes availability', () => {
    const rows: AvailabilityRow[] = [
      weekly(5, '09:00', '17:00'),
      { weekday: null, start_time: null, end_time: null, on_date: '2026-10-23', is_available: false },
    ];
    expect(coversInterval(windowsForDate(rows, '2026-10-23'), 600, 720)).toBe(false);
  });
  it('a partial time-off blocks only that range', () => {
    const rows: AvailabilityRow[] = [
      weekly(5, '09:00', '17:00'),
      { weekday: null, start_time: '12:00', end_time: '14:00', on_date: '2026-10-23', is_available: false },
    ];
    const av = windowsForDate(rows, '2026-10-23');
    expect(coversInterval(av, 9 * 60, 11 * 60)).toBe(true);
    expect(coversInterval(av, 11 * 60, 13 * 60)).toBe(false);
    expect(coversInterval(av, 14 * 60, 16 * 60)).toBe(true);
  });
  it('a dated availability row replaces the weekly hours for that date', () => {
    const rows: AvailabilityRow[] = [
      weekly(5, '09:00', '17:00'),
      { weekday: null, start_time: '18:00', end_time: '22:00', on_date: '2026-10-23', is_available: true },
    ];
    const av = windowsForDate(rows, '2026-10-23');
    expect(coversInterval(av, 10 * 60, 12 * 60)).toBe(false);
    expect(coversInterval(av, 18 * 60, 20 * 60)).toBe(true);
  });
  it('requires the whole job to fit inside a window', () => {
    const av = windowsForDate([weekly(5, '09:00', '12:00')], '2026-10-23');
    expect(coversInterval(av, 10 * 60, 12 * 60)).toBe(true);
    expect(coversInterval(av, 11 * 60, 13 * 60)).toBe(false);
  });
});

describe('conflicts with buffer', () => {
  const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 23, h, m));
  it('detects overlap', () => {
    expect(conflicts(t(1), t(3), t(2), t(4), 0)).toBe(true);
  });
  it('allows back-to-back jobs when there is no buffer', () => {
    expect(conflicts(t(1), t(3), t(3), t(4), 0)).toBe(false);
  });
  it('requires the buffer gap', () => {
    expect(conflicts(t(3), t(4), t(1), t(3), 30)).toBe(true); // starts exactly when the other ends
    expect(conflicts(t(3, 30), t(4, 30), t(1), t(3), 30)).toBe(false); // exactly the buffer apart
  });
});

describe('slot availability', () => {
  const ctx = (over: Partial<DayContext> = {}): DayContext => ({
    dateStr: '2026-10-23',
    avail: new Map([['p1', [weekly(5, '08:00', '20:00')]]]),
    busy: new Map([['p1', []]]),
    unassigned: [],
    ...over,
  });
  const at = (h: number) => new Date(`2026-10-23T${String(h).padStart(2, '0')}:00:00+08:00`);

  it('is available when a qualified provider is free', () => {
    expect(slotStatus(ctx(), 10 * 60, 120, S)).toEqual({ free: 1, demand: 0, available: true });
  });
  it('is unavailable with no providers at all', () => {
    expect(slotStatus(ctx({ avail: new Map(), busy: new Map() }), 10 * 60, 120, S).available).toBe(false);
  });
  it('blocks times that clash with an existing job, including the buffer', () => {
    const busy = new Map([['p1', [{ start: at(9), end: at(11) }]]]); // 09:00-11:00
    const c = ctx({ busy });
    expect(slotStatus(c, 9 * 60, 120, S).available).toBe(false);
    expect(slotStatus(c, 11 * 60, 120, S).available).toBe(false); // inside the 30 min buffer
    expect(slotStatus(c, 12 * 60, 120, S).available).toBe(true);
    expect(slotStatus(c, 7 * 60, 60, S).available).toBe(false); // before the provider's working hours
  });
  it('counts bookings still waiting for a provider as demand', () => {
    const c = ctx({ unassigned: [{ start: at(10), end: at(12) }] });
    expect(slotStatus(c, 10 * 60, 120, S)).toEqual({ free: 1, demand: 1, available: false });
    expect(slotStatus(c, 14 * 60, 120, S).available).toBe(true);
  });
  it('two providers can take two overlapping bookings but not three', () => {
    const avail = new Map([['p1', [weekly(5, '08:00', '20:00')]], ['p2', [weekly(5, '08:00', '20:00')]]]);
    const busy = new Map([['p1', []], ['p2', []]]);
    const one = ctx({ avail, busy, unassigned: [{ start: at(10), end: at(12) }] });
    const two = ctx({ avail, busy, unassigned: [{ start: at(10), end: at(12) }, { start: at(10), end: at(12) }] });
    expect(slotStatus(one, 10 * 60, 120, S).available).toBe(true);
    expect(slotStatus(two, 10 * 60, 120, S).available).toBe(false);
  });
});
