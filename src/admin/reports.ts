import { Router } from 'express';
import type { Db } from '../db/index.js';

const DAY = 86_400_000;
const MYT = 8 * 3_600_000;
const mytDate = (d: Date) => new Date(d.getTime() + MYT).toISOString().slice(0, 10);

/** Spreadsheet programs run text that starts with = + - @ as a formula. Prefix those cells so customer-typed text can never do that. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const rm = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));

/** Numbers for the owner: how the business is doing, plus a CSV of bookings for the accountant. */
export function adminReportsRouter(db: Db, now: () => Date): Router {
  const router = Router();

  router.get('/overview', async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Math.floor(Number(req.query.days) || 30), 1), 365);
      const t = now();
      const since = new Date(t.getTime() - days * DAY);

      const one = async (sql: string, params: unknown[] = [since]) => (await db.query<Record<string, any>>(sql, params)).rows[0]!;
      const [bookings, money, commission, owed, users, providers, disputes, ratings, attention] = await Promise.all([
        db.query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM bookings WHERE created_at >= $1 GROUP BY status', [since]),
        one(`SELECT coalesce(sum(amount_cents),0) AS paid, coalesce(sum(refunded_cents),0) AS refunded
               FROM payments WHERE status IN ('held','released','refunded') AND created_at >= $1`),
        one("SELECT coalesce(sum(commission_cents),0) AS c FROM payouts WHERE status <> 'failed' AND created_at >= $1"),
        one(`SELECT coalesce(sum(net_cents) FILTER (WHERE status = 'pending'),0) AS pending, coalesce(sum(net_cents) FILTER (WHERE status = 'requested'),0) AS requested FROM payouts`, []),
        db.query<{ role: string; n: string }>('SELECT role, count(*)::text AS n FROM users WHERE created_at >= $1 GROUP BY role', [since]),
        one(`SELECT count(*) FILTER (WHERE vetting_status = 'approved') AS approved,
                    count(*) FILTER (WHERE vetting_status = 'pending' AND submitted_at IS NOT NULL) AS waiting,
                    count(*) FILTER (WHERE vetting_status = 'suspended') AS suspended FROM providers`, []),
        one("SELECT count(*) AS open FROM disputes WHERE status = 'open'", []),
        one('SELECT coalesce(avg(rating),0) AS avg, count(*) AS n FROM reviews WHERE created_at >= $1'),
        one(`SELECT count(*) AS n FROM bookings b WHERE b.status = 'offered'
               AND NOT EXISTS (SELECT 1 FROM job_offers o WHERE o.booking_id = b.id AND o.status = 'offered' AND o.expires_at > $1)`, [t]),
      ]);
      const byStatus = Object.fromEntries(bookings.rows.map((r) => [r.status, Number(r.n)]));
      const completedJobs = (byStatus.completed ?? 0) + (byStatus.paid_out ?? 0) + (byStatus.disputed ?? 0);

      const daily = await db.query<{ d: string; n: string; c: string }>(
        `SELECT to_char((created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') AS d, count(*)::text AS n,
                coalesce(sum(b.total_cents) FILTER (WHERE b.status NOT IN ('pending','cancelled')),0)::text AS c
           FROM bookings b WHERE created_at >= $1 GROUP BY 1`,
        [since],
      );
      const dayMap = new Map(daily.rows.map((r) => [r.d, r]));
      const series: Array<{ date: string; bookings: number; valueCents: number }> = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = mytDate(new Date(t.getTime() - i * DAY));
        const r = dayMap.get(d);
        series.push({ date: d, bookings: r ? Number(r.n) : 0, valueCents: r ? Number(r.c) : 0 });
      }

      const byService = await db.query<{ name: string; n: string; c: string }>(
        `SELECT s.name_en AS name, count(*)::text AS n, coalesce(sum(b.total_cents) FILTER (WHERE b.status NOT IN ('pending','cancelled')),0)::text AS c
           FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.created_at >= $1 GROUP BY s.name_en ORDER BY count(*) DESC LIMIT 10`,
        [since],
      );
      const byArea = await db.query<{ name: string | null; n: string }>(
        `SELECT ar.name, count(*)::text AS n FROM bookings b JOIN addresses a ON a.id = b.address_id LEFT JOIN areas ar ON ar.id = a.area_id
          WHERE b.created_at >= $1 GROUP BY ar.name ORDER BY count(*) DESC LIMIT 10`,
        [since],
      );
      const top = await db.query<{ name: string | null; email: string; jobs: string; rating: string; n: number }>(
        `SELECT u.full_name AS name, u.email, count(*)::text AS jobs, p.rating_avg::text AS rating, p.rating_count AS n
           FROM booking_assignments ba JOIN bookings b ON b.id = ba.booking_id JOIN providers p ON p.id = ba.provider_id JOIN users u ON u.id = p.user_id
          WHERE b.status IN ('completed','paid_out') AND b.scheduled_at >= $1 GROUP BY u.id, u.full_name, u.email, p.rating_avg, p.rating_count
          ORDER BY count(*) DESC, u.email LIMIT 5`,
        [since],
      );

      res.json({
        days,
        bookings: { total: Object.values(byStatus).reduce((a, n) => a + n, 0), byStatus, completed: completedJobs, cancelled: byStatus.cancelled ?? 0 },
        money: {
          paidCents: Number(money.paid),
          refundedCents: Number(money.refunded),
          netCents: Number(money.paid) - Number(money.refunded),
          commissionCents: Number(commission.c),
          owedToProvidersCents: Number(owed.pending) + Number(owed.requested),
          requestedPayoutsCents: Number(owed.requested),
        },
        users: { customers: Number(users.rows.find((r) => r.role === 'customer')?.n ?? 0), providers: Number(users.rows.find((r) => r.role === 'provider')?.n ?? 0) },
        providers: { approved: Number(providers.approved), waitingForReview: Number(providers.waiting), suspended: Number(providers.suspended) },
        todo: { openDisputes: Number(disputes.open), needsProvider: Number(attention.n), applicationsWaiting: Number(providers.waiting), payoutsRequested: Number(owed.requested) > 0 },
        reviews: { average: Number(Number(ratings.avg).toFixed(2)), count: Number(ratings.n) },
        daily: series,
        byService: byService.rows.map((r) => ({ name: r.name, bookings: Number(r.n), valueCents: Number(r.c) })),
        byArea: byArea.rows.map((r) => ({ name: r.name ?? 'Unknown', bookings: Number(r.n) })),
        topProviders: top.rows.map((r) => ({ name: r.name ?? r.email, jobs: Number(r.jobs), rating: Number(r.rating), ratingCount: r.n })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** One row per booking whose job date (Malaysia time) falls in from..to. Up to 366 days. */
  router.get('/reports/bookings.csv', async (req, res, next) => {
    try {
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return res.status(400).json({ error: 'invalid_request', message: 'Use from and to as YYYY-MM-DD.' });
      if (from > to) return res.status(400).json({ error: 'invalid_request', message: 'The end date is before the start date.' });
      if ((Date.parse(to) - Date.parse(from)) / DAY > 366) return res.status(400).json({ error: 'range_too_long', message: 'Choose at most 366 days.' });
      const { rows } = await db.query<Record<string, any>>(
        `SELECT b.id, b.scheduled_at, s.name_en AS service, ar.name AS area, b.status, cu.email AS customer, pu.email AS provider,
                b.subtotal_cents, b.sst_cents, b.total_cents,
                (SELECT coalesce(sum(amount_cents),0) FROM payments p WHERE p.booking_id = b.id AND p.status IN ('held','released','refunded')) AS paid,
                (SELECT coalesce(sum(refunded_cents),0) FROM payments p WHERE p.booking_id = b.id) AS refunded,
                po.commission_cents, po.net_cents, po.status AS payout_status
           FROM bookings b
           JOIN services s ON s.id = b.service_id
           JOIN users cu ON cu.id = b.customer_id
           JOIN addresses a ON a.id = b.address_id
           LEFT JOIN areas ar ON ar.id = a.area_id
           LEFT JOIN booking_assignments ba ON ba.booking_id = b.id
           LEFT JOIN providers p ON p.id = ba.provider_id
           LEFT JOIN users pu ON pu.id = p.user_id
           LEFT JOIN payouts po ON po.booking_id = b.id
          WHERE (b.scheduled_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $1::date AND $2::date
          ORDER BY b.scheduled_at, b.id`,
        [from, to],
      );
      const head = ['Reference', 'Date (MYT)', 'Time (MYT)', 'Service', 'Area', 'Status', 'Customer', 'Provider', 'Subtotal RM', 'SST RM', 'Total RM', 'Paid RM', 'Refunded RM', 'Commission RM', 'Provider share RM', 'Payout status'];
      const lines = [head.map(csvCell).join(',')];
      for (const r of rows) {
        const local = new Date(new Date(r.scheduled_at).getTime() + MYT).toISOString();
        lines.push([
          String(r.id).slice(0, 8).toUpperCase(), local.slice(0, 10), local.slice(11, 16), r.service, r.area ?? '', r.status, r.customer, r.provider ?? '',
          rm(r.subtotal_cents), rm(r.sst_cents), rm(r.total_cents), rm(Number(r.paid)), rm(Number(r.refunded)), rm(r.commission_cents ?? null), rm(r.net_cents ?? null), r.payout_status ?? '',
        ].map(csvCell).join(','));
      }
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="home360-bookings-${from}-to-${to}.csv"`);
      res.send('﻿' + lines.join('\r\n') + '\r\n'); // BOM so Excel reads it as UTF-8
    } catch (err) {
      next(err);
    }
  });

  return router;
}
