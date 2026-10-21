import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../admin/audit.js';
import { setStatus } from '../bookings/transition.js';
import type { Db } from '../db/index.js';
import type { ImageStore } from '../storage.js';

const profileBody = z
  .object({
    fullName: z.string().trim().min(1).max(100).optional(),
    phone: z.union([z.string().trim().max(30), z.null()]).optional(),
    locale: z.enum(['en', 'ms']).optional(),
  })
  .strict();
const deleteBody = z.object({ confirm: z.literal('DELETE') }).strict();

/** Normalises a Malaysian mobile number to +60..., or returns null if it does not look like one. */
export function normalizeMyPhone(raw: string): string | null {
  const m = /^(?:\+?60|0)(1\d{8,9})$/.exec(raw.replace(/[\s-]/g, ''));
  return m ? `+60${m[1]}` : null;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/**
 * PDPA tools for the logged-in person: correct my details, download my data, delete my account. Mounted at /me behind requireAuth.
 */
export function privacyRouter(db: Db, store: ImageStore, now: () => Date): Router {
  const router = Router();

  router.patch('/', async (req, res, next) => {
    try {
      const b = profileBody.safeParse(req.body);
      if (!b.success || Object.keys(b.data).length === 0) return res.status(400).json({ error: 'invalid_request' });
      let phone: string | null | undefined;
      if (b.data.phone === null || b.data.phone === '') phone = null;
      else if (b.data.phone !== undefined) {
        phone = normalizeMyPhone(b.data.phone);
        if (!phone) return res.status(400).json({ error: 'invalid_phone', message: 'Enter a Malaysian mobile number, for example 012-345 6789.' });
      }
      await db.query(
        `UPDATE users SET full_name = COALESCE($2, full_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                          locale = COALESCE($5, locale), updated_at = $6 WHERE id = $1`,
        [req.user!.id, b.data.fullName ?? null, phone !== undefined, phone ?? null, b.data.locale ?? null, now()],
      );
      const u = (await db.query<Record<string, any>>('SELECT id, email, role, full_name, phone, locale FROM users WHERE id = $1', [req.user!.id])).rows[0]!;
      res.json({ id: u.id, email: u.email, role: u.role, fullName: u.full_name, phone: u.phone, locale: u.locale });
    } catch (err) {
      next(err);
    }
  });

  /** Everything we hold about the person, as one JSON file. Other people's details (the provider's or customer's name) are left out. */
  router.get('/export', async (req, res, next) => {
    try {
      const id = req.user!.id;
      const q = async (sql: string, params: unknown[] = [id]) => (await db.query<Record<string, any>>(sql, params)).rows;
      const user = (await q('SELECT id, email, phone, full_name, role, locale, status, consent_at, consent_version, created_at FROM users WHERE id = $1'))[0]!;
      const addresses = await q('SELECT label, line1, line2, postcode, property_type, size_sqft, notes, created_at FROM addresses WHERE user_id = $1 ORDER BY created_at');
      const bookings = await q(
        `SELECT b.id, b.status, b.scheduled_at, b.duration_minutes, b.units, b.notes, b.subtotal_cents, b.sst_cents, b.total_cents, b.cancelled_reason, b.created_at, s.name_en AS service,
                (SELECT coalesce(json_agg(json_build_object('group', so.group_key, 'code', so.code) ORDER BY so.group_key), '[]'::json)
                   FROM booking_items bi JOIN service_options so ON so.id = bi.option_id WHERE bi.booking_id = b.id) AS options
           FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.customer_id = $1 ORDER BY b.created_at`,
      );
      const payments = await q(
        `SELECT p.booking_id, p.amount_cents, p.refunded_cents, p.status, p.method, p.created_at
           FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.customer_id = $1 ORDER BY p.created_at`,
      );
      const reviews = await q('SELECT booking_id, rating, comment, created_at FROM reviews WHERE customer_id = $1 ORDER BY created_at');
      const disputes = await q('SELECT booking_id, reason, status, resolution_note, refund_cents, created_at, resolved_at FROM disputes WHERE opened_by = $1 ORDER BY created_at');
      const messages = await q(
        `SELECT m.booking_id, m.body, m.created_at, (m.sender_id = $1) AS mine
           FROM messages m JOIN bookings b ON b.id = m.booking_id
           LEFT JOIN booking_assignments ba ON ba.booking_id = b.id LEFT JOIN providers p ON p.id = ba.provider_id
          WHERE b.customer_id = $1 OR p.user_id = $1 ORDER BY m.created_at`,
      );
      const plans = await q(
        `SELECT rp.id, rp.frequency, rp.sessions_total, rp.sessions_remaining, rp.status, rp.keep_provider, rp.notes, rp.created_at, s.name_en AS service
           FROM recurring_plans rp JOIN services s ON s.id = rp.service_id WHERE rp.customer_id = $1 ORDER BY rp.created_at`,
      );
      const prov = (
        await q(
          `SELECT id, vetting_status, bio, rating_avg, rating_count, jobs_completed, bank_name, bank_account_name, bank_account_last4, submitted_at, approved_at
             FROM providers WHERE user_id = $1`,
        )
      )[0];
      let provider: Record<string, unknown> | null = null;
      if (prov) {
        const pid = [prov.id];
        provider = {
          status: prov.vetting_status, bio: prov.bio, ratingAverage: Number(prov.rating_avg), ratingCount: prov.rating_count, jobsCompleted: prov.jobs_completed,
          bank: prov.bank_name ? { bankName: prov.bank_name, accountName: prov.bank_account_name, accountEndingIn: prov.bank_account_last4 } : null,
          submittedAt: iso(prov.submitted_at), approvedAt: iso(prov.approved_at),
          areas: (await q('SELECT a.name FROM provider_areas pa JOIN areas a ON a.id = pa.area_id WHERE pa.provider_id = $1 ORDER BY a.name', pid)).map((r) => r.name),
          skills: (await q('SELECT s.code FROM provider_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.provider_id = $1 ORDER BY s.code', pid)).map((r) => r.code),
          documents: (await q('SELECT doc_type, review_status, created_at FROM provider_documents WHERE provider_id = $1 ORDER BY created_at', pid)).map((d) => ({ type: d.doc_type, review: d.review_status, uploadedAt: iso(d.created_at) })),
          jobs: (await q(
            `SELECT b.id, b.status, b.scheduled_at, s.name_en AS service FROM booking_assignments ba JOIN bookings b ON b.id = ba.booking_id JOIN services s ON s.id = b.service_id
              WHERE ba.provider_id = $1 ORDER BY b.scheduled_at`, pid)).map((j) => ({ bookingId: j.id, status: j.status, scheduledAt: iso(j.scheduled_at), service: j.service })),
          payouts: (await q('SELECT booking_id, gross_cents, commission_cents, net_cents, status, paid_at, created_at FROM payouts WHERE provider_id = $1 ORDER BY created_at', pid)).map((p) => ({
            bookingId: p.booking_id, grossCents: p.gross_cents, commissionCents: p.commission_cents, netCents: p.net_cents, status: p.status, paidAt: iso(p.paid_at), createdAt: iso(p.created_at) })),
        };
      }
      const out = {
        exportedAt: now().toISOString(),
        note: 'This file contains the personal data Home360 holds about you. Identity document photos are not included; ask support if you need copies.',
        account: { id: user.id, email: user.email, phone: user.phone, fullName: user.full_name, role: user.role, language: user.locale, status: user.status, createdAt: iso(user.created_at), consentAt: iso(user.consent_at), consentVersion: user.consent_version },
        addresses: addresses.map((a) => ({ label: a.label, line1: a.line1, line2: a.line2, postcode: a.postcode, propertyType: a.property_type, sizeSqft: a.size_sqft, notes: a.notes, createdAt: iso(a.created_at) })),
        bookings: bookings.map((b) => ({ id: b.id, service: b.service, status: b.status, scheduledAt: iso(b.scheduled_at), durationMinutes: b.duration_minutes, units: b.units, options: b.options, notes: b.notes,
          subtotalCents: b.subtotal_cents, sstCents: b.sst_cents, totalCents: b.total_cents, cancelledReason: b.cancelled_reason, createdAt: iso(b.created_at) })),
        payments: payments.map((p) => ({ bookingId: p.booking_id, amountCents: p.amount_cents, refundedCents: p.refunded_cents, status: p.status, method: p.method, createdAt: iso(p.created_at) })),
        reviews: reviews.map((r) => ({ bookingId: r.booking_id, rating: r.rating, comment: r.comment, createdAt: iso(r.created_at) })),
        disputes: disputes.map((d) => ({ bookingId: d.booking_id, reason: d.reason, status: d.status, resolutionNote: d.resolution_note, refundCents: d.refund_cents, openedAt: iso(d.created_at), resolvedAt: iso(d.resolved_at) })),
        messages: messages.map((m) => ({ bookingId: m.booking_id, from: m.mine ? 'you' : 'the other person', body: m.body, sentAt: iso(m.created_at) })),
        repeatPlans: plans.map((p) => ({ id: p.id, service: p.service, frequency: p.frequency, sessionsTotal: p.sessions_total, sessionsRemaining: p.sessions_remaining, status: p.status, keepProvider: p.keep_provider, notes: p.notes, createdAt: iso(p.created_at) })),
        provider,
      };
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="home360-my-data-${out.exportedAt.slice(0, 10)}.json"`);
      res.setHeader('cache-control', 'no-store');
      res.send(JSON.stringify(out, null, 2));
    } catch (err) {
      next(err);
    }
  });

  /**
   * Delete my account. Personal details are erased or anonymised at once. Money records (bookings, payments, payouts, audit log)
   * are kept without any name, email, phone or address, because accounting and tax rules require them. Refused while a job is still
   * in progress or money is still owed, so nobody is left stranded.
   */
  router.post('/delete', async (req, res, next) => {
    try {
      if (!deleteBody.safeParse(req.body).success) return res.status(400).json({ error: 'confirmation_required', message: 'Type DELETE to confirm.' });
      if (req.user!.role === 'admin') return res.status(403).json({ error: 'admin_cannot_self_delete', message: 'Admin accounts cannot be deleted here.' });
      const id = req.user!.id;
      const t = now();
      const removeKeys: string[] = [];
      const out = await db.tx(async (tx) => {
        const u = (await tx.query<{ status: string; email: string }>('SELECT status, email FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!u || u.status !== 'active') return { reasons: ['not_active'] };
        const reasons: string[] = [];
        const open = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM bookings b
            WHERE b.status IN ('offered','confirmed','on_the_way','in_progress','disputed')
              AND (b.customer_id = $1 OR b.id IN (SELECT ba.booking_id FROM booking_assignments ba JOIN providers p ON p.id = ba.provider_id WHERE p.user_id = $1))`,
          [id],
        );
        if (Number(open.rows[0]!.n) > 0) reasons.push('active_bookings');
        const owed = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM payouts po JOIN providers p ON p.id = po.provider_id WHERE p.user_id = $1 AND po.status IN ('pending','requested')`,
          [id],
        );
        if (Number(owed.rows[0]!.n) > 0) reasons.push('payouts_outstanding');
        if (reasons.length) return { reasons };

        // Unpaid bookings simply lapse.
        const pending = await tx.query<{ id: string }>("SELECT id FROM bookings WHERE customer_id = $1 AND status = 'pending'", [id]);
        for (const b of pending.rows) await setStatus(tx, b.id, 'cancelled', 'customer', t, { reason: 'account_deleted' });
        await tx.query("UPDATE recurring_plans SET status = 'cancelled', updated_at = $2 WHERE customer_id = $1 AND status IN ('active','paused')", [id, t]);

        await tx.query("UPDATE bookings SET notes = NULL WHERE customer_id = $1", [id]);
        await tx.query("UPDATE addresses SET label = 'Deleted', line1 = '[deleted]', line2 = NULL, postcode = '00000', lat = NULL, lng = NULL, notes = NULL, size_sqft = NULL WHERE user_id = $1", [id]);
        await tx.query("UPDATE messages SET body = '[deleted]' WHERE sender_id = $1", [id]);
        await tx.query('DELETE FROM message_reads WHERE user_id = $1', [id]);
        await tx.query('UPDATE reviews SET comment = NULL WHERE customer_id = $1', [id]);
        await tx.query("UPDATE disputes SET reason = '[removed at the user''s request]' WHERE opened_by = $1", [id]);

        const prov = (await tx.query<{ id: string }>('SELECT id FROM providers WHERE user_id = $1', [id])).rows[0];
        if (prov) {
          const docs = await tx.query<{ file_url: string }>('SELECT file_url FROM provider_documents WHERE provider_id = $1', [prov.id]);
          removeKeys.push(...docs.rows.map((d) => d.file_url));
          await tx.query('DELETE FROM provider_documents WHERE provider_id = $1', [prov.id]);
          await tx.query("UPDATE job_offers SET status = 'withdrawn', responded_at = $2 WHERE provider_id = $1 AND status = 'offered'", [prov.id, t]);
          await tx.query('DELETE FROM provider_availability WHERE provider_id = $1', [prov.id]);
          await tx.query('DELETE FROM provider_areas WHERE provider_id = $1', [prov.id]);
          await tx.query('DELETE FROM provider_skills WHERE provider_id = $1', [prov.id]);
          await tx.query(
            `UPDATE providers SET vetting_status = 'suspended', bio = NULL, rejection_reason = NULL,
                    bank_name = NULL, bank_account_name = NULL, bank_account_enc = NULL, bank_account_last4 = NULL WHERE id = $1`,
            [prov.id],
          );
        }
        // Photos of the work are also personal data (the inside of someone's home): remove them, keep the booking record.
        const photos = await tx.query<{ checkin_photo_url: string | null; checkout_photo_url: string | null }>(
          `SELECT ba.checkin_photo_url, ba.checkout_photo_url FROM booking_assignments ba JOIN bookings b ON b.id = ba.booking_id WHERE b.customer_id = $1`,
          [id],
        );
        for (const p of photos.rows) for (const k of [p.checkin_photo_url, p.checkout_photo_url]) if (k) removeKeys.push(k);
        await tx.query('UPDATE booking_assignments SET checkin_photo_url = NULL, checkout_photo_url = NULL WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)', [id]);

        await tx.query('DELETE FROM user_identities WHERE user_id = $1', [id]);
        await tx.query('UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [id, t]);
        await tx.query('DELETE FROM otp_codes WHERE email = $1', [u.email]);
        await tx.query(
          `UPDATE users SET email = $2, full_name = NULL, phone = NULL, status = 'deleted', deleted_at = $3, updated_at = $3 WHERE id = $1`,
          [id, `deleted-${id}@deleted.invalid`, t],
        );
        await audit(tx, id, 'user.delete_self', 'user', id, {});
        return { reasons: [] as string[] };
      });
      if (out.reasons.length) {
        return res.status(409).json({ error: 'cannot_delete', reasons: out.reasons, message: 'Finish or cancel your active bookings, and wait for provider payouts to be paid, then try again.' });
      }
      // Files go after the database commit; a failure here only leaves an orphan file, never a half-deleted account.
      for (const key of removeKeys) await store.remove(key).catch(() => {});
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
