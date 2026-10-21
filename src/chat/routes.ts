import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.js';

const UUID = z.string().uuid();
const postBody = z.object({ body: z.string().trim().min(1).max(1000) }).strict();
const WRITABLE = ['confirmed', 'on_the_way', 'in_progress', 'completed', 'disputed'];
const MAX_PER_MINUTE = 10;

interface Access {
  side: 'customer' | 'provider';
  status: string;
  otherName: string | null;
}

const first = (n: string | null) => (n ? n.split(' ')[0]! : null);

/**
 * Chat between the customer and the assigned provider of one booking. Mounted at /bookings behind requireAuth.
 * Anyone else (including other providers and other customers) gets 404. Admins read chats through the dispute desk.
 */
export function chatRouter(db: Db, now: () => Date): Router {
  const router = Router();

  async function access(userId: string, bookingId: string): Promise<Access | null> {
    const r = (
      await db.query<{ status: string; customer_id: string; provider_user_id: string | null; customer_name: string | null; provider_name: string | null }>(
        `SELECT b.status, b.customer_id, pr.user_id AS provider_user_id, cu.full_name AS customer_name, pu.full_name AS provider_name
           FROM bookings b
           JOIN users cu ON cu.id = b.customer_id
           JOIN booking_assignments ba ON ba.booking_id = b.id
           JOIN providers pr ON pr.id = ba.provider_id
           JOIN users pu ON pu.id = pr.user_id
          WHERE b.id = $1`,
        [bookingId],
      )
    ).rows[0];
    if (!r) return null;
    if (r.customer_id === userId) return { side: 'customer', status: r.status, otherName: first(r.provider_name) };
    if (r.provider_user_id === userId) return { side: 'provider', status: r.status, otherName: first(r.customer_name) };
    return null;
  }

  router.get('/:id/messages', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const a = await access(req.user!.id, id.data);
      if (!a) return res.status(404).json({ error: 'not_found' });
      const { rows } = await db.query<{ id: string; sender_id: string; body: string; created_at: Date }>(
        'SELECT id, sender_id, body, created_at FROM messages WHERE booking_id = $1 ORDER BY created_at, id LIMIT 300',
        [id.data],
      );
      await db.query(
        `INSERT INTO message_reads (booking_id, user_id, read_at) VALUES ($1,$2,$3)
         ON CONFLICT (booking_id, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
        [id.data, req.user!.id, now()],
      );
      res.json({
        otherName: a.otherName,
        canPost: WRITABLE.includes(a.status),
        messages: rows.map((m) => ({ id: m.id, mine: m.sender_id === req.user!.id, body: m.body, createdAt: new Date(m.created_at).toISOString() })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/messages', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const b = postBody.safeParse(req.body);
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      const a = await access(req.user!.id, id.data);
      if (!a) return res.status(404).json({ error: 'not_found' });
      if (!b.success) return res.status(400).json({ error: 'invalid_message', message: 'Write a message of 1 to 1000 characters.' });
      if (!WRITABLE.includes(a.status)) return res.status(409).json({ error: 'chat_closed', message: 'Chat is closed for this booking.' });
      const t = now();
      const recent = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM messages WHERE booking_id = $1 AND sender_id = $2 AND created_at > $3",
        [id.data, req.user!.id, new Date(t.getTime() - 60_000)],
      );
      if (Number(recent.rows[0]!.n) >= MAX_PER_MINUTE) return res.status(429).json({ error: 'too_many_messages', message: 'Please slow down a little.' });
      const m = await db.query<{ id: string }>('INSERT INTO messages (booking_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4) RETURNING id', [id.data, req.user!.id, b.data.body, t]);
      // Sending counts as having read everything up to now.
      await db.query(
        `INSERT INTO message_reads (booking_id, user_id, read_at) VALUES ($1,$2,$3)
         ON CONFLICT (booking_id, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
        [id.data, req.user!.id, t],
      );
      res.status(201).json({ id: m.rows[0]!.id, mine: true, body: b.data.body, createdAt: t.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** GET /chat/unread: how many unread messages the logged-in user has, per booking. */
export function unreadRouter(db: Db): Router {
  const router = Router();
  router.get('/unread', async (req, res, next) => {
    try {
      const { rows } = await db.query<{ booking_id: string; n: string }>(
        `SELECT m.booking_id, count(*)::text AS n
           FROM messages m
           JOIN bookings b ON b.id = m.booking_id
           LEFT JOIN booking_assignments ba ON ba.booking_id = b.id
           LEFT JOIN providers pr ON pr.id = ba.provider_id
           LEFT JOIN message_reads r ON r.booking_id = m.booking_id AND r.user_id = $1
          WHERE (b.customer_id = $1 OR pr.user_id = $1)
            AND m.sender_id <> $1
            AND (r.read_at IS NULL OR m.created_at > r.read_at)
          GROUP BY m.booking_id`,
        [req.user!.id],
      );
      res.json({ unread: Object.fromEntries(rows.map((r) => [r.booking_id, Number(r.n)])), total: rows.reduce((a, r) => a + Number(r.n), 0) });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
