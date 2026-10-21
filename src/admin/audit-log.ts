import { Router } from 'express';
import type { Db } from '../db/index.js';

/** Read-only view of who did what. The log itself is append-only (see audit.ts). */
export function adminAuditRouter(db: Db): Router {
  const router = Router();
  router.get('/audit', async (req, res, next) => {
    try {
      const action = typeof req.query.action === 'string' ? req.query.action.trim().slice(0, 60) : '';
      const entityId = typeof req.query.entityId === 'string' ? req.query.entityId.trim().slice(0, 60) : '';
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
      const { rows } = await db.query<Record<string, any>>(
        `SELECT l.id, l.action, l.entity, l.entity_id, l.detail, l.created_at, u.email AS actor
           FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
          WHERE ($1::text = '' OR l.action LIKE $1 || '%') AND ($2::text = '' OR l.entity_id = $2) AND ($3::timestamptz IS NULL OR l.created_at < $3)
          ORDER BY l.created_at DESC, l.id LIMIT $4`,
        [action, entityId, before, limit + 1],
      );
      const page = rows.slice(0, limit);
      res.json({
        entries: page.map((r) => ({ id: r.id as string, action: r.action as string, entity: (r.entity as string | null) ?? null, entityId: (r.entity_id as string | null) ?? null, detail: r.detail ?? null, actor: (r.actor as string | null) ?? 'system', at: new Date(r.created_at).toISOString() })),
        next: rows.length > limit ? new Date(page[page.length - 1]!.created_at).toISOString() : null,
      });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
