import { createDevProvider } from './dev-provider.js';
import type { Db } from './index.js';
import { LEGAL_VERSION } from '../legal.js';

/**
 * DEMO_MODE only. Gives the two demo logins something to look at: the `user` account has a history of bookings in every state,
 * and the `vendor` account has finished jobs (with reviews and payouts), a job in progress, upcoming jobs and offers waiting for
 * an answer. Runs once (it does nothing if demo.user already has bookings). Dates are relative to "now".
 */

export const DEMO_USER_EMAIL = 'demo.user@example.com';
export const DEMO_VENDOR_EMAIL = 'demo.vendor@example.com';
const OTHER_CUSTOMERS = [
  { email: 'demo.siti@example.com', name: 'Siti Aminah' },
  { email: 'demo.raj@example.com', name: 'Raj Kumar' },
];
const DAY = 86_400_000;

type Status = 'pending' | 'offered' | 'confirmed' | 'on_the_way' | 'in_progress' | 'completed' | 'paid_out' | 'cancelled' | 'disputed';
interface Plan {
  who: 'user' | 'siti' | 'raj';
  slug: string;
  day: number; // days from today (negative = past)
  hour: number; // Malaysia time
  units?: number;
  status: Status;
  review?: [number, string];
  note?: string;
  chat?: Array<['c' | 'p', string]>;
}

const PLANS: Plan[] = [
  // history
  { who: 'user', slug: 'home-cleaning', day: -58, hour: 10, units: 3, status: 'paid_out', review: [5, 'Spotless, and Aisha was very friendly. Will book again.'] },
  { who: 'siti', slug: 'ironing-laundry', day: -50, hour: 14, status: 'paid_out', review: [4, 'Neatly folded. Arrived a little late but told me in advance.'] },
  { who: 'user', slug: 'aircon-service', day: -41, hour: 11, units: 2, status: 'paid_out', review: [5, 'Both aircons are cold again. Explained everything clearly.'] },
  { who: 'raj', slug: 'home-cleaning', day: -33, hour: 9, units: 2, status: 'paid_out', review: [5, 'On time and thorough.'] },
  { who: 'user', slug: 'deep-cleaning', day: -24, hour: 9, status: 'paid_out', review: [4, 'Kitchen looks brand new. A bit of dust left on the top shelves.'] },
  { who: 'siti', slug: 'home-cleaning', day: -17, hour: 15, units: 2, status: 'paid_out', review: [5, 'Great job!'] },
  { who: 'user', slug: 'ironing-laundry', day: -13, hour: 13, status: 'paid_out' },
  { who: 'raj', slug: 'aircon-service', day: -9, hour: 16, units: 1, status: 'cancelled', note: 'customer_cancelled' },
  // recently finished: still inside the dispute window, payout not released yet
  { who: 'user', slug: 'home-cleaning', day: -3, hour: 10, units: 3, status: 'completed' },
  { who: 'siti', slug: 'aircon-service', day: -2, hour: 14, units: 2, status: 'completed' },
  // a customer complaint waiting for the admin
  { who: 'raj', slug: 'deep-cleaning', day: -6, hour: 9, status: 'disputed', note: 'Bathroom was not cleaned as agreed.' },
  // today
  { who: 'user', slug: 'home-cleaning', day: 0, hour: -1, units: 2, status: 'in_progress', chat: [['c', 'Hi Aisha, the gate code is 4821.'], ['p', 'Thanks! I have started in the kitchen.']] },
  // upcoming, accepted
  { who: 'user', slug: 'aircon-service', day: 1, hour: 11, units: 2, status: 'confirmed', chat: [['p', 'Hello! I will arrive around 11am. Please clear the space under the units.'], ['c', 'Sure, see you tomorrow.']] },
  { who: 'siti', slug: 'home-cleaning', day: 3, hour: 9, units: 3, status: 'confirmed' },
  { who: 'raj', slug: 'ironing-laundry', day: 4, hour: 15, status: 'confirmed' },
  { who: 'user', slug: 'deep-cleaning', day: 8, hour: 10, status: 'confirmed' },
  // waiting for the vendor to accept
  { who: 'user', slug: 'ironing-laundry', day: 5, hour: 10, status: 'offered' },
  { who: 'siti', slug: 'aircon-service', day: 6, hour: 13, units: 3, status: 'offered' },
  { who: 'raj', slug: 'home-cleaning', day: 7, hour: 14, units: 2, status: 'offered' },
];

