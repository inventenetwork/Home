import { expireStalePending } from './bookings/availability.js';
import { loadBookingSettings } from './bookings/settings.js';
import type { Db } from './db/index.js';
import { expireStaleOffers } from './matching/service.js';

/** Release unpaid slots and close timed-out job offers. Safe to run as often as you like. */
export async function runHousekeeping(db: Db, now: Date = new Date()): Promise<void> {
  await expireStalePending(db, now, await loadBookingSettings(db));
  await expireStaleOffers(db, now);
}
