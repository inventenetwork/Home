import {
  eligibleProviderIds,
  loadDayContext,
  localDateString,
  localMinutes,
  providerIsFree,
} from '../bookings/availability.js';
import type { BookingSettings } from '../bookings/settings.js';
import { TransitionError, type Actor } from '../bookings/status.js';
import { setStatus } from '../bookings/transition.js';
import type { Db } from '../db/index.js';
import { rankCandidates, type Candidate } from './rank.js';

const MS_PER_MIN = 60_000;
const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(',');

interface BookingFacts {
  status: string;
  service_id: string;
  area_id: string | null;
  scheduled_at: Date;
  duration_minutes: number;
}

/** Locks the booking row and returns what matching needs to know about it. Run inside db.tx(). */
async function lockBooking(tx: Db, bookingId: string): Promise<BookingFacts | undefined> {
  return (
    await tx.query<BookingFacts>(
      `SELECT b.status, b.service_id, a.area_id, b.scheduled_at, b.duration_minutes
         FROM bookings b JOIN addresses a ON a.id = b.address_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId],
    )
  ).rows[0];
}

/**
 * A paid booking goes out to the best few free providers. Run inside db.tx().
 * Moves the booking pending -> offered (already-offered bookings are re-run, skipping providers asked before).
 * If nobody is free, the booking stays "offered" with no open offers, which is how the admin sees it needs a person.
 */
export async function startMatching(
  tx: Db,
  bookingId: string,
  actor: Actor,
  now: Date,
  settings: BookingSettings,
): Promise<{ offeredTo: string[] }> {
  const b = await lockBooking(tx, bookingId);
  if (!b) throw new TransitionError('not_found', 'Booking not found');
  if (b.status === 'pending') await setStatus(tx, bookingId, 'offered', actor, now);
  else if (b.status !== 'offered') throw new TransitionError('invalid_transition', `A ${b.status} booking cannot be offered.`);
  if (!b.area_id) return { offeredTo: [] };

  const start = new Date(b.scheduled_at);
  const asked = new Set(
    (await tx.query<{ provider_id: string }>('SELECT provider_id FROM job_offers WHERE booking_id = $1', [bookingId])).rows.map((r) => r.provider_id),
  );
  const eligible = (await eligibleProviderIds(tx, b.service_id, b.area_id)).filter((id) => !asked.has(id));
  if (eligible.length === 0) return { offeredTo: [] };

  const ctx = await loadDayContext(tx, eligible, b.area_id, localDateString(start), bookingId);
  const free = eligible.filter((id) => providerIsFree(ctx, id, localMinutes(start), b.duration_minutes, settings));
  if (free.length === 0) return { offeredTo: [] };

  const stats = await tx.query<{ id: string; rating_avg: string; rating_count: number; offers_received: number }>(
    `SELECT id, rating_avg, rating_count, offers_received FROM providers WHERE id IN (${placeholders(free.length)})`,
    free,
  );
  const candidates: Candidate[] = stats.rows.map((r) => ({
    providerId: r.id,
    ratingAvg: Number(r.rating_avg),
    ratingCount: r.rating_count,
    offersReceived: r.offers_received,
  }));
  let ranked = rankCandidates(candidates);
  // Repeat customers: the provider who did the previous visit of the same plan is asked first, if free.
  const prev = await tx.query<{ provider_id: string }>(
    `SELECT ba.provider_id
       FROM bookings cur
       JOIN recurring_plans rp ON rp.id = cur.recurring_plan_id AND rp.keep_provider
       JOIN bookings old ON old.recurring_plan_id = rp.id AND old.id <> cur.id AND old.status IN ('completed','paid_out')
       JOIN booking_assignments ba ON ba.booking_id = old.id
      WHERE cur.id = $1
      ORDER BY old.scheduled_at DESC LIMIT 1`,
    [bookingId],
  );
  const preferred = prev.rows[0]?.provider_id;
  if (preferred) ranked = [...ranked.filter((c) => c.providerId === preferred), ...ranked.filter((c) => c.providerId !== preferred)];
  const chosen = ranked.slice(0, settings.offersPerBooking);

  const expiresAt = new Date(now.getTime() + settings.offerTimeoutMin * MS_PER_MIN);
  for (const c of chosen) {
    await tx.query(
      "INSERT INTO job_offers (booking_id, provider_id, status, offered_at, expires_at) VALUES ($1, $2, 'offered', $3, $4)",
      [bookingId, c.providerId, now, expiresAt],
    );
    await tx.query('UPDATE providers SET offers_received = offers_received + 1 WHERE id = $1', [c.providerId]);
  }
  return { offeredTo: chosen.map((c) => c.providerId) };
}

/** Marks offers whose time ran out. Cheap, so it is called whenever offers or bookings are read, and once a minute by the server. */
export async function expireStaleOffers(db: Db, now: Date): Promise<number> {
  const r = await db.query(
    "UPDATE job_offers SET status = 'expired', responded_at = $1 WHERE status = 'offered' AND expires_at <= $1 RETURNING id",
    [now],
  );
  return r.rowCount;
}

export type AcceptResult =
  | { ok: true }
  | { ok: false; code: 'offer_not_found' | 'offer_expired' | 'offer_taken' | 'booking_cancelled' | 'provider_unavailable' };

/**
 * A provider takes the job. The booking row is locked, so when two providers tap Accept at the same moment
 * exactly one wins and the other is told it was taken. The provider row is locked too, so one person cannot
 * accept two overlapping jobs at once.
 */
export async function acceptOffer(
  db: Db,
  providerId: string,
  bookingId: string,
  now: Date,
  settings: BookingSettings,
): Promise<AcceptResult> {
  return db.tx(async (tx): Promise<AcceptResult> => {
    const b = await lockBooking(tx, bookingId);
    if (!b) return { ok: false, code: 'offer_not_found' };
    const offer = (
      await tx.query<{ id: string; status: string; expires_at: Date }>(
        'SELECT id, status, expires_at FROM job_offers WHERE booking_id = $1 AND provider_id = $2',
        [bookingId, providerId],
      )
    ).rows[0];
    if (!offer) return { ok: false, code: 'offer_not_found' };

    if (b.status === 'cancelled') return { ok: false, code: 'booking_cancelled' };
    if (b.status !== 'offered') return { ok: false, code: 'offer_taken' };
    if (offer.status === 'withdrawn') return { ok: false, code: 'offer_taken' };
    if (offer.status === 'expired' || (offer.status === 'offered' && new Date(offer.expires_at).getTime() <= now.getTime())) {
      return { ok: false, code: 'offer_expired' };
    }
    if (offer.status !== 'offered') return { ok: false, code: 'offer_not_found' }; // already declined

    await tx.query('SELECT id FROM providers WHERE id = $1 FOR UPDATE', [providerId]);
    if (!b.area_id) return { ok: false, code: 'provider_unavailable' };
    const start = new Date(b.scheduled_at);
    const ctx = await loadDayContext(tx, [providerId], b.area_id, localDateString(start), bookingId);
    if (!providerIsFree(ctx, providerId, localMinutes(start), b.duration_minutes, settings)) {
      return { ok: false, code: 'provider_unavailable' };
    }

    await tx.query('INSERT INTO booking_assignments (booking_id, provider_id, accepted_at) VALUES ($1, $2, $3)', [bookingId, providerId, now]);
    await tx.query("UPDATE job_offers SET status = 'accepted', responded_at = $2 WHERE id = $1", [offer.id, now]);
    await tx.query('UPDATE providers SET offers_accepted = offers_accepted + 1 WHERE id = $1', [providerId]);
    await setStatus(tx, bookingId, 'confirmed', 'provider', now); // also withdraws everyone else's open offers
    return { ok: true };
  });
}

/** A provider turns the job down. Returns false when there was no open offer to decline. */
export async function declineOffer(db: Db, providerId: string, bookingId: string, now: Date): Promise<boolean> {
  const r = await db.query(
    "UPDATE job_offers SET status = 'declined', responded_at = $3 WHERE booking_id = $1 AND provider_id = $2 AND status = 'offered' RETURNING id",
    [bookingId, providerId, now],
  );
  return r.rowCount > 0;
}
