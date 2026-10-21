import type { Db } from '../db/index.js';
import { audit } from '../admin/audit.js';
import type { ProviderSettings } from '../provider/settings.js';

const MS_PER_HOUR = 3_600_000;

export class PayoutError extends Error {
  constructor(
    public readonly code: 'nothing_to_pay' | 'below_minimum' | 'no_bank_details' | 'not_found' | 'nothing_requested',
    message: string,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

/**
 * Called inside the transaction that completes a job. Creates the provider's payout line for it:
 * what the customer paid (before tax), our commission, and what the provider keeps. Safe to call twice.
 */
export async function recordPayoutForCompletedBooking(tx: Db, bookingId: string, s: ProviderSettings, now: Date): Promise<void> {
  const row = (
    await tx.query<{ provider_id: string; price_breakdown: { subtotalCents?: number; commissionCents?: number; providerEarningsCents?: number } }>(
      `SELECT ba.provider_id, b.price_breakdown FROM bookings b JOIN booking_assignments ba ON ba.booking_id = b.id WHERE b.id = $1`,
      [bookingId],
    )
  ).rows[0];
  if (!row) return;
  const pb = row.price_breakdown;
  const gross = pb.subtotalCents ?? 0;
  const commission = pb.commissionCents ?? 0;
  const net = pb.providerEarningsCents ?? gross - commission;
  const availableAt = new Date(now.getTime() + s.payoutHoldHours * MS_PER_HOUR);
  await tx.query(
    `INSERT INTO payouts (provider_id, booking_id, gross_cents, commission_cents, net_cents, status, available_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$7)
     ON CONFLICT (booking_id) WHERE booking_id IS NOT NULL DO NOTHING`,
    [row.provider_id, bookingId, gross, commission, net, availableAt, now],
  );
}

export interface EarningsSummary {
  availableCents: number; // can be requested now
  waitingCents: number; // completed, still inside the dispute window
  requestedCents: number; // asked for, waiting for the admin to transfer
  paidCents: number; // already transferred
  minPayoutCents: number;
  items: Array<{
    bookingId: string | null;
    service: string | null;
    completedAt: string;
    netCents: number;
    grossCents: number;
    commissionCents: number;
    status: 'waiting' | 'available' | 'on_hold' | 'requested' | 'paid';
    availableAt: string | null;
    paidAt: string | null;
  }>;
}

export async function loadEarnings(db: Db, providerId: string, s: ProviderSettings, now: Date): Promise<EarningsSummary> {
  const { rows } = await db.query<Record<string, any>>(
    `SELECT p.booking_id, p.gross_cents, p.commission_cents, p.net_cents, p.status, p.available_at, p.paid_at, p.created_at, sv.name_en, b.status AS booking_status
       FROM payouts p
       LEFT JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN services sv ON sv.id = b.service_id
      WHERE p.provider_id = $1 AND p.status <> 'failed'
      ORDER BY p.created_at DESC
      LIMIT 200`,
    [providerId],
  );
  const sum: EarningsSummary = { availableCents: 0, waitingCents: 0, requestedCents: 0, paidCents: 0, minPayoutCents: s.minPayoutCents, items: [] };
  for (const r of rows) {
    const net = r.net_cents as number;
    let status: EarningsSummary['items'][number]['status'];
    if (r.status === 'paid') {
      status = 'paid';
      sum.paidCents += net;
    } else if (r.status === 'requested') {
      status = 'requested';
      sum.requestedCents += net;
    } else if (r.booking_status === 'disputed') {
      status = 'on_hold'; // a dispute is open: the admin decides before this can be paid
      sum.waitingCents += net;
    } else if (new Date(r.available_at).getTime() <= now.getTime()) {
      status = 'available';
      sum.availableCents += net;
    } else {
      status = 'waiting';
      sum.waitingCents += net;
    }
    sum.items.push({
      bookingId: (r.booking_id as string | null) ?? null,
      service: (r.name_en as string | null) ?? null,
      completedAt: new Date(r.created_at).toISOString(),
      netCents: net,
      grossCents: r.gross_cents,
      commissionCents: r.commission_cents,
      status,
      availableAt: r.available_at ? new Date(r.available_at).toISOString() : null,
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    });
  }
  return sum;
}

/** The provider asks to be paid everything that is available. Needs bank details and the minimum amount. */
export async function requestPayout(db: Db, providerId: string, s: ProviderSettings, now: Date): Promise<{ count: number; totalCents: number }> {
  return db.tx(async (tx) => {
    await tx.query('SELECT 1 FROM providers WHERE id = $1 FOR UPDATE', [providerId]); // one request at a time per provider
    const due = await tx.query<{ id: string; net_cents: number }>(
      `SELECT id, net_cents FROM payouts
        WHERE provider_id = $1 AND status = 'pending' AND available_at <= $2
          AND (booking_id IS NULL OR EXISTS (SELECT 1 FROM bookings b WHERE b.id = payouts.booking_id AND b.status = 'completed'))
        FOR UPDATE`,
      [providerId, now],
    );
    if (due.rowCount === 0) throw new PayoutError('nothing_to_pay', 'Nothing is available to withdraw yet.');
    const bank = (await tx.query<{ bank_account_enc: string | null }>('SELECT bank_account_enc FROM providers WHERE id = $1', [providerId])).rows[0];
    if (!bank?.bank_account_enc) throw new PayoutError('no_bank_details', 'Add your bank details first so we know where to send your money.');
    const total = due.rows.reduce((a, r) => a + r.net_cents, 0);
    if (total < s.minPayoutCents) {
      throw new PayoutError('below_minimum', `The minimum withdrawal is RM ${(s.minPayoutCents / 100).toFixed(2)}.`);
    }
    await tx.query("UPDATE payouts SET status = 'requested', requested_at = $2, updated_at = $2 WHERE id = ANY($1::uuid[])", [due.rows.map((r) => r.id), now]);
    return { count: due.rowCount, totalCents: total };
  });
}

/**
 * Admin has transferred the money by bank transfer and records it. Every requested payout of this provider
 * is marked paid, its booking becomes paid_out, and the held customer payment is released.
 */
export async function markProviderPaid(
  db: Db,
  providerId: string,
  adminId: string,
  reference: string,
  now: Date,
): Promise<{ count: number; totalCents: number }> {
  return db.tx(async (tx) => {
    const rows = (
      await tx.query<{ id: string; booking_id: string | null; net_cents: number }>(
        "SELECT id, booking_id, net_cents FROM payouts WHERE provider_id = $1 AND status = 'requested' FOR UPDATE",
        [providerId],
      )
    ).rows;
    if (rows.length === 0) throw new PayoutError('nothing_requested', 'This provider has no withdrawal waiting.');
    const total = rows.reduce((a, r) => a + r.net_cents, 0);
    await tx.query("UPDATE payouts SET status = 'paid', paid_at = $2, paid_reference = $3, updated_at = $2 WHERE id = ANY($1::uuid[])", [
      rows.map((r) => r.id),
      now,
      reference,
    ]);
    const bookingIds = rows.map((r) => r.booking_id).filter((x): x is string => !!x);
    if (bookingIds.length > 0) {
      await tx.query("UPDATE bookings SET status = 'paid_out', updated_at = $2 WHERE id = ANY($1::uuid[]) AND status = 'completed'", [bookingIds, now]);
      await tx.query("UPDATE payments SET status = 'released', updated_at = $2 WHERE booking_id = ANY($1::uuid[]) AND status = 'held'", [bookingIds, now]);
    }
    await audit(tx, adminId, 'payout.paid', 'provider', providerId, { count: rows.length, totalCents: total, reference });
    return { count: rows.length, totalCents: total };
  });
}
