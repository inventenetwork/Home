import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

describe('schema and seed', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb({});
  });
  afterAll(async () => {
    await db.close();
  });

  it('applies migrations once and is a no-op the second time', async () => {
    const first = await migrate(db);
    expect(first).toEqual(['001_init.sql', '002_booking.sql', '003_identities.sql', '004_payments.sql', '005_providers.sql', '006_customer_extras.sql', '007_privacy.sql']);
    expect(await migrate(db)).toEqual([]);
  });

  it('seeds launch areas, Phase 1 services and Phase 2 placeholders', async () => {
    await seed(db, { adminEmail: 'Admin@Example.com' });

    const areas = await db.query<{ name: string }>('SELECT name FROM areas ORDER BY name');
    expect(areas.rows.map((r) => r.name)).toEqual(['Kepong', 'Kuching', 'Petaling Jaya', 'Sibu', 'Subang']);

    const active = await db.query<{ slug: string }>('SELECT slug FROM services WHERE active ORDER BY sort_order');
    expect(active.rows.map((r) => r.slug)).toEqual(['home-cleaning', 'ironing-laundry', 'deep-cleaning', 'aircon-service']);

    const inactive = await db.query<{ slug: string }>('SELECT slug FROM services WHERE NOT active ORDER BY slug');
    expect(inactive.rows.map((r) => r.slug).sort()).toEqual(
      ['carpet-curtain-cleaning', 'fridge-oven-cleaning', 'gardening-plant-care', 'glass-cleaning', 'grass-cutting', 'grille-exhaust-cleaning', 'home-helper',
        'linen-curtain-change', 'move-in-out-cleaning', 'pet-care', 'post-renovation-cleaning'].sort(),
    );

    const models = await db.query<{ pricing_model: string }>('SELECT DISTINCT pricing_model FROM services ORDER BY 1');
    expect(models.rows.map((r) => r.pricing_model)).toEqual(['hourly', 'per_size', 'per_unit', 'quote']);

    const admin = await db.query<{ role: string }>("SELECT role FROM users WHERE email = 'admin@example.com'");
    expect(admin.rows[0]?.role).toBe('admin');
  });

  it('is idempotent and keeps admin edits to price and active flag', async () => {
    await db.query("UPDATE services SET base_price_cents = 9900, active = false WHERE slug = 'home-cleaning'");
    await seed(db);
    await seed(db);

    const svc = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM services');
    expect(svc.rows[0]!.n).toBe('6');
    const opts = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM service_options');
    expect(opts.rows[0]!.n).toBe('12');

    const cleaning = await db.query<{ base_price_cents: number; active: boolean }>(
      "SELECT base_price_cents, active FROM services WHERE slug = 'home-cleaning'",
    );
    expect(cleaning.rows[0]).toEqual({ base_price_cents: 9900, active: false });
  });

  it('seeds how long each service takes', async () => {
    const r = await db.query<{ slug: string; fixed_minutes: number; minutes_per_unit: number }>(
      "SELECT slug, fixed_minutes, minutes_per_unit FROM services WHERE slug IN ('home-cleaning','deep-cleaning') ORDER BY slug",
    );
    expect(r.rows).toEqual([
      { slug: 'deep-cleaning', fixed_minutes: 240, minutes_per_unit: 0 },
      { slug: 'home-cleaning', fixed_minutes: 0, minutes_per_unit: 60 },
    ]);
  });

  it('links services to required provider skills', async () => {
    const r = await db.query<{ slug: string; skill: string }>(
      `SELECT s.slug, k.code AS skill FROM service_skills ss
         JOIN services s ON s.id = ss.service_id JOIN skills k ON k.id = ss.skill_id
        WHERE s.slug = 'aircon-service'`,
    );
    expect(r.rows).toEqual([{ slug: 'aircon-service', skill: 'aircon' }]);
  });
});
