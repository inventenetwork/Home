/**
 * Price calculator. Pure functions only: no database, no clock, no randomness.
 * All money is integer sen (RM 1.00 = 100). Prices are ALWAYS computed on the server from the catalogue,
 * never trusted from the client.
 */

export type PricingModel = 'hourly' | 'per_unit' | 'per_size' | 'quote';
export type OptionKind = 'choice' | 'addon' | 'size';

export interface ServiceInput {
  name_en: string;
  name_ms: string;
  pricing_model: PricingModel;
  base_price_cents: number;
  min_units: number;
  unit_label: string | null;
}

export interface OptionInput {
  id: string;
  kind: OptionKind;
  group_key: string;
  code: string;
  label_en: string;
  label_ms: string;
  price_cents: number;
  per_unit: boolean;
  is_default: boolean;
}

export interface Settings {
  commissionRate: number; // 0.20 = 20%
  sstEnabled: boolean;
  sstRate: number; // 0.08 = 8%
}

export interface Selection {
  /** Hours / aircon units / baskets. Omit to use the service minimum. Ignored (must be 1) for per_size services. */
  units?: number;
  /** At most one option per group, e.g. { group: 'aircon_type', code: 'chemical_wash' }. */
  options?: Array<{ group: string; code: string }>;
}

export interface LineItem {
  optionId: string | null; // null for the base line
  code: string | null;
  labelEn: string;
  labelMs: string;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
}

export type PriceResult =
  | { quoteOnly: true }
  | {
      quoteOnly: false;
      units: number;
      lineItems: LineItem[];
      subtotalCents: number;
      sstCents: number;
      totalCents: number;
      /** Internal: never show to customers as a fee. */
      commissionRate: number;
      commissionCents: number;
      providerEarningsCents: number;
    };

export type PricingErrorCode =
  | 'invalid_units'
  | 'units_below_minimum'
  | 'unknown_option'
  | 'duplicate_group'
  | 'missing_option'
  | 'misconfigured_service';

export class PricingError extends Error {
  constructor(
    public readonly code: PricingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

export const MAX_UNITS = 50;

export function calculatePrice(
  service: ServiceInput,
  options: OptionInput[],
  selection: Selection,
  settings: Settings,
): PriceResult {
  if (service.pricing_model === 'quote') return { quoteOnly: true };

  const isSize = service.pricing_model === 'per_size';

  // ── units ──
  let units: number;
  if (isSize) {
    if (selection.units !== undefined && selection.units !== 1) {
      throw new PricingError('invalid_units', 'This service is priced by property size, not by quantity.');
    }
    units = 1;
  } else {
    units = selection.units ?? service.min_units;
    if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) {
      throw new PricingError('invalid_units', `Quantity must be a whole number from 1 to ${MAX_UNITS}.`);
    }
    if (units < service.min_units) {
      throw new PricingError(
        'units_below_minimum',
        `Minimum is ${service.min_units} ${service.unit_label ?? 'unit'}${service.min_units === 1 ? '' : 's'}.`,
      );
    }
  }

  // ── group the catalogue options ──
  const byGroup = new Map<string, OptionInput[]>();
  for (const o of options) {
    const list = byGroup.get(o.group_key) ?? [];
    list.push(o);
    byGroup.set(o.group_key, list);
  }
  const hasSizeOptions = options.some((o) => o.kind === 'size');
  if (isSize !== hasSizeOptions) {
    throw new PricingError(
      'misconfigured_service',
      isSize ? 'Size-priced service has no size options.' : 'Only size-priced services may have size options.',
    );
  }

  // ── resolve what the customer picked (max one per group) ──
  const chosen = new Map<string, OptionInput>();
  for (const sel of selection.options ?? []) {
    if (chosen.has(sel.group)) {
      throw new PricingError('duplicate_group', `Choose only one option for "${sel.group}".`);
    }
    const opt = byGroup.get(sel.group)?.find((o) => o.code === sel.code);
    if (!opt) throw new PricingError('unknown_option', `Unknown option "${sel.group}:${sel.code}".`);
    chosen.set(sel.group, opt);
  }

  // ── build line items ──
  const lineItems: LineItem[] = [];
  if (!isSize && service.base_price_cents > 0) {
    lineItems.push({
      optionId: null,
      code: null,
      labelEn: service.name_en,
      labelMs: service.name_ms,
      qty: units,
      unitPriceCents: service.base_price_cents,
      amountCents: service.base_price_cents * units,
    });
  }

  for (const group of [...byGroup.keys()].sort()) {
    const groupOptions = byGroup.get(group)!;
    const opt = chosen.get(group) ?? groupOptions.find((o) => o.is_default);
    if (!opt) {
      const required = groupOptions.some((o) => o.kind !== 'addon');
      if (required) throw new PricingError('missing_option', `Please choose an option for "${group}".`);
      continue; // optional add-on group, nothing picked
    }
    const qty = opt.kind !== 'size' && opt.per_unit ? units : 1;
    const amount = opt.price_cents * qty;
    if (amount > 0) {
      lineItems.push({
        optionId: opt.id,
        code: opt.code,
        labelEn: opt.label_en,
        labelMs: opt.label_ms,
        qty,
        unitPriceCents: opt.price_cents,
        amountCents: amount,
      });
    }
  }

  const subtotalCents = lineItems.reduce((sum, li) => sum + li.amountCents, 0);
  if (subtotalCents <= 0) {
    throw new PricingError('misconfigured_service', 'This service has no price configured yet.');
  }

  // ── tax and commission (rounded to the nearest sen) ──
  const sstCents = settings.sstEnabled ? Math.round(subtotalCents * settings.sstRate) : 0;
  const commissionCents = Math.round(subtotalCents * settings.commissionRate);

  return {
    quoteOnly: false,
    units,
    lineItems,
    subtotalCents,
    sstCents,
    totalCents: subtotalCents + sstCents,
    commissionRate: settings.commissionRate,
    commissionCents,
    providerEarningsCents: subtotalCents - commissionCents,
  };
}
