import { createDevProvider } from './dev-provider.js';
import type { Db } from './index.js';

/**
 * DEVELOPMENT ONLY. Dummy data so the admin dashboards have something to show: demo customers and providers, and several
 * months of past bookings (paid, finished, some cancelled) spread over every service with different popularity and trends.
 * Everything demo-made uses an `@example.com` address starting with `demo.`, so it can be found again and removed.
 */

const DEMO_CUSTOMER = 'demo.customer%@example.com';
const DAY = 86_400_000;

/** Small seeded random numbers so the same run gives the same picture every time. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How popular each service is (relative weight) and how much that grows over the period (0.5 = 50% more at the end than the start). */
const POPULARITY: Record<string, { weight: number; growth: number }> = {
  'home-cleaning': { weight: 30, growth: 0.3 },
  'aircon-service': { weight: 20, growth: 0.1 },
  'ironing-laundry': { weight: 14, growth: -0.2 },
  'deep-cleaning': { weight: 9, growth: 0.2 },
  'fridge-oven-cleaning': { weight: 5, growth: 0.4 },
  'carpet-curtain-cleaning': { weight: 4, growth: 0.3 },
  'linen-curtain-change': { weight: 4, growth: 0.1 },
  'grille-exhaust-cleaning': { weight: 3, growth: 0.2 },
  'move-in-out-cleaning': { weight: 3, growth: 0.8 },
  'post-renovation-cleaning': { weight: 2, growth: 0.5 },
  'gardening-plant-care': { weight: 2, growth: 0.3 },
  'grass-cutting': { weight: 2, growth: 0 },
  'glass-cleaning': { weight: 2, growth: 0.2 },
  'pet-care': { weight: 2, growth: 2.0 },
  'home-helper': { weight: 1, growth: 1.5 },
};

export async function activateAllServices(db: Db): Promise<number> {
  const r = await db.query('UPDATE services SET active = true WHERE NOT active');
  return r.rowCount ?? 0;
}

export async function clearDemoData(db: Db): Promise<number> {
  return db.tx(async (tx) => {
    const ids = `SELECT b.id FROM bookings b JOIN users u ON u.id = b.customer_id WHERE u.email LIKE '${DEMO_CUSTOMER}'`;
    await tx.query(`DELETE FROM payouts WHERE booking_id IN (${ids})`);
    await tx.query(`DELETE FROM payments WHERE booking_id IN (${ids})`);
    const r = await tx.query(`DELETE FROM bookings WHERE id IN (${ids})`); // items and assignments go with them
    await tx.query(`DELETE FROM users WHERE email LIKE '${DEMO_CUSTOMER}'`); // their addresses go too
    return r.rowCount ?? 0;
  });
}

