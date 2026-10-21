import type { Db } from '../db/index.js';

export const REVIEW_WINDOW_DAYS = 30;
const DAY = 86_400_000;

export class ReviewError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_reviewable' | 'already_reviewed' | 'review_window_closed',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

/** A customer rates a finished job once. The provider's average is recomputed from all their reviews, so it can never drift. */
export async function addReview(db: Db, customerId: string, bookingId: string, rating: number, comment: string | null, now: Date) {
  return db.tx(async (tx) => {
    const b = (
      await tx.query<{ status: string; provider_id: string | null; checked_out_at: Date | null }>(
        `SELECT b.status, ba.provider_id, ba.checked_out_at FROM bookings b
           LEFT JOIN booking_assignments ba ON ba.booking_id = b.id
          WHERE b.id = $1 AND b.customer_id = $2 FOR UPDATE OF b`,
        [bookingId, customerId],
      )
    ).rows[0];
    if (!b) throw new ReviewError('not_found', 'Booking not found');
    if (!b.provider_id || (b.status !== 'completed' && b.status !== 'paid_out')) {
      throw new ReviewError('not_reviewable', 'You can review a job once it is finished.');
    }
    if (b.checked_out_at && now.getTime() - new Date(b.checked_out_at).getTime() > REVIEW_WINDOW_DAYS * DAY) {
      throw new ReviewError('review_window_closed', `Reviews can be left within ${REVIEW_WINDOW_DAYS} days of the job.`);
    }
    const dup = await tx.query('SELECT 1 FROM reviews WHERE booking_id = $1', [bookingId]);
    if (dup.rowCount > 0) throw new ReviewError('already_reviewed', 'You have already reviewed this job.');
    await tx.query('INSERT INTO reviews (booking_id, provider_id, customer_id, rating, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      bookingId, b.provider_id, customerId, rating, comment, now,
    ]);
    await tx.query(
      `UPDATE providers SET
         rating_avg = COALESCE((SELECT round(avg(rating)::numeric, 2) FROM reviews WHERE provider_id = $1), 0),
         rating_count = (SELECT count(*) FROM reviews WHERE provider_id = $1)
       WHERE id = $1`,
      [b.provider_id],
    );
  });
}
