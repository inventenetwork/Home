import { Router } from 'express';
import { z } from 'zod';
import type { SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { PayoutError, markProviderPaid } from '../payouts/service.js';
import { withdrawUnskilledOffers } from '../provider/skills.js';
import { sendImage } from '../provider/onboarding.js';
import type { ImageStore } from '../storage.js';
import { audit } from './audit.js';

const UUID = z.string().uuid();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const approveBody = z.object({ note: z.string().trim().max(300).optional() }).strict();
const skillsBody = z.object({ skillCodes: z.array(z.string().min(1).max(60)).min(1).max(20) }).strict();
const payBody = z.object({ reference: z.string().trim().min(3).max(100) }).strict();
const docReviewBody = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).optional() }).strict();

/** Provider vetting and payouts. Mounted behind requireAuth + requireRole('admin'). */
export function adminProvidersRouter(db: Db, now: () => Date, store: ImageStore, box: SecretBox): Router {
  const router = Router();

  router.get('/providers', async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
      if (!['pending', 'approved', 'rejected', 'suspended', 'all'].includes(status)) return res.status(400).json({ error: 'invalid_request' });
      // "pending" means waiting for review: submitted, not yet decided. Half-finished applications are not queued.
      const where = status === 'all' ? 'TRUE' : status === 'pending' ? "p.vetting_status = 'pending' AND p.submitted_at IS NOT NULL" : 'p.vetting_status = $1';
      const { rows } = await db.query<Record<string, any>>(
        `SELECT p.id, p.vetting_status, p.submitted_at, p.reviewed_at, p.jobs_completed, p.rating_avg, p.rating_count,
                u.email, u.full_name, u.phone,
                (SELECT count(*) FROM provider_documents d WHERE d.provider_id = p.id) AS docs
           FROM providers p JOIN users u ON u.id = p.user_id
          WHERE ${where}
          ORDER BY p.submitted_at NULLS LAST, p.created_at
          LIMIT 200`,
        status === 'all' || status === 'pending' ? [] : [status],
      );
      res.json({
        providers: rows.map((r) => ({
          id: r.id as string,
          status: r.vetting_status as string,
          email: r.email as string,
          fullName: (r.full_name as string | null) ?? null,
          phone: (r.phone as string | null) ?? null,
          submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
          jobsCompleted: r.jobs_completed as number,
          documents: Number(r.docs),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/providers/:id', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const p = (
        await db.query<Record<string, any>>(
          `SELECT p.id, p.vetting_status, p.bio, p.submitted_at, p.reviewed_at, p.rejection_reason, p.jobs_completed,
                  p.bank_name, p.bank_account_name, p.bank_account_last4, u.email, u.full_name, u.phone
             FROM providers p JOIN users u ON u.id = p.user_id WHERE p.id = $1`,
          [id.data],
        )
      ).rows[0];
      if (!p) return res.status(404).json({ error: 'not_found' });
      const [areas, skills, docs, upcoming, allSkills] = await Promise.all([
        db.query<{ name: string }>('SELECT a.name FROM provider_areas pa JOIN areas a ON a.id = pa.area_id WHERE pa.provider_id = $1 ORDER BY a.name', [id.data]),
        db.query<{ name: string; code: string }>('SELECT s.name, s.code FROM provider_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.provider_id = $1 ORDER BY s.name', [id.data]),
        db.query<Record<string, any>>('SELECT id, doc_type, review_status, review_note FROM provider_documents WHERE provider_id = $1 ORDER BY created_at', [id.data]),
        db.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM booking_assignments ba JOIN bookings b ON b.id = ba.booking_id WHERE ba.provider_id = $1 AND b.status IN ('confirmed','on_the_way','in_progress')",
          [id.data],
        ),
        db.query<{ code: string; name: string }>('SELECT code, name FROM skills ORDER BY name'),
      ]);
      res.json({
        id: p.id as string,
        status: p.vetting_status as string,
        email: p.email as string,
        fullName: (p.full_name as string | null) ?? null,
        phone: (p.phone as string | null) ?? null,
        bio: (p.bio as string | null) ?? null,
        submittedAt: p.submitted_at ? new Date(p.submitted_at).toISOString() : null,
        reviewedAt: p.reviewed_at ? new Date(p.reviewed_at).toISOString() : null,
        rejectionReason: (p.rejection_reason as string | null) ?? null,
        jobsCompleted: p.jobs_completed as number,
        areas: areas.rows.map((a) => a.name),
        skills: skills.rows.map((s) => s.name),
        skillCodes: skills.rows.map((s) => s.code),
        allSkills: allSkills.rows,
        bank: p.bank_account_last4 ? { bankName: p.bank_name as string, accountName: p.bank_account_name as string, last4: p.bank_account_last4 as string } : null,
        documents: docs.rows.map((d) => ({ id: d.id as string, docType: d.doc_type as string, reviewStatus: d.review_status as string, reviewNote: (d.review_note as string | null) ?? null })),
        upcomingJobs: Number(upcoming.rows[0]!.n),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/providers/:id/documents/:docId/file', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const docId = UUID.safeParse(req.params.docId);
      if (!id.success || !docId.success) return res.status(404).json({ error: 'not_found' });
      const d = await db.query<{ file_url: string }>('SELECT file_url FROM provider_documents WHERE id = $1 AND provider_id = $2', [docId.data, id.data]);
      if (!d.rows[0]) return res.status(404).json({ error: 'not_found' });
      sendImage(res, await store.read(d.rows[0].file_url));
    } catch (err) {
      next(err);
    }
  });

  /** Mark one document good or bad (a bad one is flagged so the provider knows what to re-upload). */
  router.post('/providers/:id/documents/:docId/review', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const docId = UUID.safeParse(req.params.docId);
      const body = docReviewBody.safeParse(req.body);
      if (!id.success || !docId.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      if (body.data.status === 'rejected' && !body.data.note) return res.status(400).json({ error: 'note_required', message: 'Say what is wrong so the provider can fix it.' });
      const r = await db.tx(async (tx) => {
        const u = await tx.query(
          'UPDATE provider_documents SET review_status = $3, review_note = $4, reviewed_at = $5 WHERE id = $1 AND provider_id = $2',
          [docId.data, id.data, body.data.status, body.data.note ?? null, now()],
        );
        if (u.rowCount > 0) await audit(tx, req.user!.id, 'provider.document_review', 'provider', id.data, { docId: docId.data, ...body.data });
        return u.rowCount;
      });
      if (r === 0) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  type Decision = 'approve' | 'reject' | 'suspend' | 'reinstate';
  const RULES: Record<Decision, { from: string[]; to: string }> = {
    approve: { from: ['pending', 'rejected'], to: 'approved' },
    reject: { from: ['pending'], to: 'rejected' },
    suspend: { from: ['approved'], to: 'suspended' },
    reinstate: { from: ['suspended'], to: 'approved' },
  };

  async function decide(decision: Decision, providerId: string, adminId: string, reason: string | null) {
    return db.tx(async (tx) => {
      const p = (await tx.query<{ vetting_status: string; submitted_at: Date | null }>('SELECT vetting_status, submitted_at FROM providers WHERE id = $1 FOR UPDATE', [providerId])).rows[0];
      if (!p) return { error: 'not_found' as const };
      const rule = RULES[decision];
      if (!rule.from.includes(p.vetting_status)) return { error: 'invalid_transition' as const, from: p.vetting_status };
      const t = now();
      if (decision === 'approve') {
        if (!p.submitted_at) return { error: 'not_submitted' as const };
        const docs = await tx.query<{ doc_type: string; review_status: string }>('SELECT doc_type, review_status FROM provider_documents WHERE provider_id = $1', [providerId]);
        for (const need of ['id_front', 'id_back', 'selfie']) {
          if (!docs.rows.some((d) => d.doc_type === need)) return { error: 'documents_missing' as const };
        }
        if (docs.rows.some((d) => d.review_status === 'rejected')) return { error: 'document_rejected' as const };
        await tx.query("UPDATE provider_documents SET review_status = 'approved', reviewed_at = $2 WHERE provider_id = $1 AND review_status = 'pending'", [providerId, t]);
      }
      await tx.query(
        `UPDATE providers SET vetting_status = $2, reviewed_at = $3,
                rejection_reason = CASE WHEN $2 IN ('rejected','suspended') THEN $4 ELSE NULL END,
                approved_at = CASE WHEN $2 = 'approved' AND approved_at IS NULL THEN $3 ELSE approved_at END
          WHERE id = $1`,
        [providerId, rule.to, t, reason],
      );
      await audit(tx, adminId, `provider.${decision}`, 'provider', providerId, { from: p.vetting_status, to: rule.to, reason });
      return { ok: true as const, status: rule.to };
    });
  }

  /** Replace a provider's services. Admins can add as well as remove; open offers the provider can no longer take are withdrawn. */
  router.put('/providers/:id/skills', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const body = skillsBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request', message: 'Choose at least one service.' });
      const codes = [...new Set(body.data.skillCodes)];
      const skills = await db.query<{ id: string }>('SELECT id FROM skills WHERE code = ANY($1::text[])', [codes]);
      if (skills.rowCount !== codes.length) return res.status(400).json({ error: 'unknown_skill' });
      const out = await db.tx(async (tx) => {
        const p = (await tx.query('SELECT id FROM providers WHERE id = $1 FOR UPDATE', [id.data])).rows[0];
        if (!p) return null;
        const before = (await tx.query<{ code: string }>('SELECT s.code FROM provider_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.provider_id = $1 ORDER BY s.code', [id.data])).rows.map((r) => r.code);
        await tx.query('DELETE FROM provider_skills WHERE provider_id = $1', [id.data]);
        for (const s of skills.rows) await tx.query('INSERT INTO provider_skills (provider_id, skill_id) VALUES ($1,$2)', [id.data, s.id]);
        const withdrawn = await withdrawUnskilledOffers(tx, id.data, now());
        await audit(tx, req.user!.id, 'provider.skills_set', 'provider', id.data, { before, after: [...codes].sort() });
        return { withdrawn };
      });
      if (!out) return res.status(404).json({ error: 'not_found' });
      res.json({ id: id.data, skillCodes: [...codes].sort(), offersWithdrawn: out.withdrawn });
    } catch (err) {
      next(err);
    }
  });

  const decisionRoute = (decision: Decision, needsReason: boolean) =>
    router.post(`/providers/:id/${decision}`, async (req, res, next) => {
      try {
        const id = UUID.safeParse(req.params.id);
        if (!id.success) return res.status(404).json({ error: 'not_found' });
        let reason: string | null = null;
        if (needsReason) {
          const b = reasonBody.safeParse(req.body);
          if (!b.success) return res.status(400).json({ error: 'reason_required', message: 'Please give a short reason.' });
          reason = b.data.reason;
        } else if (!approveBody.safeParse(req.body ?? {}).success) {
          return res.status(400).json({ error: 'invalid_request' });
        }
        const r = await decide(decision, id.data, req.user!.id, reason);
        if ('ok' in r) return res.json({ id: id.data, status: r.status });
        res.status(r.error === 'not_found' ? 404 : 409).json({ error: r.error });
      } catch (err) {
        next(err);
      }
    });
  decisionRoute('approve', false);
  decisionRoute('reject', true);
  decisionRoute('suspend', true);
  decisionRoute('reinstate', false);

  // ───── Payouts ─────
  /** Providers waiting to be paid. The full account number is shown here (and only here) because the admin needs it to transfer. */
  router.get('/payouts', async (_req, res, next) => {
    try {
      const { rows } = await db.query<Record<string, any>>(
        `SELECT pr.id AS provider_id, u.full_name, u.email, pr.bank_name, pr.bank_account_name, pr.bank_account_enc,
                count(*) AS jobs, sum(p.net_cents) AS total_cents, min(p.requested_at) AS since,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments pay WHERE pay.booking_id = p.booking_id AND pay.refunded_cents > 0)) AS refunded_jobs
           FROM payouts p
           JOIN providers pr ON pr.id = p.provider_id
           JOIN users u ON u.id = pr.user_id
          WHERE p.status = 'requested'
          GROUP BY pr.id, u.full_name, u.email, pr.bank_name, pr.bank_account_name, pr.bank_account_enc
          ORDER BY min(p.requested_at)`,
      );
      res.json({
        requests: rows.map((r) => ({
          providerId: (r.provider_id as string),
          providerName: (r.full_name as string | null) ?? r.email,
          email: r.email as string,
          jobs: Number(r.jobs),
          totalCents: Number(r.total_cents),
          requestedAt: new Date(r.since).toISOString(),
          refundedJobs: Number(r.refunded_jobs),
          bank: r.bank_account_enc ? { bankName: r.bank_name as string, accountName: r.bank_account_name as string, accountNumber: box.decrypt(r.bank_account_enc as string) } : null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/payouts/:providerId/pay', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.providerId);
      const body = payBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'reference_required', message: 'Enter the bank transfer reference.' });
      try {
        res.json(await markProviderPaid(db, id.data, req.user!.id, body.data.reference, now()));
      } catch (err) {
        if (err instanceof PayoutError) return res.status(409).json({ error: err.code, message: err.message });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