/** Adds about six months of bookings up to `now`. Run it again and the old demo data is replaced, not doubled. */
export async function loadDemoData(db: Db, opts: { now?: Date; weeks?: number; customers?: number; providers?: number } = {}) {
  const now = opts.now ?? new Date();
  const weeks = opts.weeks ?? 26;
  const nCustomers = opts.customers ?? 40;
  const nProviders = opts.providers ?? 3;
  await clearDemoData(db);
  const rand = rng(20261021);

  const providers: string[] = [];
  for (let i = 1; i <= nProviders; i++) {
    const p = await createDevProvider(db, { email: `demo.provider${i}@example.com`, name: ['Aisha Rahman', 'Lim Wei Jie', 'Nurul Huda'][i - 1] ?? `Demo Provider ${i}` });
    providers.push(p.providerId);
  }

  const areas = (await db.query<{ id: string }>('SELECT id FROM areas ORDER BY name')).rows.map((r) => r.id);
  const customers: Array<{ id: string; addressId: string }> = [];
  for (let i = 1; i <= nCustomers; i++) {
    const u = await db.query<{ id: string }>(
      "INSERT INTO users (email, role, full_name, consent_at) VALUES ($1, 'customer', $2, now()) RETURNING id",
      [`demo.customer${i}@example.com`, `Demo Customer ${i}`],
    );
    const a = await db.query<{ id: string }>(
      'INSERT INTO addresses (user_id, label, line1, postcode, area_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [u.rows[0]!.id, 'Home', `${i} Jalan Demo`, '47300', areas[Math.floor(rand() * areas.length)]!],
    );
    customers.push({ id: u.rows[0]!.id, addressId: a.rows[0]!.id });
  }

  const services = (
    await db.query<{ id: string; slug: string; name: string; model: string; base: number; min_units: number }>(
      'SELECT id, slug, name_en AS name, pricing_model AS model, base_price_cents AS base, min_units FROM services',
    )
  ).rows;
  const defaults = (await db.query<{ service_id: string; price_cents: number; per_unit: boolean }>('SELECT service_id, price_cents, per_unit FROM service_options WHERE is_default AND active')).rows;

  const priceOf = (s: (typeof services)[number], units: number) => {
    if (s.model === 'quote') return 12000 + Math.floor(rand() * 18000);
    let total = s.model === 'per_size' ? 0 : s.base * units;
    for (const o of defaults.filter((d) => d.service_id === s.id)) total += o.per_unit ? o.price_cents * units : o.price_cents;
    return total;
  };
  const unitsFor = (s: (typeof services)[number]) => (s.model === 'per_size' || s.model === 'quote' ? 1 : s.model === 'hourly' ? Math.max(s.min_units, 2 + Math.floor(rand() * 4)) : 1 + Math.floor(rand() * 3));

  const weighted = (progress: number) => {
    const entries = services.map((s) => {
      const p = POPULARITY[s.slug] ?? { weight: 1, growth: 0 };
      return { s, w: Math.max(0.05, p.weight * (1 + p.growth * progress)) };
    });
    const sum = entries.reduce((a, e) => a + e.w, 0);
    let x = rand() * sum;
    for (const e of entries) if ((x -= e.w) <= 0) return e.s;
    return entries[entries.length - 1]!.s;
  };

  let made = 0;
  const totalDays = weeks * 7;
  for (let d = totalDays; d >= 0; d--) {
    const progress = 1 - d / totalDays; // 0 at the start, 1 today
    const perDay = (2.5 + 4 * progress) * (0.7 + 0.6 * rand()); // about 18 a week at the start, 45 a week now
    const n = Math.floor(perDay) + (rand() < perDay % 1 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const s = weighted(progress);
      const cust = customers[Math.floor(rand() * customers.length)]!;
      const created = new Date(now.getTime() - d * DAY - Math.floor(rand() * 10 * 3_600_000));
      const scheduled = new Date(created.getTime() + (1 + Math.floor(rand() * 9)) * DAY);
      scheduled.setUTCHours(1 + Math.floor(rand() * 9), 0, 0, 0); // 09:00 to 17:00 Malaysia time
      const units = unitsFor(s);
      const subtotal = priceOf(s, units);
      const age = (now.getTime() - scheduled.getTime()) / DAY;
      const cancelled = age > 3 ? rand() < 0.08 : rand() < 0.04;
      const status = cancelled ? 'cancelled' : age > 3 ? 'paid_out' : age > 0 ? 'completed' : 'confirmed';
      const commission = Math.round(subtotal * 0.2);
      const providerId = providers[Math.floor(rand() * providers.length)]!;
      const method = rand() < 0.7 ? 'fpx' : 'ewallet';

      const b = await db.query<{ id: string }>(
        `INSERT INTO bookings (customer_id, service_id, address_id, status, scheduled_at, units, subtotal_cents, sst_cents, total_cents,
                               commission_rate, cancelled_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,0.2,$8,$9,$9) RETURNING id`,
        [cust.id, s.id, cust.addressId, status, scheduled, units, subtotal, cancelled ? 'customer_cancelled' : null, created],
      );
      const id = b.rows[0]!.id;
      await db.query('INSERT INTO booking_items (booking_id, label, qty, price_cents) VALUES ($1,$2,$3,$4)', [id, s.name, units, subtotal]);
      await db.query(
        `INSERT INTO payments (booking_id, gateway, gateway_ref, method, amount_cents, status, refunded_cents, created_at, updated_at)
         VALUES ($1,'demo',$2,$3,$4,$5,$6,$7,$7)`,
        [id, `demo_${id}`, method, subtotal, cancelled ? 'refunded' : status === 'paid_out' ? 'released' : 'held', cancelled ? subtotal : 0, created],
      );
      if (!cancelled) {
        await db.query('INSERT INTO booking_assignments (booking_id, provider_id, accepted_at) VALUES ($1,$2,$3)', [id, providerId, created]);
        if (status === 'completed' || status === 'paid_out') {
          await db.query(
            `INSERT INTO payouts (provider_id, booking_id, gross_cents, commission_cents, net_cents, status, paid_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [providerId, id, subtotal, commission, subtotal - commission, status === 'paid_out' ? 'paid' : 'pending', status === 'paid_out' ? scheduled : null, scheduled],
          );
        }
      }
      made++;
    }
  }
  return { bookings: made, customers: nCustomers, providers: nProviders };
}
