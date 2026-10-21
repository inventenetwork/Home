import type { Db } from '../db/index.js';

/**
 * After a provider loses a skill, any open job offer for a service that needs it is withdrawn (they could no longer be assigned it).
 * Jobs they already accepted are left alone: an admin decides what to do with those (Handover tab).
 */
export async function withdrawUnskilledOffers(tx: Db, providerId: string, now: Date): Promise<number> {
  const r = await tx.query(
    `UPDATE job_offers jo SET status = 'withdrawn', responded_at = $2
      WHERE jo.provider_id = $1 AND jo.status = 'offered'
        AND EXISTS (
          SELECT 1 FROM bookings b JOIN service_skills ss ON ss.service_id = b.service_id
           WHERE b.id = jo.booking_id
             AND NOT EXISTS (SELECT 1 FROM provider_skills ps WHERE ps.provider_id = $1 AND ps.skill_id = ss.skill_id))`,
    [providerId, now],
  );
  return r.rowCount ?? 0;
}
