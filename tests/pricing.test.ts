import { describe, expect, it } from 'vitest';
import { SERVICES } from '../src/db/seed.js';
import {
  calculatePrice,
  PricingError,
  type OptionInput,
  type PriceResult,
  type ServiceInput,
  type Settings,
} from '../src/pricing/calculate.js';

const NO_TAX: Settings = { commissionRate: 0.2, sstEnabled: false, sstRate: 0.08 };

/** Build calculator inputs from the real seed data, so these tests also guard the seed prices. */
function fromSeed(slug: string): { service: ServiceInput; options: OptionInput[] } {
  const s = SERVICES.find((x) => x.slug === slug)!;
  return {
    service: {
      name_en: s.en,
      name_ms: s.ms,
      pricing_model: s.model,
      base_price_cents: s.baseSen,
      min_units: s.minUnits,
      unit_label: s.unit,
    },
    options: s.options.map((o, i) => ({
      id: `${slug}-${i}`,
      kind: o.kind,
      group_key: o.group,
      code: o.code,
      label_en: o.en,
      label_ms: o.ms,
      price_cents: o.sen,
      per_unit: o.perUnit ?? false,
      is_default: o.isDefault ?? false,
    })),
  };
}

function price(slug: string, selection: Parameters<typeof calculatePrice>[2], settings = NO_TAX) {
  const { service, options } = fromSeed(slug);
  const r = calculatePrice(service, options, selection, settings);
  if (r.quoteOnly) throw new Error('unexpected quote');
  return r as Extract<PriceResult, { quoteOnly: false }>;
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof PricingError) return e.code;
    throw e;
  }
  return undefined;
}

describe('hourly: home cleaning', () => {
  it('charges per hour', () => {
    expect(price('home-cleaning', { units: 3 }).subtotalCents).toBe(9000);
  });
  it('defaults to the 2-hour minimum', () => {
    expect(price('home-cleaning', {}).subtotalCents).toBe(6000);
  });
  it('adds the RM50 equipment fee once, not per hour', () => {
    const r = price('home-cleaning', { units: 3, options: [{ group: 'tools', code: 'bring_tools' }] });
    expect(r.subtotalCents).toBe(14000);
  });
  it('rejects fewer hours than the minimum', () => {
    expect(errorCode(() => price('home-cleaning', { units: 1 }))).toBe('units_below_minimum');
  });
});

describe('per unit: aircon', () => {
  it('prices a general service per unit by default', () => {
    expect(price('aircon-service', { units: 1 }).subtotalCents).toBe(8000);
  });
  it('multiplies chemical wash and gas top-up by the number of units', () => {
    const r = price('aircon-service', {
      units: 2,
      options: [
        { group: 'aircon_type', code: 'chemical_wash' },
        { group: 'gas', code: 'gas_topup' },
      ],
    });
    expect(r.subtotalCents).toBe((15000 + 6000) * 2);
    expect(r.lineItems).toHaveLength(2);
  });
});

describe('per unit: ironing', () => {
  it('combines base price, flat pickup fee and per-basket washing', () => {
    const r = price('ironing-laundry', {
      units: 3,
      options: [
        { group: 'logistics', code: 'pickup_delivery' },
        { group: 'laundry', code: 'wash_dry' },
      ],
    });
    expect(r.subtotalCents).toBe(4000 * 3 + 1000 + 2500 * 3);
  });
});

describe('per size: deep cleaning', () => {
  it('uses the default size when none is chosen', () => {
    expect(price('deep-cleaning', {}).subtotalCents).toBe(25000);
  });
  it('replaces (not adds to) the base with the chosen size, plus add-ons', () => {
    const r = price('deep-cleaning', {
      options: [
        { group: 'property_size', code: '801_1200' },
        { group: 'tools', code: 'bring_tools' },
      ],
    });
    expect(r.subtotalCents).toBe(38000 + 5000);
  });
  it('does not accept a quantity', () => {
    expect(errorCode(() => price('deep-cleaning', { units: 3 }))).toBe('invalid_units');
  });
});

describe('quote services', () => {
  it('return quoteOnly instead of a price', () => {
    const { service, options } = fromSeed('grass-cutting');
    expect(calculatePrice(service, options, {}, NO_TAX)).toEqual({ quoteOnly: true });
  });
});

describe('validation', () => {
  it.each([0, -1, 1.5, 51, Number.NaN])('rejects invalid units %s', (units) => {
    expect(errorCode(() => price('aircon-service', { units }))).toBe('invalid_units');
  });
  it('rejects unknown options and groups', () => {
    expect(errorCode(() => price('aircon-service', { options: [{ group: 'aircon_type', code: 'nope' }] }))).toBe('unknown_option');
    expect(errorCode(() => price('aircon-service', { options: [{ group: 'nope', code: 'general' }] }))).toBe('unknown_option');
  });
  it('rejects two options from the same group', () => {
    const sel = { options: [{ group: 'aircon_type', code: 'general' }, { group: 'aircon_type', code: 'chemical_wash' }] };
    expect(errorCode(() => price('aircon-service', sel))).toBe('duplicate_group');
  });
  it('requires a choice when a required group has no default', () => {
    const service: ServiceInput = { name_en: 'X', name_ms: 'X', pricing_model: 'per_unit', base_price_cents: 1000, min_units: 1, unit_label: 'unit' };
    const options: OptionInput[] = [
      { id: 'a', kind: 'choice', group_key: 'type', code: 'a', label_en: 'A', label_ms: 'A', price_cents: 0, per_unit: false, is_default: false },
    ];
    expect(errorCode(() => calculatePrice(service, options, {}, NO_TAX))).toBe('missing_option');
  });
  it('refuses to price a service with no price configured', () => {
    const service: ServiceInput = { name_en: 'X', name_ms: 'X', pricing_model: 'hourly', base_price_cents: 0, min_units: 1, unit_label: 'hour' };
    expect(errorCode(() => calculatePrice(service, [], {}, NO_TAX))).toBe('misconfigured_service');
  });
});

describe('commission and SST', () => {
  it('splits the subtotal into commission and provider earnings', () => {
    const r = price('home-cleaning', { units: 3 });
    expect(r.commissionCents).toBe(1800);
    expect(r.providerEarningsCents).toBe(7200);
    expect(r.totalCents).toBe(9000); // commission is not an extra fee for the customer
  });
  it('adds SST on top only when enabled', () => {
    const r = price('home-cleaning', { units: 3 }, { commissionRate: 0.2, sstEnabled: true, sstRate: 0.08 });
    expect(r.sstCents).toBe(720);
    expect(r.totalCents).toBe(9720);
    expect(r.providerEarningsCents).toBe(7200); // SST does not reduce provider earnings
  });
  it('rounds to the nearest sen and always adds back to the subtotal', () => {
    const service: ServiceInput = { name_en: 'X', name_ms: 'X', pricing_model: 'hourly', base_price_cents: 1003, min_units: 1, unit_label: 'hour' };
    const r = calculatePrice(service, [], { units: 1 }, { commissionRate: 0.2, sstEnabled: true, sstRate: 0.08 });
    if (r.quoteOnly) throw new Error('unexpected');
    expect(r.commissionCents).toBe(201); // 200.6 -> 201
    expect(r.sstCents).toBe(80); // 80.24 -> 80
    expect(r.commissionCents + r.providerEarningsCents).toBe(r.subtotalCents);
  });
});