/** Malaysia local time `hour` on the day `offset` days from today; a negative hour means "that many hours ago". */
function at(now: Date, offset: number, hour: number): Date {
  if (hour < 0) return new Date(now.getTime() + hour * 3_600_000);
  const myt = new Date(now.getTime() + 8 * 3_600_000);
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate() + offset, hour - 8, 0, 0));
}

export async function seedDemoPersonas(db: Db, now: Date = new Date()): Promise<{ bookings: number } | null> {
  return db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(360361)');
    const vendor = await createDevProvider(tx, { email: DEMO_VENDOR_EMAIL, name: 'Aisha Rahman' });

    const ensureCustomer = async (email: string, name: string, line1: string) => {
      let u = (await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0];
      if (!u) {
        u = (
          await tx.query<{ id: string }>(
            "INSERT INTO users (email, role, full_name, consent_at, consent_version) VALUES ($1, 'customer', $2, now(), $3) RETURNING id",
            [email, name, LEGAL_VERSION],
          )
        ).rows[0]!;
      }
      let a = (await tx.query<{ id: string }>('SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at LIMIT 1', [u.id])).rows[0];
      if (!a) {
        a = (
          await tx.query<{ id: string }>(
            `INSERT INTO addresses (user_id, label, line1, postcode, area_id)
             SELECT $1, 'Home', $2, '47300', id FROM areas ORDER BY name LIMIT 1 RETURNING id`,
            [u.id, line1],
          )
        ).rows[0];
      }
      return { userId: u.id, addressId: a!.id };
    };

    const people = {
      user: await ensureCustomer(DEMO_USER_EMAIL, 'Demo User', '12 Jalan Demo'),
      siti: await ensureCustomer(OTHER_CUSTOMERS[0]!.email, OTHER_CUSTOMERS[0]!.name, '8 Jalan Melati'),
      raj: await ensureCustomer(OTHER_CUSTOMERS[1]!.email, OTHER_CUSTOMERS[1]!.name, '31 Lorong Mawar'),
    };

    const already = await tx.query('SELECT 1 FROM bookings WHERE customer_id = $1 LIMIT 1', [people.user.userId]);
    if ((already.rowCount ?? 0) > 0) return null;

    const services = (
      await tx.query<{ id: string; slug: string; name_en: string; name_ms: string | null; model: string; base: number; min_units: number; fixed: number; per: number }>(
        'SELECT id, slug, name_en, name_ms, pricing_model AS model, base_price_cents AS base, min_units, fixed_minutes AS fixed, minutes_per_unit AS per FROM services',
      )
    ).rows;
    const defaults = (await tx.query<{ service_id: string; price_cents: number; per_unit: boolean }>('SELECT service_id, price_cents, per_unit FROM service_options WHERE is_default AND active')).rows;
    const vendorUserId = (await tx.query<{ user_id: string }>('SELECT user_id FROM providers WHERE id = $1', [vendor.providerId])).rows[0]!.user_id;

    let made = 0;
    const ratings: number[] = [];
    for (const p of PLANS) {
      const s = services.find((x) => x.slug === p.slug);
      if (!s) continue;
      const units = p.units ?? Math.max(1, s.min_units);
      const per = s.model === 'per_size' ? 0 : s.base;
      let subtotal = per * units;
      for (const o of defaults.filter((d) => d.service_id === s.id)) subtotal += o.per_unit ? o.price_cents * units : o.price_cents;
      const duration = Math.max(30, s.fixed + s.per * units);
      const scheduled = at(now, p.day, p.hour);
      const created = new Date(Math.min(now.getTime() - 3_600_000, scheduled.getTime() - 2 * DAY));
      const cust = people[p.who];
      const commission = Math.round(subtotal * 0.2);
      const lineItem = { optionId: null, labelEn: s.name_en, labelMs: s.name_ms ?? s.name_en, qty: units, unitPriceCents: units ? Math.round(subtotal / units) : subtotal, amountCents: subtotal };
      const breakdown = { units, lineItems: [lineItem], subtotalCents: subtotal, sstCents: 0, totalCents: subtotal, commissionRate: 0.2, commissionCents: commission, providerEarningsCents: subtotal - commission };

      const b = await tx.query<{ id: string }>(
        `INSERT INTO bookings (customer_id, service_id, address_id, status, scheduled_at, units, duration_minutes, subtotal_cents, sst_cents, total_cents,
                               commission_rate, price_breakdown, cancelled_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$8,0.2,$9::jsonb,$10,$11,$11) RETURNING id`,
        [cust.userId, s.id, cust.addressId, p.status, scheduled, units, duration, subtotal, JSON.stringify(breakdown), p.status === 'cancelled' ? p.note ?? 'customer_cancelled' : null, created],
      );
      const id = b.rows[0]!.id;
      await tx.query('INSERT INTO booking_items (booking_id, label, qty, price_cents) VALUES ($1,$2,$3,$4)', [id, s.name_en, units, subtotal]);

      const cancelled = p.status === 'cancelled';
      await tx.query(
        `INSERT INTO payments (booking_id, gateway, gateway_ref, method, amount_cents, status, refunded_cents, created_at, updated_at)
         VALUES ($1,'fake',$2,$3,$4,$5,$6,$7,$7)`,
        [id, `fake_demo_${id}`, made % 3 === 0 ? 'ewallet' : 'fpx', subtotal, cancelled ? 'refunded' : p.status === 'paid_out' ? 'released' : 'held', cancelled ? subtotal : 0, created],
      );

      if (p.status === 'offered') {
        await tx.query(
          "INSERT INTO job_offers (booking_id, provider_id, status, offered_at, expires_at) VALUES ($1,$2,'offered',$3,$4)",
          [id, vendor.providerId, new Date(now.getTime() - 20 * 60_000), new Date(now.getTime() + 3 * DAY)],
        );
      } else if (!cancelled) {
        await tx.query("INSERT INTO job_offers (booking_id, provider_id, status, offered_at, expires_at, responded_at) VALUES ($1,$2,'accepted',$3,$4,$5)", [id, vendor.providerId, created, new Date(created.getTime() + DAY), new Date(created.getTime() + 600_000)]);
        const started = ['in_progress', 'completed', 'paid_out', 'disputed'].includes(p.status);
        const finished = ['completed', 'paid_out', 'disputed'].includes(p.status);
        await tx.query(
          'INSERT INTO booking_assignments (booking_id, provider_id, accepted_at, checked_in_at, checked_out_at) VALUES ($1,$2,$3,$4,$5)',
          [id, vendor.providerId, new Date(created.getTime() + 600_000), started ? new Date(scheduled.getTime() + 2 * 60_000) : null, finished ? new Date(scheduled.getTime() + duration * 60_000) : null],
        );
        if (finished) {
          const done = new Date(scheduled.getTime() + duration * 60_000);
          const paid = p.status === 'paid_out';
          await tx.query(
            `INSERT INTO payouts (provider_id, booking_id, gross_cents, commission_cents, net_cents, status, paid_at, paid_reference, available_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
            [vendor.providerId, id, subtotal, commission, subtotal - commission, paid ? 'paid' : 'pending', paid ? new Date(done.getTime() + 3 * DAY) : null, paid ? `DEMO${id.slice(0, 6).toUpperCase()}` : null, new Date(done.getTime() + 2 * DAY), done],
          );
        }
      }

      if (p.review) {
        await tx.query('INSERT INTO reviews (booking_id, provider_id, customer_id, rating, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, vendor.providerId, cust.userId, p.review[0], p.review[1], new Date(scheduled.getTime() + 4 * 3_600_000)]);
        ratings.push(p.review[0]);
      }
      if (p.status === 'disputed') {
        await tx.query('INSERT INTO disputes (booking_id, opened_by, reason, created_at) VALUES ($1,$2,$3,$4)', [id, cust.userId, p.note, new Date(scheduled.getTime() + 6 * 3_600_000)]);
      }
      let m = 0;
      for (const [from, body] of p.chat ?? []) {
        await tx.query('INSERT INTO messages (booking_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4)', [id, from === 'c' ? cust.userId : vendorUserId, body, new Date(now.getTime() - (10 - m++) * 60_000)]);
      }
      made++;
    }

    const avg = ratings.length ? ratings.reduce((a, r) => a + r, 0) / ratings.length : 0;
    const finishedJobs = PLANS.filter((p) => ['completed', 'paid_out', 'disputed'].includes(p.status)).length;
    const offered = PLANS.filter((p) => p.status !== 'cancelled').length;
    await tx.query(
      'UPDATE providers SET rating_avg = $2, rating_count = $3, jobs_completed = $4, offers_received = $5, offers_accepted = $6 WHERE id = $1',
      [vendor.providerId, avg.toFixed(2), ratings.length, finishedJobs, offered, offered - PLANS.filter((p) => p.status === 'offered').length],
    );
    return { bookings: made };
  });
}
