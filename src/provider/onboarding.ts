import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { audit } from '../admin/audit.js';
import { withdrawUnskilledOffers } from './skills.js';
import { ImageError, parseImage, type ImageStore } from '../storage.js';

const UUID = z.string().uuid();

/** Malaysian mobile numbers: 01x-xxxxxxx, with or without +60 / spaces / dashes. Stored as +60xxxxxxxxx. */
export function normalizeMyPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]/g, '');
  const m = /^(?:\+?60|0)(1\d{8,9})$/.exec(digits);
  return m ? `+60${m[1]}` : null;
}

const profileBody = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().trim().max(30),
    bio: z.string().trim().max(500).optional().default(''),
    areaSlugs: z.array(z.string().min(1).max(60)).max(20),
    skillCodes: z.array(z.string().min(1).max(60)).max(20),
  })
  .strict();

const bankBody = z
  .object({
    bankName: z.string().trim().min(2).max(60),
    accountName: z.string().trim().min(2).max(100),
    accountNumber: z.string().trim().regex(/^[0-9 -]{6,25}$/, 'digits only'),
  })
  .strict();

const docBody = z.object({ docType: z.enum(['id_front', 'id_back', 'selfie', 'certificate']), image: z.string().min(100).max(5_000_000) }).strict();

export const REQUIRED_DOCS = ['id_front', 'id_back', 'selfie'] as const;

export function sendImage(res: Response, img: { data: Buffer; mime: string } | null) {
  if (!img) return res.status(404).json({ error: 'not_found' });
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(img.data);
}

export function imageErrorStatus(err: unknown): { status: number; body: { error: string; message: string } } | null {
  if (!(err instanceof ImageError)) return null;
  return { status: err.code === 'image_too_large' ? 413 : 400, body: { error: err.code, message: err.message } };
}

/**
 * Provider application: profile, bank details, ID documents, submit for review.
 * Available to every logged-in provider, approved or not (mounted before the approval gate).
 */
