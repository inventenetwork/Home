import type { Db } from './index.js';

/**
 * Idempotent seed: safe to run repeatedly (everything is keyed by slug/code and uses ON CONFLICT).
 * PRICES BELOW ARE PLACEHOLDERS. Change them in the admin panel (or here) before launch.
 */

type Opt = {
  kind: 'choice' | 'addon' | 'size';
  group: string;
  code: string;
  en: string;
  ms: string;
  sen: number;
  perUnit?: boolean;
  isDefault?: boolean;
};

type Svc = {
  slug: string;
  en: string;
  ms: string;
  descEn: string;
  descMs: string;
  model: 'hourly' | 'per_unit' | 'per_size' | 'quote';
  baseSen: number;
  unit: string | null;
  minUnits: number;
  fixedMin: number; // job length = fixedMin + perUnitMin * units
  perUnitMin: number;
  phase: number;
  active: boolean;
  skills: string[];
  options: Opt[];
};

export const AREAS = [
  { slug: 'kuching', name: 'Kuching', state: 'Sarawak' },
  { slug: 'sibu', name: 'Sibu', state: 'Sarawak' },
  { slug: 'petaling-jaya', name: 'Petaling Jaya', state: 'Selangor' },
  { slug: 'subang', name: 'Subang', state: 'Selangor' },
  { slug: 'kepong', name: 'Kepong', state: 'Kuala Lumpur' },
];

export const SKILLS = [
  { code: 'cleaning', name: 'Home cleaning' },
  { code: 'ironing', name: 'Ironing & laundry' },
  { code: 'aircon', name: 'Aircon servicing' },
  { code: 'lawn', name: 'Grass cutting & gardening' },
  { code: 'glass', name: 'Glass & window cleaning' },
  { code: 'pet', name: 'Pet care' },
  { code: 'care', name: 'Home helper (elderly and post-natal support)' },
];

/** The four property-size choices shared by the per-size services (prices in sen, placeholders). */
const sizeOptions = (prices: [number, number, number, number]): Opt[] => [
  { kind: 'size', group: 'property_size', code: 'up_to_800', en: 'Up to 800 sq ft', ms: 'Sehingga 800 kaki persegi', sen: prices[0], isDefault: true },
  { kind: 'size', group: 'property_size', code: '801_1200', en: '801 – 1,200 sq ft', ms: '801 – 1,200 kaki persegi', sen: prices[1] },
  { kind: 'size', group: 'property_size', code: '1201_1800', en: '1,201 – 1,800 sq ft', ms: '1,201 – 1,800 kaki persegi', sen: prices[2] },
  { kind: 'size', group: 'property_size', code: '1801_plus', en: 'Over 1,800 sq ft', ms: 'Melebihi 1,800 kaki persegi', sen: prices[3] },
  { kind: 'addon', group: 'tools', code: 'bring_tools', en: 'Cleaner brings equipment', ms: 'Pembersih bawa peralatan', sen: 5000 },
];

