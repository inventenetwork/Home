import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import { createDevProvider } from '../db/dev-provider.js';
import { LEGAL_VERSION } from '../legal.js';
import type { Role } from '../types.js';

/**
 * DEMO ONLY (DEMO_MODE=true). Three fixed accounts with one shared password, so a client can click through the app
 * without email codes. The accounts are created on first use. The names mirror the three kinds of user.
 */
export const DEMO_ACCOUNTS = [
  { username: 'admin', role: 'admin' as Role, email: 'demo.admin@example.com', name: 'Demo Admin', label: 'Super admin' },
  { username: 'vendor', role: 'provider' as Role, email: 'demo.vendor@example.com', name: 'Aisha Rahman', label: 'Vendor / supplier' },
  { username: 'user', role: 'customer' as Role, email: 'demo.user@example.com', name: 'Demo User', label: 'User / customer' },
];

export function demoAccount(username: string) {
  const u = username.trim().toLowerCase();
  return DEMO_ACCOUNTS.find((a) => a.username === u);
}

export function demoPasswordMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Makes sure the account exists (an approved vendor who covers every area, a customer with an address) and returns it. */
export async function ensureDemoUser(db: Db, acct: (typeof DEMO_ACCOUNTS)[number]) {
  if (acct.role === 'provider') await createDevProvider(db, { email: acct.email, name: acct.name });
  let user = (
    await db.query<{ id: string; email: string; role: Role; status: string; full_name: string | null; locale: string }>(
      'SELECT id, email, role, status, full_name, locale FROM users WHERE email = $1',
      [acct.email],
    )
  ).rows[0];
  if (!user) {
    user = (
      await db.query<{ id: string; email: string; role: Role; status: string; full_name: string | null; locale: string }>(
        `INSERT INTO users (email, role, full_name, consent_at, consent_version) VALUES ($1, $2, $3, now(), $4)
         RETURNING id, email, role, status, full_name, locale`,
        [acct.email, acct.role, acct.name, LEGAL_VERSION],
      )
    ).rows[0]!;
  }
  if (acct.role === 'customer') {
    const has = await db.query('SELECT 1 FROM addresses WHERE user_id = $1 LIMIT 1', [user.id]);
    if (has.rowCount === 0) {
      await db.query(
        `INSERT INTO addresses (user_id, label, line1, postcode, area_id)
         SELECT $1, 'Home', '12 Jalan Demo', '47300', id FROM areas ORDER BY name LIMIT 1`,
        [user.id],
      );
    }
  }
  return user;
}
