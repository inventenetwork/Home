import { Router } from 'express';
import type { Db } from '../db/index.js';

const MYT = 8 * 3_600_000;
const PERIODS = {
  week: { defaultCount: 12, maxCount: 52, unit: 'week' },
  month: { defaultCount: 12, maxCount: 36, unit: 'month' },
  quarter: { defaultCount: 4, maxCount: 12, unit: 'quarter' },
} as const;
type Period = keyof typeof PERIODS;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Start (Malaysia date) of the week (Monday), month or quarter that contains `d`. */
function bucketStart(period: Period, d: Date): Date {
  const m = new Date(d.getTime() + MYT); // shift so UTC getters read Malaysia time
  const y = m.getUTCFullYear();
  const mo = m.getUTCMonth();
  if (period === 'month') return new Date(Date.UTC(y, mo, 1));
  if (period === 'quarter') return new Date(Date.UTC(y, mo - (mo % 3), 1));
  const day = (m.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(y, mo, m.getUTCDate() - day));
}
function stepBack(period: Period, start: Date, n: number): Date {
  if (period === 'week') return new Date(start.getTime() - n * 7 * 86_400_000);
  const months = period === 'month' ? n : n * 3;
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - months, 1));
}

/**
 * Which services are ordered most, week by week, month by month or quarter by quarter. An "order" is a booking that was paid for
 * (even if cancelled and refunded afterwards, which is counted separately); unpaid bookings that lapsed are not orders. Weeks, months
 * and quarters follow Malaysia time and the day the order was placed.
 */
export function adminAnalyticsRouter(db: Db, now: () => Date): Router {
  const router = Router();

  router.get('/analytics/services', async (req, res, next) => {
    try {
      const period = (typeof req.query.period === 'string' ? req.query.period : 'week') as Period;
      if (!(period in PERIODS)) return res.status(400).json({ error: 'invalid_request', message: 'period must be week, month or quarter.' });
      const cfg = PERIODS[period];
      const asked = req.query.count === undefined ? cfg.defaultCount : Math.floor(Number(req.query.count));
      if (!Number.isFinite(asked) || asked < 1 || asked > cfg.maxCount) return res.status(400).json({ error: 'invalid_request', message: `count must be 1 to ${cfg.maxCount}.` });

      const current = bucketStart(period, now());
      const starts: Date[] = [];
      for (let i = asked - 1; i >= 0; i--) starts.push(stepBack(period, current, i));
      const first = ymd(starts[0]!);
      const index = new Map(starts.map((s, i) => [ymd(s), i]));

      const rows = (
        await db.query<{ slug: string; b: string; orders: string; cancelled: string; value: string }>(
          `SELECT s.slug, to_char(date_trunc('${cfg.unit}', b.created_at AT TIME ZONE 'Asia/Kuala_Lumpur'), 'YYYY-MM-DD') AS b,
                  count(*)::text AS orders,
                  count(*) FILTER (WHERE b.status = 'cancelled')::text AS cancelled,
                  coalesce(sum(b.total_cents) FILTER (WHERE b.status <> 'cancelled'), 0)::text AS value
             FROM bookings b JOIN services s ON s.id = b.service_id
            WHERE (b.created_at AT TIME ZONE 'Asia/Kuala_Lumpur') >= $1::date
              AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('held','released','refunded'))
            GROUP BY s.slug, 2`,
          [first],
        )
      ).rows;
      const services = (await db.query<{ slug: string; name: string; active: boolean }>('SELECT slug, name_en AS name, active FROM services ORDER BY sort_order')).rows;

      const empty = () => starts.map(() => 0);
      const out = services.map((s) => ({ slug: s.slug, name: s.name, active: s.active, orders: empty(), cancelled: empty(), valueCents: empty() }));
      const bySlug = new Map(out.map((s) => [s.slug, s]));
      for (const r of rows) {
        const i = index.get(r.b);
        const s = bySlug.get(r.slug);
        if (i === undefined || !s) continue;
        s.orders[i] = Number(r.orders);
        s.cancelled[i] = Number(r.cancelled);
        s.valueCents[i] = Number(r.value);
      }
      const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
      const totalOrders = sum(out.map((s) => sum(s.orders)));
      const result = out
        .map((s) => {
          const orders = sum(s.orders);
          const last = s.orders[s.orders.length - 1] ?? 0;
          const before = s.orders[s.orders.length - 2];
          return {
            slug: s.slug, name: s.name, active: s.active,
            orders, cancelled: sum(s.cancelled), valueCents: sum(s.valueCents),
            share: totalOrders ? Number((orders / totalOrders).toFixed(4)) : 0,
            series: s.orders, valueSeries: s.valueCents,
            // change from the previous bucket to the latest one; null when there was nothing before to compare with
            change: before === undefined || before === 0 ? null : Number(((last - before) / before).toFixed(3)),
          };
        })
        .sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
      const perBucket = starts.map((_, i) => sum(out.map((s) => s.orders[i]!)));
      const topPerBucket = starts.map((_, i) => {
        const best = [...out].sort((a, b) => b.orders[i]! - a.orders[i]!)[0];
        return best && best.orders[i]! > 0 ? { slug: best.slug, name: best.name, orders: best.orders[i]! } : null;
      });

      res.json({
        period,
        // The newest bucket may still be in progress.
        buckets: starts.map((s, i) => ({ start: ymd(s), current: i === starts.length - 1 })),
        totals: { orders: totalOrders, cancelled: sum(out.map((s) => sum(s.cancelled))), valueCents: sum(out.map((s) => sum(s.valueCents))), perBucket },
        topPerBucket,
        top: result[0] && result[0].orders > 0 ? { slug: result[0].slug, name: result[0].name, orders: result[0].orders, share: result[0].share } : null,
        services: result,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