export const SERVICES: Svc[] = [
  {
    slug: 'home-cleaning',
    fixedMin: 0,
    perUnitMin: 60,
    en: 'Home cleaning',
    ms: 'Pembersihan rumah',
    descEn: 'Regular hourly cleaning by a vetted cleaner. Minimum 2 hours.',
    descMs: 'Pembersihan rumah mengikut jam oleh pembersih yang disahkan. Minimum 2 jam.',
    model: 'hourly',
    baseSen: 3000,
    unit: 'hour',
    minUnits: 2,
    phase: 1,
    active: true,
    skills: ['cleaning'],
    options: [
      { kind: 'addon', group: 'tools', code: 'own_tools', en: 'I will provide cleaning tools', ms: 'Saya sediakan peralatan', sen: 0, isDefault: true },
      { kind: 'addon', group: 'tools', code: 'bring_tools', en: 'Cleaner brings equipment', ms: 'Pembersih bawa peralatan', sen: 5000 },
    ],
  },
  {
    slug: 'ironing-laundry',
    fixedMin: 0,
    perUnitMin: 60,
    en: 'Ironing & laundry',
    ms: 'Seterika & dobi',
    descEn: 'Ironing and folding, priced per basket. Optional pickup and delivery.',
    descMs: 'Menyeterika dan melipat, harga mengikut bakul. Pilihan ambil dan hantar.',
    model: 'per_unit',
    baseSen: 4000,
    unit: 'basket',
    minUnits: 1,
    phase: 1,
    active: true,
    skills: ['ironing'],
    options: [
      { kind: 'addon', group: 'logistics', code: 'pickup_delivery', en: 'Pickup & delivery', ms: 'Ambil & hantar', sen: 1000 },
      { kind: 'addon', group: 'laundry', code: 'wash_dry', en: 'Add washing & drying', ms: 'Tambah basuh & kering', sen: 2500, perUnit: true },
    ],
  },
  {
    slug: 'deep-cleaning',
    fixedMin: 240,
    perUnitMin: 0,
    en: 'Deep cleaning',
    ms: 'Pembersihan menyeluruh',
    descEn: 'Top-to-bottom deep clean, priced by property size.',
    descMs: 'Pembersihan menyeluruh, harga mengikut saiz hartanah.',
    model: 'per_size',
    baseSen: 0,
    unit: null,
    minUnits: 1,
    phase: 1,
    active: true,
    skills: ['cleaning'],
    options: [
      { kind: 'size', group: 'property_size', code: 'up_to_800', en: 'Up to 800 sq ft', ms: 'Sehingga 800 kaki persegi', sen: 25000, isDefault: true },
      { kind: 'size', group: 'property_size', code: '801_1200', en: '801 – 1,200 sq ft', ms: '801 – 1,200 kaki persegi', sen: 38000 },
      { kind: 'size', group: 'property_size', code: '1201_1800', en: '1,201 – 1,800 sq ft', ms: '1,201 – 1,800 kaki persegi', sen: 55000 },
      { kind: 'size', group: 'property_size', code: '1801_plus', en: 'Over 1,800 sq ft', ms: 'Melebihi 1,800 kaki persegi', sen: 80000 },
      { kind: 'addon', group: 'tools', code: 'bring_tools', en: 'Cleaner brings equipment', ms: 'Pembersih bawa peralatan', sen: 5000 },
    ],
  },
  {
    slug: 'aircon-service',
    fixedMin: 0,
    perUnitMin: 60,
    en: 'Aircon servicing',
    ms: 'Servis penghawa dingin',
    descEn: 'Priced per aircon unit. Choose general service, chemical wash, and optional gas top-up.',
    descMs: 'Harga mengikut unit. Pilih servis biasa, cuci kimia, dan tambah gas jika perlu.',
    model: 'per_unit',
    baseSen: 0,
    unit: 'unit',
    minUnits: 1,
    phase: 1,
    active: true,
    skills: ['aircon'],
    options: [
      { kind: 'choice', group: 'aircon_type', code: 'general', en: 'General service', ms: 'Servis biasa', sen: 8000, perUnit: true, isDefault: true },
      { kind: 'choice', group: 'aircon_type', code: 'chemical_wash', en: 'Chemical wash', ms: 'Cuci kimia', sen: 15000, perUnit: true },
      { kind: 'addon', group: 'gas', code: 'gas_topup', en: 'Gas top-up', ms: 'Tambah gas', sen: 6000, perUnit: true },
    ],
  },
  // Phase 2: seeded inactive to prove no schema change is needed. Turn on from the admin panel when ready.
  {
    slug: 'grass-cutting',
    fixedMin: 120,
    perUnitMin: 0,
    en: 'Grass cutting & gardening',
    ms: 'Memotong rumput & berkebun',
    descEn: 'Lawn mowing and garden tidy-up. Quote on request.',
    descMs: 'Memotong rumput dan mengemas kebun. Sebut harga atas permintaan.',
    model: 'quote',
    baseSen: 0,
    unit: null,
    minUnits: 1,
    phase: 2,
    active: false,
    skills: ['lawn'],
    options: [],
  },
  {
    slug: 'glass-cleaning',
    fixedMin: 120,
    perUnitMin: 0,
    en: 'Glass & window cleaning',
    ms: 'Pembersihan cermin & tingkap',
    descEn: 'Interior and exterior glass cleaning. Quote on request.',
    descMs: 'Pembersihan cermin dalam dan luar. Sebut harga atas permintaan.',
    model: 'quote',
    baseSen: 0,
    unit: null,
    minUnits: 1,
    phase: 2,
    active: false,
    skills: ['glass'],
    options: [],
  },
  // More services. Seeded INACTIVE with placeholder prices: review the prices, make sure you have providers with the skill,
  // then switch them on under Admin → Services.
  {
    slug: 'post-renovation-cleaning', fixedMin: 360, perUnitMin: 0, en: 'Post-renovation cleaning', ms: 'Pembersihan selepas ubah suai',
    descEn: 'Dust, paint splatter and debris cleared after renovation work, priced by property size.',
    descMs: 'Habuk, percikan cat dan sisa selepas kerja ubah suai dibersihkan, harga mengikut saiz hartanah.',
    model: 'per_size', baseSen: 0, unit: null, minUnits: 1, phase: 2, active: false, skills: ['cleaning'],
    options: sizeOptions([35000, 52000, 75000, 110000]),
  },
  {
    slug: 'move-in-out-cleaning', fixedMin: 240, perUnitMin: 0, en: 'Move-in / move-out cleaning', ms: 'Pembersihan pindah masuk / keluar',
    descEn: 'A clean, empty unit ready for the next tenant or owner, priced by property size.',
    descMs: 'Unit kosong yang bersih untuk penyewa atau pemilik seterusnya, harga mengikut saiz hartanah.',
    model: 'per_size', baseSen: 0, unit: null, minUnits: 1, phase: 2, active: false, skills: ['cleaning'],
    options: sizeOptions([20000, 30000, 45000, 65000]),
  },
  {
    slug: 'carpet-curtain-cleaning', fixedMin: 0, perUnitMin: 30, en: 'Carpet & curtain cleaning', ms: 'Pembersihan permaidani & langsir',
    descEn: 'Deep cleaning of rugs, carpets and curtains, priced per piece.',
    descMs: 'Pembersihan menyeluruh permaidani, karpet dan langsir, harga setiap keping.',
    model: 'per_unit', baseSen: 0, unit: 'piece', minUnits: 1, phase: 2, active: false, skills: ['cleaning'],
    options: [
      { kind: 'choice', group: 'piece_type', code: 'rug', en: 'Small rug', ms: 'Permaidani kecil', sen: 6000, perUnit: true, isDefault: true },
      { kind: 'choice', group: 'piece_type', code: 'carpet', en: 'Large carpet', ms: 'Karpet besar', sen: 12000, perUnit: true },
      { kind: 'choice', group: 'piece_type', code: 'curtain', en: 'Curtain (per panel)', ms: 'Langsir (setiap panel)', sen: 4000, perUnit: true },
    ],
  },
  {
    slug: 'grille-exhaust-cleaning', fixedMin: 0, perUnitMin: 45, en: 'Window grille & kitchen exhaust cleaning', ms: 'Pembersihan gerigi tingkap & penyedut asap dapur',
    descEn: 'Degreasing of kitchen hoods and exhaust fans, and cleaning of window grilles, priced per item.',
    descMs: 'Membuang gris pada hud dapur dan kipas, serta membersihkan gerigi tingkap, harga setiap item.',
    model: 'per_unit', baseSen: 0, unit: 'item', minUnits: 1, phase: 2, active: false, skills: ['cleaning'],
    options: [
      { kind: 'choice', group: 'item_type', code: 'kitchen_hood', en: 'Kitchen hood / exhaust', ms: 'Hud / penyedut asap dapur', sen: 15000, perUnit: true, isDefault: true },
      { kind: 'choice', group: 'item_type', code: 'grille_set', en: 'Window grille (per window)', ms: 'Gerigi tingkap (setiap tingkap)', sen: 3000, perUnit: true },
    ],
  },
  {
    slug: 'linen-curtain-change', fixedMin: 0, perUnitMin: 20, en: 'Bed linen & curtain change', ms: 'Tukar cadar & langsir',
    descEn: 'We strip and remake beds, or take down and rehang curtains. Priced per room.',
    descMs: 'Kami tukar cadar dan sarung bantal, atau turunkan dan pasang semula langsir. Harga setiap bilik.',
    model: 'per_unit', baseSen: 3000, unit: 'room', minUnits: 1, phase: 2, active: false, skills: ['cleaning'],
    options: [
      { kind: 'addon', group: 'linen', code: 'wash_linen', en: 'Also wash and dry the linen', ms: 'Basuh dan keringkan cadar', sen: 2000, perUnit: true },
    ],
  },
  {
    slug: 'fridge-oven-cleaning', fixedMin: 0, perUnitMin: 40, en: 'Fridge & oven cleaning', ms: 'Pembersihan peti sejuk & ketuhar',
    descEn: 'Inside-out cleaning of a fridge or oven, priced per appliance.',
    descMs: 'Pembersihan dalam dan luar peti sejuk atau ketuhar, harga setiap perkakas.',
    model: 'per_unit', baseSen: 0, unit: 'appliance', minUnits: 1, phase: 2, active: false, skills: ['cleaning'],
    options: [
      { kind: 'choice', group: 'appliance', code: 'fridge', en: 'Fridge', ms: 'Peti sejuk', sen: 8000, perUnit: true, isDefault: true },
      { kind: 'choice', group: 'appliance', code: 'oven', en: 'Oven', ms: 'Ketuhar', sen: 7000, perUnit: true },
    ],
  },
  {
    slug: 'gardening-plant-care', fixedMin: 0, perUnitMin: 60, en: 'Gardening & plant care', ms: 'Berkebun & penjagaan tanaman',
    descEn: 'Watering, pruning, weeding and potting by the hour. Minimum 2 hours.',
    descMs: 'Menyiram, memangkas, merumput dan menanam dalam pasu mengikut jam. Minimum 2 jam.',
    model: 'hourly', baseSen: 3500, unit: 'hour', minUnits: 2, phase: 2, active: false, skills: ['lawn'],
    options: [],
  },
  {
    slug: 'pet-care', fixedMin: 0, perUnitMin: 60, en: 'Dog walking & pet sitting', ms: 'Bawa anjing berjalan & jaga haiwan peliharaan',
    descEn: 'A vetted pet carer walks or looks after your pet at home, by the hour.',
    descMs: 'Penjaga haiwan yang disahkan membawa haiwan anda berjalan atau menjaganya di rumah, mengikut jam.',
    model: 'hourly', baseSen: 2500, unit: 'hour', minUnits: 1, phase: 2, active: false, skills: ['pet'],
    options: [],
  },
  {
    slug: 'home-helper', fixedMin: 0, perUnitMin: 60, en: 'Home helper (elderly & post-natal support)', ms: 'Pembantu rumah (warga emas & selepas bersalin)',
    descEn: 'Non-medical help at home for older people or new mothers, by the hour. Minimum 4 hours.',
    descMs: 'Bantuan bukan perubatan di rumah untuk warga emas atau ibu baru bersalin, mengikut jam. Minimum 4 jam.',
    model: 'hourly', baseSen: 4500, unit: 'hour', minUnits: 4, phase: 2, active: false, skills: ['care'],
    options: [],
  },
];

