import { Router } from 'express';
import { z } from 'zod';
import { localDateString } from '../bookings/availability.js';
import type { Db } from '../db/index.js';
import { PayoutError, loadEarnings, requestPayout } from '../payouts/service.js';
import { parseImage, type ImageStore } from '../storage.js';
import { imageErrorStatus } from './onboarding.js';
import { loadProviderSettings } from './settings.js';

const UUID = z.string().uuid();
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const windowsBody = z
  .object({
    windows: z
      .array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string().regex(TIME), end: z.string().regex(TIME) }).strict())
      .max(21),
  })
  .strict();
const timeOffBody = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const photoBody = z.object({ kind: z.enum(['before', 'after']), image: z.string().min(100).max(5_000_000) }).strict();

/**
 * Approved-provider tools that are not about offers or status changes: working hours, days off,
 * job photos and earnings. Mount it behind the approval gate.
 */
export function providerWorkRouter(db: Db, now: () => Date, store: ImageStore): Router {
  const router = Router();

  // ───── Calendar ─────
  async function loadCalendar(providerId: string) {
    const rows = await db.query<Record<string, any>>(
      `SELECT id, weekday, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time,
              to_char(on_date,'YYYY-MM-DD') AS on_date, is_available
         FROM provider_availability WHERE provider_id = $1 ORDER BY weekday, start_time, on_date`,
      [providerId],
    );
    return {
      windows: rows.rows.filter((r) => r.on_date === null && r.weekday !== null).map((r) => ({ weekday: r.weekday as number, start: r.start_time as string, end: r.end_time as string })),
      timeOff: rows.rows
        .filter((r) => r.on_date !== null && !r.is_available && r.on_date >= localDateString(now()))
        .map((r) => ({ id: r.id as string, date: r.on_date as string })),
    };
  }

  router.get('/availability', async (_req, res, next) => {
    try {
      res.json(await loadCalendar(res.locals.providerId));
    } catch (err) {
      next(err);
    }
  });

  /** Replaces the whole weekly schedule. Several windows a day are fine (e.g. 08:00-12:00 and 14:00-18:00). */
  router.put('/availability', async (req, res, next) => {
    try {
      const body = windowsBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const byDay = new Map<number, Array<[number, number]>>();
      for (const w of body.data.windows) {
        const s = toMin(w.start);
        const e = toMin(w.end);
        if (s >= e) return res.status(400).json({ error: 'invalid_window', message: 'A working window must end after it starts.' });
        byDay.set(w.weekday, [...(byDay.get(w.weekday) ?? []), [s, e]]);
      }
      for (const list of byDay.values()) {
        list.sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < list.length; i++) {
          if (list[i]![0] < list[i - 1]![1]) return res.status(400).json({ error: 'overlapping_windows', message: 'Working windows on the same day cannot overlap.' });
        }
      }
      const pid = res.locals.providerId as string;
      await db.tx(async (tx) => {
        await tx.query('DELETE FROM provider_availability WHERE provider_id = $1 AND on_date IS NULL', [pid]);
        for (const w of body.data.windows) {
          await tx.query('INSERT INTO provider_availability (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [pid, w.weekday, w.start, w.end]);
        }
      });
      res.json(await loadCalendar(pid));
    } catch (err) {
      next(err);
    }
  });

  /** Mark a whole day off. Jobs already booked that day are not cancelled: we tell the provider so they can ask for help. */
  router.post('/time-off', async (req, res, next) => {
    try {
      const body = timeOffBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const date = body.data.date;
      const today = localDateString(now());
      const limit = localDateString(new Date(now().getTime() + 365 * 86_400_000));
      if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return res.status(400).json({ error: 'invalid_request' });
      if (date < today) return res.status(400).json({ error: 'date_in_past', message: 'That day has already passed.' });
      if (date > limit) return res.status(400).json({ error: 'date_too_far' });
      const pid = res.locals.providerId as string;
      await db.query(
        'INSERT INTO provider_availability (provider_id, on_date, is_available) VALUES ($1,$2,false) ON CONFLICT (provider_id, on_date) WHERE on_date IS NOT NULL AND is_available = false DO NOTHING',
        [pid, date],
      );
      const clash = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM booking_assignments ba JOIN bookings b ON b.id = ba.booking_id
          WHERE ba.provider_id = $1 AND b.status IN ('confirmed','on_the_way','in_progress')
            AND (b.scheduled_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date`,
        [pid, date],
      );
      res.status(201).json({ ...(await loadCalendar(pid)), bookedJobsThatDay: Number(clash.rows[0]!.n) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/time-off/:id', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const pid = res.locals.providerId as string;
      const r = await db.query('DELETE FROM provider_availability WHERE id = $1 AND provider_id = $2 AND on_date IS NOT NULL', [id.data, pid]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      res.json(await loadCalendar(pid));
    } catch (err) {
      next(err);
    }
  });

  // ───── Job photos ─────
  router.post('/jobs/:id/photos', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = photoBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const pid = res.locals.providerId as string;
      const job = (
        await db.query<{ status: string; checkin_photo_url: string | null; checkout_photo_url: string | null }>(
          `SELECT b.status, ba.checkin_photo_url, ba.checkout_photo_url FROM booking_assignments ba JOIN bookings b ON b.id = ba.booking_id
            WHERE ba.booking_id = $1 AND ba.provider_id = $2`,
          [id.data, pid],
        )
      ).rows[0];
      if (!job) return res.status(404).json({ error: 'not_found' });
      const okStates = body.data.kind === 'before' ? ['on_the_way', 'in_progress'] : ['in_progress'];
      if (!okStates.includes(job.status)) {
        return res.status(409).json({ error: 'wrong_job_state', message: body.data.kind === 'before' ? 'Add the before photo once you are on your way or have started.' : 'Add the after photo while the job is in progress.' });
      }
      let img;
      try {
        img = parseImage(body.data.image);
      } catch (err) {
        const e = imageErrorStatus(err);
        if (e) return res.status(e.status).json(e.body);
        throw err;
      }
      const key = await store.save(img.data, img.ext);
      const col = body.data.kind === 'before' ? 'checkin_photo_url' : 'checkout_photo_url';
      const oldKey = body.data.kind === 'before' ? job.checkin_photo_url : job.checkout_photo_url;
      try {
        await db.query(`UPDATE booking_assignments SET ${col} = $2 WHERE booking_id = $1`, [id.data, key]);
      } catch (err) {
        await store.remove(key);
        throw err;
      }
      if (oldKey) await store.remove(oldKey);
      res.status(201).json({ id: id.data, kind: body.data.kind, saved: true });
    } catch (err) {
      next(err);
    }
  });

  // ───── Earnings ─────
  // ───── Reviews ─────
  router.get('/reviews', async (req, res, next) => {
    try {
      const pr = (await db.query<{ id: string; rating_avg: string; rating_count: number }>('SELECT id, rating_avg, rating_count FROM providers WHERE user_id = $1', [req.user!.id])).rows[0];
      if (!pr) return res.status(404).json({ error: 'not_found' });
      const { rows } = await db.query<{ rating: number; comment: string | null; created_at: Date; full_name: string | null; service: string }>(
        `SELECT r.rating, r.comment, r.created_at, u.full_name, s.name_en AS service
           FROM reviews r JOIN users u ON u.id = r.customer_id JOIN bookings b ON b.id = r.booking_id JOIN services s ON s.id = b.service_id
          WHERE r.provider_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
        [pr.id],
      );
      res.json({
        ratingAvg: Number(pr.rating_avg),
        ratingCount: pr.rating_count,
        reviews: rows.map((r) => ({ rating: r.rating, comment: r.comment, createdAt: new Date(r.created_at).toISOString(), customer: r.full_name ? r.full_name.split(' ')[0]! : 'Customer', service: r.service })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/earnings', async (_req, res, next) => {
    try {
      const s = await loadProviderSettings(db);
      res.json(await loadEarnings(db, res.locals.providerId, s, now()));
    } catch (err) {
      next(err);
    }
  });

  router.post('/payouts/request', async (_req, res, next) => {
    try {
      const s = await loadProviderSettings(db);
      try {
        res.status(201).json(await requestPayout(db, res.locals.providerId, s, now()));
      } catch (err) {
        if (err instanceof PayoutError) return res.status(err.code === 'no_bank_details' ? 400 : 409).json({ error: err.code, message: err.message });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