export function providerOnboardingRouter(db: Db, now: () => Date, store: ImageStore, box: SecretBox): Router {
  const router = Router();

  // Every provider user has a providers row; create it if an old account is missing one.
  router.use(async (req: Request, res: Response, next) => {
    try {
      await db.query("INSERT INTO providers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [req.user!.id]);
      const p = (await db.query<{ id: string; vetting_status: string }>('SELECT id, vetting_status FROM providers WHERE user_id = $1', [req.user!.id])).rows[0]!;
      res.locals.pid = p.id;
      res.locals.vetting = p.vetting_status;
      next();
    } catch (err) {
      next(err);
    }
  });

  const locked = (res: Response) => res.locals.vetting === 'suspended';

  async function summary(userId: string, pid: string) {
    const [p, u, areas, skills, docs] = await Promise.all([
      db.query<Record<string, any>>(
        'SELECT vetting_status, bio, rejection_reason, submitted_at, bank_name, bank_account_name, bank_account_last4, bank_account_enc IS NOT NULL AS has_bank FROM providers WHERE id = $1',
        [pid],
      ),
      db.query<{ full_name: string | null; phone: string | null; email: string }>('SELECT full_name, phone, email FROM users WHERE id = $1', [userId]),
      db.query<{ slug: string }>('SELECT a.slug FROM provider_areas pa JOIN areas a ON a.id = pa.area_id WHERE pa.provider_id = $1 ORDER BY a.slug', [pid]),
      db.query<{ code: string }>('SELECT s.code FROM provider_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.provider_id = $1 ORDER BY s.code', [pid]),
      db.query<Record<string, any>>(
        'SELECT id, doc_type, review_status, review_note, created_at FROM provider_documents WHERE provider_id = $1 ORDER BY created_at',
        [pid],
      ),
    ]);
    const row = p.rows[0]!;
    const user = u.rows[0]!;
    const documents = docs.rows.map((d) => ({
      id: d.id as string,
      docType: d.doc_type as string,
      reviewStatus: d.review_status as string,
      reviewNote: (d.review_note as string | null) ?? null,
    }));
    const missing: string[] = [];
    if (!user.full_name) missing.push('fullName');
    if (!user.phone) missing.push('phone');
    if (areas.rowCount === 0) missing.push('areas');
    if (skills.rowCount === 0) missing.push('skills');
    for (const t of REQUIRED_DOCS) if (!documents.some((d) => d.docType === t)) missing.push(t);
    if (!row.has_bank) missing.push('bank');
    return {
      status: row.vetting_status as string,
      rejectionReason: (row.rejection_reason as string | null) ?? null,
      submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
      profile: {
        email: user.email,
        fullName: user.full_name,
        phone: user.phone,
        bio: (row.bio as string | null) ?? '',
        areaSlugs: areas.rows.map((r) => r.slug),
        skillCodes: skills.rows.map((r) => r.code),
      },
      bank: row.has_bank ? { bankName: row.bank_name as string, accountName: row.bank_account_name as string, last4: row.bank_account_last4 as string } : null,
      documents,
      missing,
      // Can send (or re-send) the application when nothing is missing and it is not already waiting for review.
      canSubmit: missing.length === 0 && (row.vetting_status === 'rejected' || (row.vetting_status === 'pending' && !row.submitted_at)),
    };
  }

  router.get('/me', async (req, res, next) => {
    try {
      res.json(await summary(req.user!.id, res.locals.pid));
    } catch (err) {
      next(err);
    }
  });

  /** What a provider can choose from when applying. */
  router.get('/options', async (_req, res, next) => {
    try {
      const [areas, skills] = await Promise.all([
        db.query<{ slug: string; name: string; state: string }>('SELECT slug, name, state FROM areas WHERE active ORDER BY state, name'),
        db.query<{ code: string; name: string }>('SELECT code, name FROM skills ORDER BY name'),
      ]);
      res.json({ areas: areas.rows, skills: skills.rows });
    } catch (err) {
      next(err);
    }
  });

  router.put('/profile', async (req, res, next) => {
    try {
      if (locked(res)) return res.status(403).json({ error: 'provider_suspended' });
      const body = profileBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const phone = normalizeMyPhone(body.data.phone);
      if (!phone) return res.status(400).json({ error: 'invalid_phone', message: 'Enter a Malaysian mobile number, e.g. 012-345 6789.' });
      const pid = res.locals.pid as string;
      const approved = res.locals.vetting === 'approved';
      const areaSlugs = [...new Set(body.data.areaSlugs)];
      const skillCodes = [...new Set(body.data.skillCodes)];

      const areas = await db.query<{ id: string }>('SELECT id FROM areas WHERE active AND slug = ANY($1::text[])', [areaSlugs]);
      if (areas.rowCount !== areaSlugs.length) return res.status(400).json({ error: 'unknown_area' });
      const skills = await db.query<{ id: string }>('SELECT id FROM skills WHERE code = ANY($1::text[])', [skillCodes]);
      if (skills.rowCount !== skillCodes.length) return res.status(400).json({ error: 'unknown_skill' });

      const changed = await db.tx(async (tx) => {
        let removing: string[] = [];
        if (approved) {
          // Skills were vetted by an admin. An approved provider may give a service up, but adding one needs the admin.
          const cur = (await tx.query<{ code: string }>('SELECT s.code FROM provider_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.provider_id = $1', [pid])).rows.map((r) => r.code);
          if (!skillCodes.every((c) => cur.includes(c))) return 'skills_locked' as const;
          if (skillCodes.length === 0) return 'skills_required' as const;
          removing = cur.filter((c) => !skillCodes.includes(c));
        }
        await tx.query('UPDATE users SET full_name = $2, phone = $3 WHERE id = $1', [req.user!.id, body.data.fullName, phone]);
        await tx.query('UPDATE providers SET bio = $2 WHERE id = $1', [pid, body.data.bio || null]);
        await tx.query('DELETE FROM provider_areas WHERE provider_id = $1', [pid]);
        for (const a of areas.rows) await tx.query('INSERT INTO provider_areas (provider_id, area_id) VALUES ($1,$2)', [pid, a.id]);
        if (!approved) {
          await tx.query('DELETE FROM provider_skills WHERE provider_id = $1', [pid]);
          for (const s of skills.rows) await tx.query('INSERT INTO provider_skills (provider_id, skill_id) VALUES ($1,$2)', [pid, s.id]);
        } else if (removing.length) {
          await tx.query('DELETE FROM provider_skills WHERE provider_id = $1 AND skill_id IN (SELECT id FROM skills WHERE code = ANY($2::text[]))', [pid, removing]);
          await withdrawUnskilledOffers(tx, pid, now());
          await audit(tx, req.user!.id, 'provider.skills_removed', 'provider', pid, { removed: removing });
        }
        return 'ok' as const;
      });
      if (changed === 'skills_locked') {
        return res.status(409).json({ error: 'skills_locked', message: 'Your skills were approved by our team. You can remove a service yourself, but adding one needs our team.' });
      }
      if (changed === 'skills_required') return res.status(400).json({ error: 'skills_required', message: 'Keep at least one service.' });
      res.json(await summary(req.user!.id, pid));
    } catch (err) {
      next(err);
    }
  });

  router.put('/bank', async (req, res, next) => {
    try {
      if (locked(res)) return res.status(403).json({ error: 'provider_suspended' });
      const body = bankBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const number = body.data.accountNumber.replace(/[\s-]/g, '');
      if (number.length < 6 || number.length > 20) return res.status(400).json({ error: 'invalid_request' });
      await db.query(
        'UPDATE providers SET bank_name = $2, bank_account_name = $3, bank_account_enc = $4, bank_account_last4 = $5 WHERE id = $1',
        [res.locals.pid, body.data.bankName, body.data.accountName, box.encrypt(number), number.slice(-4)],
      );
      res.json(await summary(req.user!.id, res.locals.pid));
    } catch (err) {
      next(err);
    }
  });

  router.post('/documents', async (req, res, next) => {
    try {
      if (locked(res)) return res.status(403).json({ error: 'provider_suspended' });
      const body = docBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request' });
      const pid = res.locals.pid as string;
      // Once approved, the identity documents are frozen. Only extra certificates can be added.
      if (res.locals.vetting === 'approved' && body.data.docType !== 'certificate') {
        return res.status(409).json({ error: 'documents_locked', message: 'Your identity documents are already approved.' });
      }
      let img;
      try {
        img = parseImage(body.data.image);
      } catch (err) {
        const e = imageErrorStatus(err);
        if (e) return res.status(e.status).json(e.body);
        throw err;
      }
      if (body.data.docType === 'certificate') {
        const n = await db.query('SELECT 1 FROM provider_documents WHERE provider_id = $1 AND doc_type = $2', [pid, 'certificate']);
        if (n.rowCount >= 5) return res.status(409).json({ error: 'too_many_documents' });
      }
      const key = await store.save(img.data, img.ext);
      let oldKey: string | null = null;
      try {
        await db.tx(async (tx) => {
          if (body.data.docType !== 'certificate') {
            const old = await tx.query<{ file_url: string }>('DELETE FROM provider_documents WHERE provider_id = $1 AND doc_type = $2 RETURNING file_url', [pid, body.data.docType]);
            oldKey = old.rows[0]?.file_url ?? null;
          }
          await tx.query('INSERT INTO provider_documents (provider_id, doc_type, file_url, created_at) VALUES ($1,$2,$3,$4)', [pid, body.data.docType, key, now()]);
        });
      } catch (err) {
        await store.remove(key);
        throw err;
      }
      if (oldKey) await store.remove(oldKey);
      res.status(201).json(await summary(req.user!.id, pid));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/documents/:id', async (req, res, next) => {
    try {
      if (locked(res)) return res.status(403).json({ error: 'provider_suspended' });
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const pid = res.locals.pid as string;
      if (res.locals.vetting === 'approved') {
        // Approved identity documents must stay on file. Extra certificates can be removed.
        const d = await db.query<{ doc_type: string }>('SELECT doc_type FROM provider_documents WHERE id = $1 AND provider_id = $2', [id.data, pid]);
        if (d.rows[0] && d.rows[0].doc_type !== 'certificate') return res.status(409).json({ error: 'documents_locked' });
      }
      const gone = await db.query<{ file_url: string }>('DELETE FROM provider_documents WHERE id = $1 AND provider_id = $2 RETURNING file_url', [id.data, pid]);
      if (!gone.rows[0]) return res.status(404).json({ error: 'not_found' });
      await store.remove(gone.rows[0].file_url);
      res.json(await summary(req.user!.id, pid));
    } catch (err) {
      next(err);
    }
  });

  /** A provider can look at their own uploaded documents (to check a blurry photo, say). */
  router.get('/documents/:id/file', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const d = await db.query<{ file_url: string }>('SELECT file_url FROM provider_documents WHERE id = $1 AND provider_id = $2', [id.data, res.locals.pid]);
      if (!d.rows[0]) return res.status(404).json({ error: 'not_found' });
      sendImage(res, await store.read(d.rows[0].file_url));
    } catch (err) {
      next(err);
    }
  });

  router.post('/submit', async (req, res, next) => {
    try {
      if (locked(res)) return res.status(403).json({ error: 'provider_suspended' });
      const pid = res.locals.pid as string;
      const s = await summary(req.user!.id, pid);
      if (s.status === 'approved') return res.status(409).json({ error: 'already_approved' });
      if (s.status === 'pending' && s.submittedAt) return res.status(409).json({ error: 'already_submitted' });
      if (s.missing.length > 0) return res.status(400).json({ error: 'application_incomplete', missing: s.missing });
      const t = now();
      await db.query(
        "UPDATE providers SET vetting_status = 'pending', submitted_at = $2, rejection_reason = NULL, reviewed_at = NULL WHERE id = $1 AND vetting_status IN ('pending','rejected')",
        [pid, t],
      );
      // A re-submission puts every document back in the queue.
      await db.query("UPDATE provider_documents SET review_status = 'pending', review_note = NULL, reviewed_at = NULL WHERE provider_id = $1 AND review_status = 'rejected'", [pid]);
      res.json(await summary(req.user!.id, pid));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
