import type { Db } from '../db/index.js';
import { canTransition, TransitionError, type Actor, type BookingStatus } from './status.js';

/**
 * Moves a booking to a new status if (and only if) the status machine allows this actor to do so.
 * Locks the booking row, so two simultaneous requests cannot both succeed. Run it inside db.tx().
 * Returns the previous status.
 */
export async function setStatus(
  tx: Db,
  bookingId: string,
  to: BookingStatus,
  actor: Actor,
  now: Date,
  opts: { reason?: string } = {},
): Promise<BookingStatus> {
  const cur = (
    await tx.query<{ status: BookingStatus }>('SELECT status FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])
  ).rows[0];
  if (!cur) throw new TransitionError('not_found', 'Booking not found');
  if (!canTransition(cur.status, to, actor)) {
    throw new TransitionError('invalid_transition', `A ${cur.status} booking cannot be changed to ${to}.`);
  }
  await tx.query(
    `UPDATE bookings
        SET status = $2::text,
            updated_at = $3,
            cancelled_reason = CASE WHEN $2::text = 'cancelled' THEN $4::text ELSE cancelled_reason END
      WHERE id = $1`,
    [bookingId, to, now, opts.reason ?? null],
  );
  // Once a booking is cancelled or has its provider, any offers still open are pointless: close them.
  if (to === 'cancelled' || to === 'confirmed') {
    await tx.query("UPDATE job_offers SET status = 'withdrawn', responded_at = $2 WHERE booking_id = $1 AND status = 'offered'", [bookingId, now]);
  }
  return cur.status;
}

export function transitionHttpStatus(err: TransitionError): number {
  return err.code === 'not_found' ? 404 : 409;
}