export const CONFIG: Array<[string, string, string]> = [
  ['commission_rate', '0.20', 'Platform commission as a fraction of the booking subtotal'],
  ['sst_enabled', 'false', 'Charge SST on bookings. Confirm applicability with your accountant before enabling.'],
  ['sst_rate', '0.08', 'SST rate used when sst_enabled is true'],
  ['min_lead_hours', '24', 'Minimum hours between booking and the scheduled time'],
  ['offers_per_booking', '3', 'How many providers receive each job offer'],
  ['offer_timeout_minutes', '15', 'Minutes before an unanswered offer round escalates to admin'],
  ['day_start', '08:00', 'Earliest job start time (Malaysia time, HH:MM)'],
  ['day_end', '20:00', 'Jobs must finish by this time (Malaysia time, HH:MM)'],
  ['slot_interval_minutes', '60', 'Booking start times are offered on this grid'],
  ['job_buffer_minutes', '30', 'Gap a provider needs between two jobs'],
  ['max_advance_days', '60', 'How far ahead customers can book'],
  ['pending_expiry_minutes', '30', 'Unpaid bookings release their slot after this many minutes'],
  ['free_cancel_hours', '12', 'Customers can cancel a confirmed booking until this many hours before it starts'],
];

export async function seed(db: Db, opts: { adminEmail?: string } = {}): Promise<void> {
  for (const a of AREAS) {
    await db.query(
      `INSERT INTO areas (slug, name, state) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, state = EXCLUDED.state`,
      [a.slug, a.name, a.state],
    );
  }

  for (const s of SKILLS) {
    await db.query(`INSERT INTO skills (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [s.code, s.name]);
  }

  let order = 0;
  for (const s of SERVICES) {
    order += 10;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO services
         (slug, name_en, name_ms, description_en, description_ms, pricing_model, base_price_cents,
          unit_label, min_units, phase, active, sort_order, fixed_minutes, minutes_per_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (slug) DO UPDATE SET
         name_en = EXCLUDED.name_en, name_ms = EXCLUDED.name_ms,
         description_en = EXCLUDED.description_en, description_ms = EXCLUDED.description_ms,
         pricing_model = EXCLUDED.pricing_model, unit_label = EXCLUDED.unit_label,
         min_units = EXCLUDED.min_units, phase = EXCLUDED.phase, sort_order = EXCLUDED.sort_order
       RETURNING id`,
      [s.slug, s.en, s.ms, s.descEn, s.descMs, s.model, s.baseSen, s.unit, s.minUnits, s.phase, s.active, order, s.fixedMin, s.perUnitMin],
    );
    // Note: price, `active` and durations are NOT overwritten on re-seed, so admin edits survive.
    const serviceId = rows[0]!.id;

    for (const o of s.options) {
      await db.query(
        `INSERT INTO service_options
           (service_id, kind, group_key, code, label_en, label_ms, price_cents, per_unit, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (service_id, group_key, code) DO UPDATE SET
           label_en = EXCLUDED.label_en, label_ms = EXCLUDED.label_ms, kind = EXCLUDED.kind`,
        [serviceId, o.kind, o.group, o.code, o.en, o.ms, o.sen, o.perUnit ?? false, o.isDefault ?? false],
      );
    }

    for (const code of s.skills) {
      await db.query(
        `INSERT INTO service_skills (service_id, skill_id)
         SELECT $1, id FROM skills WHERE code = $2
         ON CONFLICT DO NOTHING`,
        [serviceId, code],
      );
    }
  }

  for (const [key, value, description] of CONFIG) {
    await db.query(
      `INSERT INTO app_config (key, value, description) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`,
      [key, value, description],
    );
  }

  if (opts.adminEmail) {
    const email = opts.adminEmail.trim().toLowerCase();
    await db.query(
      `INSERT INTO users (email, role, full_name, consent_at) VALUES ($1,'admin','Admin', now())
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      [email],
    );
  }
}
