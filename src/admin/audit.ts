import type { Db } from '../db/index.js';

/** Append-only record of admin and system actions (actorId is null for automatic ones). Call inside the same transaction as the change it describes. */
export async function audit(tx: Db, actorId: string | null, action: string, entity: string, entityId: string, detail: unknown) {
  await tx.query('INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)', [
    actorId,
    action,
    entity,
    entityId,
    JSON.stringify(detail),
  ]);
}
