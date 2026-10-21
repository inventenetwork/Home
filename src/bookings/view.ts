import type { Lang } from '../catalog/repo.js';
import type { Db } from '../db/index.js';
import type { LineItem } from '../pricing/calculate.js';
import { loadPaymentSummary } from '../payments/service.js';
import { formatLocalTime, localDateString } from './availability.js';

/**
 * Customer-facing view of a booking. Never includes commission or provider earnings.
 * Pass customerId to make "not yours" look exactly like "does not exist".
 */
export async function loadBookingView(db: Db, id: string, lang: Lang = 'en', opts: { customerId?: string } = {}) {
  const params: unknown[] = [id];
  if (opts.customerId) params.push(opts.customerId);

  const b = (
    await db.query<Record<string, any>>(
      `SELECT b.id, b.status, b.scheduled_at, b.duration_minutes, b.units, b.notes, b.subtotal_cents, b.sst_cents,
              b.total_cents, b.price_breakdown, b.cancelled_reason, b.created_at, b.address_id, b.recurring_plan_id,
              s.slug AS service_slug, s.name_en, s.name_ms,
              a.label AS addr_label, a.line1, a.line2, a.postcode, ar.name AS area_name
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN addresses a ON a.id = b.address_id
         LEFT JOIN areas ar ON ar.id = a.area_id
        WHERE b.id = $1 ${opts.customerId ? 'AND b.customer_id = $2' : ''}`,
      params,
    )
  ).rows[0];
  if (!b) return null;

  const picked = await db.query<{ group_key: string; code: string }>(
    `SELECT so.group_key, so.code
       FROM booking_items bi JOIN service_options so ON so.id = bi.option_id
      WHERE bi.booking_id = $1
      ORDER BY so.group_key`,
    [id],
  );
  const assignment = (
    await db.query<{ full_name: string | null; checked_in_at: Date | null; checked_out_at: Date | null; has_before: boolean; has_after: boolean }>(
      `SELECT u.full_name, ba.checked_in_at, ba.checked_out_at,
              ba.checkin_photo_url IS NOT NULL AS has_before, ba.checkout_photo_url IS NOT NULL AS has_after
         FROM booking_assignments ba
         JOIN providers p ON p.id = ba.provider_id
         JOIN users u ON u.id = p.user_id
        WHERE ba.booking_id = $1`,
      [id],
    )
  ).rows[0];

  const review = (await db.query<{ rating: number; comment: string | null }>('SELECT rating, comment FROM reviews WHERE booking_id = $1', [id])).rows[0];
  const dispute = (
    await db.query<{ status: string; reason: string; resolution_note: string | null; created_at: Date }>(
      'SELECT status, reason, resolution_note, created_at FROM disputes WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1',
      [id],
    )
  ).rows[0];
  const hold = (await db.query<{ available_at: Date }>("SELECT available_at FROM payouts WHERE booking_id = $1 AND status = 'pending'", [id])).rows[0];

  const payment = await loadPaymentSummary(db, id);
  const start = new Date(b.scheduled_at);
  const lineItems = ((b.price_breakdown?.lineItems ?? []) as LineItem[]).map((li) => ({
    label: lang === 'ms' ? li.labelMs : li.labelEn,
    qty: li.qty,
    unitPriceCents: li.unitPriceCents,
    amountCents: li.amountCents,
  }));

  return {
    id: b.id as string,
    status: b.status as string,
    service: { slug: b.service_slug as string, name: lang === 'ms' ? (b.name_ms as string) : (b.name_en as string) },
    scheduledAt: start.toISOString(),
    localDate: localDateString(start),
    localTime: formatLocalTime(start),
    durationMinutes: b.duration_minutes as number,
    units: b.units as number,
    notes: (b.notes as string | null) ?? null,
    address: {
      label: b.addr_label as string,
      line1: b.line1 as string,
      line2: (b.line2 as string | null) ?? null,
      postcode: b.postcode as string,
      area: (b.area_name as string | null) ?? null,
    },
    pricing: {
      currency: 'MYR',
      lineItems,
      subtotalCents: b.subtotal_cents as number,
      sstCents: b.sst_cents as number,
      totalCents: b.total_cents as number,
    },
    payment,
    provider: assignment ? { name: assignment.full_name } : null,
    photos: { before: assignment?.has_before ?? false, after: assignment?.has_after ?? false },
    checkedInAt: assignment?.checked_in_at ? new Date(assignment.checked_in_at).toISOString() : null,
    checkedOutAt: assignment?.checked_out_at ? new Date(assignment.checked_out_at).toISOString() : null,
    cancelledReason: (b.cancelled_reason as string | null) ?? null,
    createdAt: new Date(b.created_at).toISOString(),
    recurringPlanId: (b.recurring_plan_id as string | null) ?? null,
    review: review ? { rating: review.rating, comment: review.comment } : null,
    dispute: dispute ? { status: dispute.status, reason: dispute.reason, resolutionNote: dispute.resolution_note, openedAt: new Date(dispute.created_at).toISOString() } : null,
    /** While this is in the future (and the job is finished) the customer can still open a dispute. */
    disputeUntil: b.status === 'completed' && hold?.available_at ? new Date(hold.available_at).toISOString() : null,
    /** Everything needed to book the same thing again with one tap. */
    rebook: {
      serviceSlug: b.service_slug as string,
      addressId: b.address_id as string,
      units: b.units as number,
      options: picked.rows.map((r) => ({ group: r.group_key, code: r.code })),
    },
  };
}
