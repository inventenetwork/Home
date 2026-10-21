import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  durationMinutes,
  eligibleProviderIds,
  expireStalePending,
  formatLocalTime,
  isValidDateString,
  loadDayContext,
  localDateString,
  localDayStart,
  slotStartMinutes,
  slotStatus,
} from '../bookings/availability.js';
import { loadBookingSettings } from '../bookings/settings.js';
import { calculatePrice, MAX_UNITS, PricingError } from '../pricing/calculate.js';
import {
  findServiceBySlug,
  langSchema,
  listOptions,
  listServices,
  loadSettings,
  publicOptionGroups,
  publicService,
} from './repo.js';

const estimateBody = z.object({
  units: z.number().optional(),
  options: z
    .array(z.object({ group: z.string().max(40), code: z.string().max(40) }))
    .max(20)
    .default([]),
});

/** Public, read-only catalogue, instant price estimate and bookable time slots. No login needed. */
export function catalogRouter(db: Db, now: () => Date): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const lang = langSchema.parse(req.query.lang);
      const services = await listServices(db);
      res.json({ services: services.map((s) => publicService(s, lang)) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:slug', async (req, res, next) => {
    try {
      const lang = langSchema.parse(req.query.lang);
      const service = await findServiceBySlug(db, req.params.slug!);
      if (!service) return res.status(404).json({ error: 'not_found' });
      const options = await listOptions(db, service.id);
      res.json({ ...publicService(service, lang), optionGroups: publicOptionGroups(options, lang) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /services/:slug/slots?date=2026-10-23&area=petaling-jaya&units=3
   * Every start time on the grid for that day, flagged available or not.
   */
  router.get('/:slug/slots', async (req, res, next) => {
    try {
      const query = z
        .object({
          date: z.string(),
          area: z.string().max(60),
          units: z.coerce.number().optional(),
        })
        .safeParse(req.query);
      if (!query.success) return res.status(400).json({ error: 'invalid_request', message: 'date and area are required' });
      const { date, area: areaSlug } = query.data;
      if (!isValidDateString(date)) return res.status(400).json({ error: 'invalid_date', message: 'Use YYYY-MM-DD.' });

      const service = await findServiceBySlug(db, req.params.slug!);
      if (!service) return res.status(404).json({ error: 'not_found' });
      if (service.pricing_model === 'quote') return res.status(400).json({ error: 'quote_required' });

      const units = service.pricing_model === 'per_size' ? 1 : (query.data.units ?? service.min_units);
      if (!Number.isInteger(units) || units < Math.max(1, service.min_units) || units > MAX_UNITS) {
        return res.status(400).json({ error: 'invalid_units', message: `Quantity must be ${service.min_units} to ${MAX_UNITS}.` });
      }

      const area = (await db.query<{ id: string; slug: string }>('SELECT id, slug FROM areas WHERE slug = $1 AND active', [areaSlug])).rows[0];
      if (!area) return res.status(400).json({ error: 'area_not_served' });

      const settings = await loadBookingSettings(db);
      const t = now();
      const today = localDateString(t);
      const lastDay = localDateString(new Date(t.getTime() + settings.maxAdvanceDays * 24 * 3600_000));
      if (date < today || date > lastDay) {
        return res.status(400).json({ error: 'date_out_of_range', message: `Choose a date from ${today} to ${lastDay}.` });
      }

      await expireStalePending(db, t, settings);
      const duration = durationMinutes(service, units);
      const providerIds = await eligibleProviderIds(db, service.id, area.id);
      const ctx = await loadDayContext(db, providerIds, area.id, date);
      const earliest = t.getTime() + settings.minLeadHours * 3600_000;

      const slots = slotStartMinutes(settings, duration).map((startMin) => {
        const start = new Date(localDayStart(date).getTime() + startMin * 60_000);
        const tooSoon = start.getTime() < earliest;
        const available = !tooSoon && slotStatus(ctx, startMin, duration, settings).available;
        return {
          start: start.toISOString(),
          time: formatLocalTime(start),
          available,
          ...(available ? {} : { reason: tooSoon ? 'too_soon' : 'fully_booked' }),
        };
      });
      res.json({ date, area: area.slug, durationMinutes: duration, units, slots });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:slug/estimate', async (req, res, next) => {
    try {
      const lang = langSchema.parse(req.query.lang);
      const body = estimateBody.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });

      const service = await findServiceBySlug(db, req.params.slug!);
      if (!service) return res.status(404).json({ error: 'not_found' });
      const [options, settings] = await Promise.all([listOptions(db, service.id), loadSettings(db)]);

      let result;
      try {
        result = calculatePrice(service, options, body.data, settings);
      } catch (err) {
        if (err instanceof PricingError) return res.status(400).json({ error: err.code, message: err.message });
        throw err;
      }

      if (result.quoteOnly) return res.json({ serviceSlug: service.slug, quoteOnly: true });

      // Customer-facing view: no commission or provider earnings.
      res.json({
        serviceSlug: service.slug,
        quoteOnly: false,
        currency: 'MYR',
        units: result.units,
        lineItems: result.lineItems.map((li) => ({
          label: lang === 'ms' ? li.labelMs : li.labelEn,
          qty: li.qty,
          unitPriceCents: li.unitPriceCents,
          amountCents: li.amountCents,
        })),
        subtotalCents: result.subtotalCents,
        sstCents: result.sstCents,
        totalCents: result.totalCents,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
