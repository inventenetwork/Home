import { audit } from '../admin/audit.js';
import { setStatus } from '../bookings/transition.js';
import type { Db } from '../db/index.js';
import type { PaymentGateway } from '../payments/gateway.js';
import { refundBooking } from '../payments/service.js';
import type { ProviderSettings } from '../provider/settings.js';

const HOUR = 3_600_000;

export class DisputeError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_disputable' | 'window_closed' | 'already_open' | 'not_open' | 'nothing_to_refund' | 'refund_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'DisputeError';
  }
}

/**
 * A customer reports a problem with a finished job. Allowed only while the provider's payout is still on hold
 * (`payout_hold_hours` after the job), which is exactly what the hold is for. The booking freezes as "disputed"
 * and the payout cannot be withdrawn until an admin settles it.
 */
export async function openDispute(db: Db, customerId: string, bookingId: string, reason: string, now: Date): Promise<string> {
  return db.tx(async (tx) => {
    const b = (
      await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1 AND customer_id = $2 FOR UPDATE', [bookingId, customerId])
    ).rows[0];
    if (!b) throw new DisputeError('not_found', 'Booking not found');
    if (b.status === 'disputed') throw new DisputeError('already_open', 'A problem has already been reported for this job.');
    if (b.status !== 'completed') throw new DisputeError('not_disputable', 'You can report a problem once the job is finished and before the provider is paid.');
    const payout = (await tx.query<{ available_at: Date; status: string }>('SELECT available_at, status FROM payouts WHERE booking_id = $1', [bookingId])).rows[0];
    if (!payout || payout.status !== 'pending' || new Date(payout.available_at).getTime() <= now.getTime()) {
      throw new DisputeError('window_closed', 'The time to report a problem with this job has passed. Please contact support.');
    }
    await setStatus(tx, bookingId, 'disputed', 'customer', now);
    const d = await tx.query<{ id: string }>('INSERT INTO disputes (booking_id, opened_by, reason, created_at) VALUES ($1,$2,$3,$4) RETURNING id', [bookingId, customerId, reason, now]);
    await audit(tx, customerId, 'dispute.open', 'booking', bookingId, { disputeId: d.rows[0]!.id });
    return d.rows[0]!.id;
  });
}

export type Outcome = 'refund' | 'redo' | 'reject';

export interface ResolveInput {
  outcome: Outcome;
  note: string;
  amountCents?: number;
  chargeProvider?: boolean;
}

/**
 * The admin settles a dispute.
 *  - refund, whole amount: booking is cancelled, the customer gets everything back, the provider's payout is voided.
 *  - refund, partial: booking goes back to completed. With `chargeProvider` the refund is taken out of the provider's payout
 *    (never below zero); otherwise Home360 absorbs it. The hold ends, so the rest can be withdrawn.
 *  - redo: back to completed, the hold restarts (the admin arranges the redo; scheduling it in-app comes later).
 *  - reject: complaint not upheld; back to completed and the payout is available now.
 */
export async function resolveDispute(
  db: Db,
  gateway: PaymentGateway,
  adminId: string,
  disputeId: string,
  input: ResolveInput,
  settings: ProviderSettings,
  now: Date,
) {
  const d = (await db.query<{ booking_id: string; status: string }>('SELECT booking_id, status FROM disputes WHERE id = $1', [disputeId])).rows[0];
  if (!d) throw new DisputeError('not_found', 'Dispute not found');
  if (d.status !== 'open') throw new DisputeError('not_open', 'This dispute is already settled.');
  const bookingId = d.booking_id;

  let refundCents: number | null = null;
  let full = false;
  if (input.outcome === 'refund') {
    const pay = (await db.query<{ amount_cents: number; refunded_cents: number }>("SELECT amount_cents, refunded_cents FROM payments WHERE booking_id = $1 AND status = 'held'", [bookingId])).rows[0];
    if (!pay || pay.amount_cents - pay.refunded_cents <= 0) throw new DisputeError('nothing_to_refund', 'There is no held payment to refund for this booking.');
    const remaining = pay.amount_cents - pay.refunded_cents;
    refundCents = input.amountCents ?? remaining;
    if (refundCents > remaining) throw new DisputeError('refund_too_large', `At most RM ${(remaining / 100).toFixed(2)} can be refunded.`);
    full = refundCents === remaining;
  }

  await db.tx(async (tx) => {
    const locked = (await tx.query<{ status: string }>('SELECT status FROM disputes WHERE id = $1 FOR UPDATE', [disputeId])).rows[0]!;
    if (locked.status !== 'open') throw new DisputeError('not_open', 'This dispute is already settled.');
    const status = input.outcome === 'refund' ? 'resolved_refund' : input.outcome === 'redo' ? 'resolved_redo' : 'rejected';
    if (input.outcome === 'refund' && full) {
      await setStatus(tx, bookingId, 'cancelled', 'admin', now, { reason: 'dispute_refund' });
      await tx.query("UPDATE payouts SET status = 'failed', updated_at = $2 WHERE booking_id = $1 AND status IN ('pending','requested')", [bookingId, now]);
    } else {
      await setStatus(tx, bookingId, 'completed', 'admin', now);
      const availableAt = input.outcome === 'redo' ? new Date(now.getTime() + settings.payoutHoldHours * HOUR) : now;
      await tx.query("UPDATE payouts SET available_at = $2, updated_at = $2 WHERE booking_id = $1 AND status = 'pending'", [bookingId, availableAt]);
      if (input.outcome === 'refund' && input.chargeProvider && refundCents) {
        await tx.query("UPDATE payouts SET net_cents = GREATEST(0, net_cents - $2) WHERE booking_id = $1 AND status = 'pending'", [bookingId, refundCents]);
      }
    }
    await tx.query(
      'UPDATE disputes SET status = $2, resolution_note = $3, resolved_by = $4, resolved_at = $5, refund_cents = $6, charge_provider = $7 WHERE id = $1',
      [disputeId, status, input.note, adminId, now, refundCents, input.outcome === 'refund' && !full && !!input.chargeProvider],
    );
    await audit(tx, adminId, `dispute.${input.outcome}`, 'dispute', disputeId, { bookingId, refundCents, chargeProvider: !!input.chargeProvider, note: input.note });
  });

  // Money goes back after the database change is safely recorded (a failed gateway call can be retried from the admin list).
  if (input.outcome === 'refund' && refundCents) {
    await refundBooking(db, gateway, bookingId, { reason: 'dispute', createdBy: adminId, amountCents: refundCents }, now);
  }
}
