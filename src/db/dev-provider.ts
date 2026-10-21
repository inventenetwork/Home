import type { Db } from './index.js';

/**
 * DEVELOPMENT ONLY. Creates (or refreshes) an approved test provider who can do every service, covers every
 * launch area and works 08:00-20:00 every day, so booking slots become available while provider onboarding
 * (step 7) does not exist yet. Safe to run repeatedly. Run it for several emails to add capacity.
 */
export async function createDevProvider(db: Db, opts: { email?: string; name?: string } = {}) {
  const email = (opts.email ?? 'provider@example.com').trim().toLowerCase();
  return db.tx(async (tx) => {
    const existing = (await tx.query<{ id: string; role: string }>('SELECT id, role FROM users WHERE email = $1', [email])).rows[0];
    if (existing && existing.role !== 'provider') {
      throw new Error(`${email} already exists as a ${existing.role}. Use a different email for the test provider.`);
    }
    const userId =
      existing?.id ??
      (
        await tx.query<{ id: string }>(
          "INSERT INTO users (email, role, full_name, consent_at) VALUES ($1, 'provider', $2, now()) RETURNING id",
          [email, opts.name ?? 'Aisha Rahman'],
        )
      ).rows[0]!.id;

    const providerId = (
      await tx.query<{ id: string }>(
        `INSERT INTO providers (user_id, vetting_status) VALUES ($1, 'approved')
         ON CONFLICT (user_id) DO UPDATE SET vetting_status = 'approved'
         RETURNING id`,
        [userId],
      )
    ).rows[0]!.id;

    await tx.query('INSERT INTO provider_areas (provider_id, area_id) SELECT $1, id FROM areas ON CONFLICT DO NOTHING', [providerId]);
    await tx.query('INSERT INTO provider_skills (provider_id, skill_id) SELECT $1, id FROM skills ON CONFLICT DO NOTHING', [providerId]);
    await tx.query('DELETE FROM provider_availability WHERE provider_id = $1 AND weekday IS NOT NULL', [providerId]);
    for (let weekday = 0; weekday <= 6; weekday++) {
      await tx.query(
        "INSERT INTO provider_availability (provider_id, weekday, start_time, end_time) VALUES ($1, $2, '08:00', '20:00')",
        [providerId, weekday],
      );
    }
    return { email, userId, providerId };
  });
}
