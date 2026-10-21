import { audit } from '../admin/audit.js';
import type { BookingSettings } from '../bookings/settings.js';
import type { Db } from '../db/index.js';
import { startMatching } from '../matching/service.js';
import { GatewayError, type GatewayEvent, type PaymentGateway, type PaymentMethod } from './gateway.js';

const MS_PER_MIN = 60_000;
/** A refund stuck "processing" longer than this is assumed to have been interrupted and may be retried. */
const STUCK_REFUND_MIN = 5;

export class PaymentError extends Error {
  constructor(
    public readonly code:
      | 'booking_not_found'
      | 'booking_not_payable'
      | 'booking_expired'
      | 'gateway_unavailable'
      | 'nothing_to_refund'
      | 'refund_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

// ───────────── paying ─────────────

export interface StartedPayment {
  paymentId: string;
  redirectUrl: string;
  method: PaymentMethod;
  amountCents: number;
}

/**
 * The customer chose how to pay: create a payment, ask the gateway for a checkout page, return where to send them.
 * An earlier unfinished attempt is replaced (the customer may have closed the tab or picked another bank).
 */
export async function startPayment(
  db: Db,
  gateway: PaymentGateway,
  input: { bookingId: string; customerId: string; method: PaymentMethod },
  now: Date,
  settings: BookingSettings,
): Promise<StartedPayment> {
  const created = await db.tx(async (tx) => {
    const b = (
      await tx.query<{ status: string; total_cents: number; created_at: Date }>(
        'SELECT status, total_cents, created_at FROM bookings WHERE id = $1 AND customer_id = $2 FOR UPDATE',
        [input.bookingId, input.customerId],
      )
    ).rows[0];
    if (!b) throw new PaymentError('booking_not_found', 'Booking not found');
    if (b.status !== 'pending' || b.total_cents <= 0) throw new PaymentError('booking_not_payable', `A ${b.status} booking is not waiting for payment.`);
    if (new Date(b.created_at).getTime() + settings.pendingExpiryMin * MS_PER_MIN < now.getTime()) {
      throw new PaymentError('booking_expired', 'This booking was held for too long without payment. Please book again.');
    }
    await tx.query(
      "UPDATE payments SET status = 'failed', failure_reason = 'superseded', updated_at = $2 WHERE booking_id = $1 AND status = 'pending'",
      [input.bookingId, now],
    );
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO payments (booking_id, gateway, method, amount_cents, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $5) RETURNING id`,
      [input.bookingId, gateway.name, input.method, b.total_cents, now],
    );
    return { paymentId: ins.rows[0]!.id, amountCents: b.total_cents };
  });

  // The gateway call happens outside the transaction: never hold a database lock while waiting on someone else's server.
  try {
    const charge = await gateway.createCharge({
      paymentId: created.paymentId,
      bookingId: input.bookingId,
      amountCents: created.amountCents,
      method: input.method,
      description: `Home360 booking ${input.bookingId.slice(0, 8)}`,
    });
    await db.query("UPDATE payments SET gateway_ref = $2, updated_at = $3 WHERE id = $1 AND status = 'pending'", [created.paymentId, charge.gatewayRef, now]);
    return { paymentId: created.paymentId, redirectUrl: charge.redirectUrl, method: input.method, amountCents: created.amountCents };
  } catch {
    await db.query("UPDATE payments SET status = 'failed', failure_reason = 'gateway_error', updated_at = $2 WHERE id = $1 AND status = 'pending'", [created.paymentId, now]);
    throw new PaymentError('gateway_unavailable', 'The payment service is not available right now. Please try again.');
  }
}

export type EventResult = 'paid' | 'paid_late_refunded' | 'duplicate' | 'ignored' | 'failed' | 'unknown_payment' | 'amount_mismatch';

/**
 * A verified message from the gateway. Safe to receive any number of times, in any order:
 * the payment row is locked and only moves forward, so a replay changes nothing.
 */
export async function applyGatewayEvent(
  db: Db,
  gateway: PaymentGateway,
  event: GatewayEvent,
  now: Date,
  settings: BookingSettings,
): Promise<EventResult> {
  const { result, refundId } = await db.tx(async (tx): Promise<{ result: EventResult; refundId?: string }> => {
    const p = (
      await tx.query<{ id: string; booking_id: string; amount_cents: number; status: string }>(
        'SELECT id, booking_id, amount_cents, status FROM payments WHERE gateway = $1 AND gateway_ref = $2 FOR UPDATE',
        [gateway.name, event.gatewayRef],
      )
    ).rows[0];
    if (!p) return { result: 'unknown_payment' };

    if (event.type !== 'payment.succeeded') {
      if (p.status !== 'pending') return { result: 'ignored' }; // e.g. a "failed" message that arrives after the payment went through
      await tx.query("UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = $3 WHERE id = $1", [
        p.id,
        event.type === 'payment.cancelled' ? 'cancelled' : 'declined',
        now,
      ]);
      return { result: 'failed' };
    }

    if (event.amountCents !== p.amount_cents) {
      await audit(tx, null, 'payment.amount_mismatch', 'payment', p.id, { expected: p.amount_cents, got: event.amountCents });
      return { result: 'amount_mismatch' }; // nothing changes; a human should look
    }
    if (p.status !== 'pending' && p.status !== 'failed') return { result: 'duplicate' }; // already held, refunded or released

    // Money arrived. Normally the attempt is still "pending"; "failed" means a late success after we gave up on it.
    await tx.query("UPDATE payments SET status = 'failed', failure_reason = 'superseded', updated_at = $2 WHERE booking_id = $1 AND status = 'pending' AND id <> $3", [
      p.booking_id,
      now,
      p.id,
    ]);
    const b = (await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1 FOR UPDATE', [p.booking_id])).rows[0]!;
    const otherHeld = (await tx.query("SELECT 1 FROM payments WHERE booking_id = $1 AND status = 'held' AND id <> $2", [p.booking_id, p.id])).rowCount > 0;

    if (otherHeld || b.status === 'cancelled') {
      // Paid twice, or paid for a booking that no longer exists (the hold ran out, or it was cancelled meanwhile): give it all back.
      await tx.query(
        "UPDATE payments SET status = 'refunded', refunded_cents = amount_cents, paid_at = $2, failure_reason = NULL, updated_at = $2 WHERE id = $1",
        [p.id, now],
      );
      const id = await insertRefund(tx, p.id, p.amount_cents, otherHeld ? 'duplicate_payment' : 'booking_cancelled_before_payment', null, now);
      await audit(tx, null, 'payment.auto_refund', 'payment', p.id, { reason: otherHeld ? 'duplicate_payment' : b.status });
      return { result: 'paid_late_refunded', refundId: id };
    }

    await tx.query("UPDATE payments SET status = 'held', paid_at = $2, failure_reason = NULL, updated_at = $2 WHERE id = $1", [p.id, now]);
    if (b.status === 'pending') await startMatching(tx, p.booking_id, 'system', now, settings); // pending -> offered, offers go out
    return { result: 'paid' };
  });

  if (refundId) await executeRefund(db, gateway, refundId, now);
  return result;
}

// ───────────── refunding ─────────────

async function insertRefund(tx: Db, paymentId: string, amountCents: number, reason: string, createdBy: string | null, now: Date): Promise<string> {
  const r = await tx.query<{ id: string }>(
    'INSERT INTO refunds (payment_id, amount_cents, reason, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id',
    [paymentId, amountCents, reason, createdBy, now],
  );
  return r.rows[0]!.id;
}

export interface RefundOutcome {
  refundId: string;
  amountCents: number;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
}

/**
 * Give money back for a booking's held payment. The amount is reserved in the database first (so two refunds can never
 * add up to more than was paid), then the gateway is asked to deliver it. If the gateway fails, the refund stays on
 * record as "failed" and can be retried; it is never lost.
 * Returns null when there is nothing held to refund.
 */
export async function refundBooking(
  db: Db,
  gateway: PaymentGateway,
  bookingId: string,
  opts: { reason: string; createdBy: string | null; amountCents?: number },
  now: Date,
): Promise<RefundOutcome | null> {
  const reserved = await db.tx(async (tx) => {
    const p = (
      await tx.query<{ id: string; amount_cents: number; refunded_cents: number }>(
        "SELECT id, amount_cents, refunded_cents FROM payments WHERE booking_id = $1 AND status = 'held' FOR UPDATE",
        [bookingId],
      )
    ).rows[0];
    if (!p) return null;
    const remaining = p.amount_cents - p.refunded_cents;
    const amount = opts.amountCents ?? remaining;
    if (remaining <= 0) throw new PaymentError('nothing_to_refund', 'This payment has already been refunded.');
    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
      throw new PaymentError('refund_too_large', `At most RM ${(remaining / 100).toFixed(2)} can still be refunded.`);
    }
    await tx.query(
      `UPDATE payments SET refunded_cents = refunded_cents + $2,
              status = CASE WHEN refunded_cents + $2 = amount_cents THEN 'refunded' ELSE status END, updated_at = $3
        WHERE id = $1`,
      [p.id, amount, now],
    );
    const id = await insertRefund(tx, p.id, amount, opts.reason, opts.createdBy, now);
    await audit(tx, opts.createdBy, 'payment.refund', 'payment', p.id, { amountCents: amount, reason: opts.reason });
    return { id, amount };
  });
  if (!reserved) return null;
  const status = await executeRefund(db, gateway, reserved.id, now);
  return { refundId: reserved.id, amountCents: reserved.amount, status };
}

/** Ask the gateway to deliver one recorded refund. Safe to call again for a failed (or interrupted) one. */
export async function executeRefund(db: Db, gateway: PaymentGateway, refundId: string, now: Date): Promise<RefundOutcome['status']> {
  const stuckBefore = new Date(now.getTime() - STUCK_REFUND_MIN * MS_PER_MIN);
  // Claim it, so two callers cannot send the same refund at once.
  const claimed = await db.query<{ amount_cents: number; reason: string; payment_id: string }>(
    `UPDATE refunds SET status = 'processing', updated_at = $2
      WHERE id = $1 AND (status IN ('pending','failed') OR (status = 'processing' AND updated_at < $3))
      RETURNING amount_cents, reason, payment_id`,
    [refundId, now, stuckBefore],
  );
  if (claimed.rowCount === 0) {
    const cur = (await db.query<{ status: RefundOutcome['status'] }>('SELECT status FROM refunds WHERE id = $1', [refundId])).rows[0];
    return cur?.status ?? 'failed';
  }
  const r = claimed.rows[0]!;
  const pay = (await db.query<{ gateway_ref: string | null }>('SELECT gateway_ref FROM payments WHERE id = $1', [r.payment_id])).rows[0];
  try {
    if (!pay?.gateway_ref) throw new GatewayError('refund_failed', 'No gateway reference for this payment');
    const out = await gateway.refund({ paymentGatewayRef: pay.gateway_ref, refundId, amountCents: r.amount_cents, reason: r.reason });
    const status = out.status === 'succeeded' ? 'succeeded' : 'pending';
    await db.query('UPDATE refunds SET status = $2, gateway_ref = $3, updated_at = $4 WHERE id = $1', [refundId, status, out.gatewayRef, now]);
    return status;
  } catch (err) {
    console.error(`Refund ${refundId} failed:`, (err as Error).message);
    await db.query("UPDATE refunds SET status = 'failed', updated_at = $2 WHERE id = $1", [refundId, now]);
    return 'failed';
  }
}

/** Retry every refund for a booking that the gateway has not confirmed yet. */
export async function retryRefunds(db: Db, gateway: PaymentGateway, bookingId: string, now: Date): Promise<RefundOutcome[]> {
  const { rows } = await db.query<{ id: string; amount_cents: number }>(
    `SELECT r.id, r.amount_cents FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE p.booking_id = $1 AND r.status IN ('pending','failed','processing') ORDER BY r.created_at`,
    [bookingId],
  );
  const out: RefundOutcome[] = [];
  for (const r of rows) out.push({ refundId: r.id, amountCents: r.amount_cents, status: await executeRefund(db, gateway, r.id, now) });
  return out;
}

// ───────────── what the screens show ─────────────

export interface PaymentSummary {
  status: 'pending' | 'paid' | 'partially_refunded' | 'refunded' | 'failed';
  method: PaymentMethod | null;
  amountCents: number;
  refundedCents: number;
  paidAt: string | null;
  /** A refund is owed to the customer but the gateway has not confirmed delivering it. */
  refundPending: boolean;
}

/** The booking's most relevant payment: one that took money if there is one, else the latest attempt. */
export async function loadPaymentSummary(db: Db, bookingId: string): Promise<PaymentSummary | null> {
  const p = (
    await db.query<Record<string, any>>(
      `SELECT p.id, p.status, p.method, p.amount_cents, p.refunded_cents, p.paid_at,
              EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'succeeded') AS refund_pending
         FROM payments p WHERE p.booking_id = $1
        ORDER BY (p.status IN ('held','released','refunded')) DESC, p.created_at DESC LIMIT 1`,
      [bookingId],
    )
  ).rows[0];
  if (!p) return null;
  const refunded = p.refunded_cents as number;
  const status: PaymentSummary['status'] =
    p.status === 'pending' ? 'pending'
    : p.status === 'failed' ? 'failed'
    : p.status === 'refunded' ? 'refunded'
    : refunded > 0 ? 'partially_refunded'
    : 'paid';
  return {
    status,
    method: (p.method as PaymentMethod | null) ?? null,
    amountCents: p.amount_cents as number,
    refundedCents: refunded,
    paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
    refundPending: p.refund_pending === true,
  };
}
