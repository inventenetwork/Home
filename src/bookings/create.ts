import { z } from 'zod';
import { findServiceBySlug, listOptions, loadSettings } from '../catalog/repo.js';
import type { Db } from '../db/index.js';
import { calculatePrice, PricingError, type PriceResult } from '../pricing/calculate.js';
import {
  durationMinutes,
  eligibleProviderIds,
  expireStalePending,
  loadDayContext,
  localDateString,
  localMinutes,
  slotStatus,
} from './availability.js';
import { loadBookingSettings } from './settings.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const createBookingBody = z
  .object({
    serviceSlug: z.string().max(60),
    addressId: z.string().uuid(),
    scheduledAt: z.string().datetime({ offset: true }),
    units: z.number().optional(),
    options: z
      .array(z.object({ group: z.string().max(40), code: z.string().max(40) }))
      .max(20)
      .default([]),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreateBookingInput = z.infer<typeof createBookingBody>;

export type CreateResult = { ok: true; id: string } | { ok: false; status: number; body: { error: string; message?: string } };
const fail = (status: number, body: { error: string; message?: string }): CreateResult => ({ ok: false, status, body });

/**
 * Validates and creates a pending booking for a customer: address, grid time, notice rules, server-side price, and a free
 * provider checked under a lock. Used for one-off bookings and for each visit of a recurring plan.
 * `planId` links the booking to a recurring plan.
 */
export async function createBooking(db: Db, userId: string, b: CreateBookingInput, t: Date, planId: string | null = null): Promise<CreateResult> {
  const service = await findServiceBySlug(db, b.serviceSlug);
  if (!service) return fail(404, { error: 'not_found' });
  if (service.pricing_model === 'quote') {
    return fail(400, { error: 'quote_required', message: 'This service is booked by quote, not instantly.' });
  }

  const address = (
    await db.query<{ id: string; area_id: string | null }>(
      'SELECT id, area_id FROM addresses WHERE id = $1 AND user_id = $2',
      [b.addressId, userId],
    )
  ).rows[0];
  if (!address) return fail(404, { error: 'address_not_found' });
  const area = address.area_id
    ? (await db.query<{ active: boolean }>('SELECT active FROM areas WHERE id = $1', [address.area_id])).rows[0]
    : undefined;
  if (!address.area_id || !area?.active) {
    return fail(400, { error: 'area_not_served', message: 'We do not serve that address area yet.' });
  }
  const areaId = address.area_id;

  // ── when ──
  const settings = await loadBookingSettings(db);
  const start = new Date(b.scheduledAt);
  const startMin = localMinutes(start);
  const onGrid =
    start.getTime() % 60_000 === 0 &&
    startMin >= settings.dayStartMin &&
    (startMin - settings.dayStartMin) % settings.slotIntervalMin === 0;
  if (!onGrid) {
    return fail(400, { error: 'invalid_slot', message: 'Pick one of the offered start times.' });
  }
  if (start.getTime() < t.getTime() + settings.minLeadHours * HOUR) {
    return fail(400, { error: 'too_soon', message: `Bookings need at least ${settings.minLeadHours} hours notice.` });
  }
  if (start.getTime() > t.getTime() + settings.maxAdvanceDays * DAY) {
    return fail(400, { error: 'too_far', message: `You can book up to ${settings.maxAdvanceDays} days ahead.` });
  }

  // ── how much (always recomputed here; the client never supplies a price) ──
  const [options, pricingSettings] = await Promise.all([listOptions(db, service.id), loadSettings(db)]);
  let price: PriceResult;
  try {
    price = calculatePrice(service, options, { units: b.units, options: b.options }, pricingSettings);
  } catch (err) {
    if (err instanceof PricingError) return fail(400, { error: err.code, message: err.message });
    throw err;
  }
  if (price.quoteOnly) return fail(400, { error: 'quote_required' });

  const duration = durationMinutes(service, price.units);
  if (startMin + duration > settings.dayEndMin) {
    return fail(400, { error: 'outside_hours', message: 'That booking would run past closing time.' });
  }

  // ── is someone free? Checked and inserted under a lock on the area, so two customers cannot take the last slot ──
  const providerIds = await eligibleProviderIds(db, service.id, areaId);
  const dateStr = localDateString(start);

  const bookingId = await db.tx(async (tx) => {
    await tx.query('SELECT id FROM areas WHERE id = $1 FOR UPDATE', [areaId]);
    await expireStalePending(tx, t, settings);
    const ctx = await loadDayContext(tx, providerIds, areaId, dateStr);
    if (!slotStatus(ctx, startMin, duration, settings).available) return null;

    const ins = await tx.query<{ id: string }>(
      `INSERT INTO bookings
         (customer_id, service_id, address_id, recurring_plan_id, status, scheduled_at, units, notes, duration_minutes,
          subtotal_cents, sst_cents, total_cents, commission_rate, price_breakdown, created_at, updated_at)
       VALUES ($1,$2,$3,$14::uuid,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13)
       RETURNING id`,
      [
        userId, service.id, address.id, start, price.units, b.notes ?? null, duration,
        price.subtotalCents, price.sstCents, price.totalCents, price.commissionRate,
        JSON.stringify({
          units: price.units,
          lineItems: price.lineItems,
          subtotalCents: price.subtotalCents,
          sstCents: price.sstCents,
          totalCents: price.totalCents,
          commissionRate: price.commissionRate,
          commissionCents: price.commissionCents,
          providerEarningsCents: price.providerEarningsCents,
        }),
        t,
        planId,
      ],
    );
    const id = ins.rows[0]!.id;
    for (const li of price.lineItems) {
      await tx.query(
        'INSERT INTO booking_items (booking_id, option_id, label, qty, price_cents) VALUES ($1,$2,$3,$4,$5)',
        [id, li.optionId, li.labelEn, li.qty, li.amountCents],
      );
    }
    return id;
  });

  if (!bookingId) return fail(409, { error: 'slot_unavailable', message: 'That time was just taken. Please pick another.' });
  return { ok: true, id: bookingId };
}
