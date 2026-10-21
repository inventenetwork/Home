import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { audit } from './audit.js';

const UUID = z.string().uuid();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Customer and provider accounts. Mounted behind requireAuth + requireRole('admin'). */
export function adminUsersRouter(db: Db, now: () => Date): Router {
  const router = Router();

  router.get('/users', async (req, res, next) => {
    try {
      const role = typeof req.query.role === 'string' ? req.query.role : '';
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      if (role && !['customer', 'provider', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid_request' });
      if (status && !['active', 'suspended', 'deleted'].includes(status)) return res.status(400).json({ error: 'invalid_request' });
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const like = q ? `%${escLike(q.toLowerCase())}%` : null;
      const { rows } = await db.query<Record<string, any>>(
        `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status, u.created_at,
                (SELECT count(*) FROM bookings b WHERE b.customer_id = u.id) AS bookings,
                (SELECT count(*) FROM booking_assignments ba JOIN providers p ON p.id = ba.provider_id WHERE p.user_id = u.id) AS jobs
           FROM users u
          WHERE ($1::text = '' OR u.role = $1) AND ($2::text = '' OR u.status = $2)
            AND ($3::text IS NULL OR lower(u.email) LIKE $3 ESCAPE '\\' OR lower(coalesce(u.full_name,'')) LIKE $3 ESCAPE '\\' OR coalesce(u.phone,'') LIKE $3 ESCAPE '\\')
          ORDER BY u.created_at DESC, u.id LIMIT $4 OFFSET $5`,
        [role, status, like, limit + 1, offset],
      );
      res.json({
        users: rows.slice(0, limit).map((r) => ({
          id: r.id as string, email: r.email as string, fullName: (r.full_name as string | null) ?? null, phone: (r.phone as string | null) ?? null,
          role: r.role as string, status: r.status as string, createdAt: new Date(r.created_at).toISOString(), bookings: Number(r.bookings), jobs: Number(r.jobs),
        })),
        hasMore: rows.length > limit,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/users/:id', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const u = (await db.query<Record<string, any>>('SELECT id, email, full_name, phone, role, status, consent_at, created_at FROM users WHERE id = $1', [id.data])).rows[0];
      if (!u) return res.status(404).json({ error: 'not_found' });
      const recent = await db.query<Record<string, any>>(
        `SELECT b.id, b.status, b.scheduled_at, b.total_cents, s.name_en AS service
           FROM bookings b JOIN services s ON s.id = b.service_id
          WHERE b.customer_id = $1 OR b.id IN (SELECT ba.booking_id FROM booking_assignments ba JOIN providers p ON p.id = ba.provider_id WHERE p.user_id = $1)
          ORDER BY b.scheduled_at DESC LIMIT 10`,
        [id.data],
      );
      const suspension = (
        await db.query<{ detail: { reason?: string } | null; created_at: Date }>(
          "SELECT detail, created_at FROM audit_log WHERE action = 'user.suspend' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1",
          [id.data],
        )
      ).rows[0];
      res.json({
        id: u.id as string, email: u.email as string, fullName: u.full_name ?? null, phone: u.phone ?? null, role: u.role as string, status: u.status as string,
        consentAt: u.consent_at ? new Date(u.consent_at).toISOString() : null, createdAt: new Date(u.created_at).toISOString(),
        suspendedReason: u.status === 'suspended' ? suspension?.detail?.reason ?? null : null,
        recentBookings: recent.rows.map((r) => ({ id: r.id as string, status: r.status as string, service: r.service as string, scheduledAt: new Date(r.scheduled_at).toISOString(), totalCents: r.total_cents as number })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Suspending blocks every request at once (the auth check reads the status), ends all sessions, and withdraws open job offers.
   * Bookings already made stay as they are: use the Handover list to move a suspended provider's jobs to someone else.
   */
  router.post('/users/:id/suspend', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = reasonBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request', message: 'Give a short reason.' });
      if (id.data === req.user!.id) return res.status(409).json({ error: 'cannot_suspend_self', message: 'You cannot suspend your own account.' });
      const t = now();
      const out = await db.tx(async (tx) => {
        const u = (await tx.query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1 FOR UPDATE', [id.data])).rows[0];
        if (!u) return { code: 404, error: 'not_found' };
        if (u.role === 'admin') return { code: 409, error: 'cannot_suspend_admin', message: 'Admin accounts cannot be suspended here.' };
        if (u.status !== 'active') return { code: 409, error: 'not_active', message: 'Only active accounts can be suspended.' };
        await tx.query("UPDATE users SET status = 'suspended', updated_at = $2 WHERE id = $1", [id.data, t]);
        await tx.query('UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [id.data, t]);
        await tx.query(
          `UPDATE job_offers SET status = 'withdrawn', responded_at = $2
            WHERE status = 'offered' AND provider_id IN (SELECT id FROM providers WHERE user_id = $1)`,
          [id.data, t],
        );
        await audit(tx, req.user!.id, 'user.suspend', 'user', id.data, { reason: body.data.reason });
        return null;
      });
      if (out) return res.status(out.code).json({ error: out.error, message: out.message });
      res.json({ id: id.data, status: 'suspended' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/users/:id/reinstate', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const out = await db.tx(async (tx) => {
        const u = (await tx.query<{ status: string }>('SELECT status FROM users WHERE id = $1 FOR UPDATE', [id.data])).rows[0];
        if (!u) return { code: 404, error: 'not_found' };
        if (u.status !== 'suspended') return { code: 409, error: 'not_suspended', message: 'This account is not suspended.' };
        await tx.query("UPDATE users SET status = 'active', updated_at = $2 WHERE id = $1", [id.data, now()]);
        await audit(tx, req.user!.id, 'user.reinstate', 'user', id.data, {});
        return null;
      });
      if (out) return res.status(out.code).json({ error: out.error, message: out.message });
      res.json({ id: id.data, status: 'active' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
