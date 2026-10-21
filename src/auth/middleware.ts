import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Role } from '../types.js';
import { verifyAccessToken } from './tokens.js';

/** Verifies the Bearer token, then confirms the account is still active (so suspensions take effect immediately). */
export function requireAuth(cfg: Config, db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? '';
      const [scheme, token] = header.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token) {
        return res.status(401).json({ error: 'unauthenticated' });
      }
      let claims;
      try {
        claims = verifyAccessToken(cfg, token);
      } catch {
        return res.status(401).json({ error: 'invalid_token' });
      }
      const { rows } = await db.query<{ id: string; email: string; role: Role; status: string }>(
        'SELECT id, email, role, status FROM users WHERE id = $1',
        [claims.sub],
      );
      const user = rows[0];
      if (!user || user.status !== 'active') {
        return res.status(401).json({ error: 'account_unavailable' });
      }
      // Role comes from the DB, not the token, so role changes apply immediately.
      req.user = { id: user.id, email: user.email, role: user.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
