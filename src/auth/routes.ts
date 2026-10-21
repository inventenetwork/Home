import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Mailer } from '../mailer.js';
import { LEGAL_VERSION } from '../legal.js';
import type { Role } from '../types.js';
import { GoogleAuthError, type GoogleVerifier } from './google.js';
import { requireAuth } from './middleware.js';
import {
  generateOtp,
  generateRefreshToken,
  hashSecret,
  safeEqualHex,
  signAccessToken,
} from './tokens.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);

const requestBody = z.object({ email: emailSchema });
const verifyBody = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  // Only used when this email has no account yet. Admin can never be self-selected.
  role: z.enum(['customer', 'provider']).default('customer'),
  // PDPA: explicit consent is required to create an account.
  consent: z.boolean().default(false),
  locale: z.enum(['en', 'ms', 'zh']).default('en'),
});
const googleBody = z.object({
  idToken: z.string().min(20).max(4000),
  role: z.enum(['customer', 'provider']).default('customer'),
  consent: z.boolean().default(false),
  locale: z.enum(['en', 'ms', 'zh']).default('en'),
});
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

interface UserRow {
  id: string;
  email: string;
  role: Role;
  status: string;
  full_name: string | null;
  locale: string;
}

export function authRouter(cfg: Config, db: Db, mailer: Mailer, googleVerifier?: GoogleVerifier): Router {
  const router = Router();

  async function issueTokens(user: { id: string; role: Role }) {
    const refreshToken = generateRefreshToken();
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3::int))`,
      [user.id, hashSecret(cfg, refreshToken), cfg.REFRESH_TTL_DAYS],
    );
    return {
      accessToken: signAccessToken(cfg, user),
      refreshToken,
      expiresIn: cfg.ACCESS_TTL_SECONDS,
      tokenType: 'Bearer' as const,
    };
  }

  // 1) Ask for a code. Always answers the same way so it cannot be used to discover which emails have accounts.
  router.post('/otp/request', async (req, res, next) => {
    try {
      const parsed = requestBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_email' });
      const { email } = parsed.data;

      const recent = await db.query<{ n: string; last_at: Date | null; secs: string | null }>(
        `SELECT count(*)::text AS n, max(created_at) AS last_at,
                extract(epoch FROM (now() - max(created_at)))::text AS secs
           FROM otp_codes
          WHERE email = $1 AND created_at > now() - interval '1 hour'`,
        [email],
      );
      const row = recent.rows[0]!;
      const sentLastHour = Number(row.n);
      const secsSinceLast = row.secs === null ? Infinity : Number(row.secs);
      if (sentLastHour >= cfg.OTP_MAX_PER_HOUR || secsSinceLast < cfg.OTP_RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({ error: 'too_many_requests' });
      }

      // Only the newest code is ever valid.
      await db.query('UPDATE otp_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL', [email]);

      const code = generateOtp();
      await db.query(
        `INSERT INTO otp_codes (email, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3::int))`,
        [email, hashSecret(cfg, `${email}:${code}`), cfg.OTP_TTL_MINUTES],
      );
      await mailer.sendOtp(email, code, cfg.OTP_TTL_MINUTES);

      res.json({ ok: true, message: 'If the email is valid, a code has been sent.' });
    } catch (err) {
      next(err);
    }
  });

  // 2) Exchange the code for tokens (creating the account on first use).
  router.post('/otp/verify', async (req, res, next) => {
    try {
      const parsed = verifyBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const { email, code, role, consent, locale } = parsed.data;

      const found = await db.query<{ id: string; code_hash: string; attempts: number }>(
        `SELECT id, code_hash, attempts FROM otp_codes
          WHERE email = $1 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [email],
      );
      const otp = found.rows[0];
      if (!otp) return res.status(400).json({ error: 'invalid_or_expired_code' });
      if (otp.attempts >= cfg.OTP_MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'too_many_attempts' });
      }

      if (!safeEqualHex(otp.code_hash, hashSecret(cfg, `${email}:${code}`))) {
        await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
        return res.status(400).json({ error: 'invalid_or_expired_code' });
      }

      let user = (
        await db.query<UserRow>('SELECT id, email, role, status, full_name, locale FROM users WHERE email = $1', [email])
      ).rows[0];

      // Checked before consuming the code, so forgetting the consent tick-box does not burn the code.
      if (!user && !consent) return res.status(400).json({ error: 'consent_required' });

      // Atomic single-use: only one concurrent request can consume the code.
      const consumed = await db.query(
        'UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
        [otp.id],
      );
      if (consumed.rowCount === 0) return res.status(400).json({ error: 'invalid_or_expired_code' });

      let created = false;
      if (!user) {
        const ins = await db.query<UserRow>(
          `INSERT INTO users (email, role, locale, consent_at, consent_version)
           VALUES ($1, $2, $3, now(), $4)
           RETURNING id, email, role, status, full_name, locale`,
          [email, role, locale, LEGAL_VERSION],
        );
        user = ins.rows[0]!;
        created = true;
        if (role === 'provider') {
          await db.query('INSERT INTO providers (user_id) VALUES ($1)', [user.id]);
        }
      }

      if (user.status !== 'active') return res.status(403).json({ error: 'account_unavailable' });

      const tokens = await issueTokens(user);
      res.status(created ? 201 : 200).json({
        ...tokens,
        user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name, locale: user.locale },
        isNewUser: created,
      });
    } catch (err) {
      next(err);
    }
  });

  // 2b) Sign in with Google. The browser sends the ID token Google gave it; we verify it ourselves and issue our own tokens.
  router.post('/google', async (req, res, next) => {
    try {
      if (!googleVerifier) return res.status(503).json({ error: 'google_not_configured' });
      const parsed = googleBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const { idToken, role, consent, locale } = parsed.data;

      let ident;
      try {
        ident = await googleVerifier(idToken);
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          return err.code === 'keys_unavailable'
            ? res.status(502).json({ error: 'google_unavailable' })
            : res.status(401).json({ error: 'invalid_token' });
        }
        throw err;
      }
      // Linking by email is only safe when Google vouches for the address.
      if (!ident.emailVerified) return res.status(401).json({ error: 'email_not_verified' });
      const email = ident.email.trim().toLowerCase();

      type Outcome = { user: UserRow; created: boolean } | 'consent_required';
      const attempt = (): Promise<Outcome> =>
        db.tx(async (tx): Promise<Outcome> => {
          const cols = 'u.id, u.email, u.role, u.status, u.full_name, u.locale';
          // 1. Already linked: that is the user, whatever email Google reports today.
          const linked = (
            await tx.query<UserRow>(
              `SELECT ${cols} FROM user_identities i JOIN users u ON u.id = i.user_id
                WHERE i.provider = 'google' AND i.subject = $1`,
              [ident.sub],
            )
          ).rows[0];
          if (linked) {
            await tx.query("UPDATE user_identities SET last_login_at = now() WHERE provider = 'google' AND subject = $1", [ident.sub]);
            return { user: linked, created: false };
          }

          // 2. Same verified email as an existing account (e.g. they used email codes before): link to it.
          let user = (await tx.query<UserRow>(`SELECT ${cols} FROM users u WHERE u.email = $1`, [email])).rows[0];
          let created = false;
          if (!user) {
            if (!consent) return 'consent_required';
            user = (
              await tx.query<UserRow>(
                `INSERT INTO users (email, role, locale, full_name, consent_at, consent_version)
                 VALUES ($1, $2, $3, $4, now(), $5)
                 RETURNING id, email, role, status, full_name, locale`,
                [email, role, locale, ident.name, LEGAL_VERSION],
              )
            ).rows[0]!;
            created = true;
            if (role === 'provider') await tx.query('INSERT INTO providers (user_id) VALUES ($1)', [user.id]);
          } else if (!user.full_name && ident.name) {
            await tx.query('UPDATE users SET full_name = $2, updated_at = now() WHERE id = $1', [user.id, ident.name]);
            user = { ...user, full_name: ident.name };
          }
          await tx.query(
            "INSERT INTO user_identities (user_id, provider, subject, email, last_login_at) VALUES ($1, 'google', $2, $3, now())",
            [user.id, ident.sub, email],
          );
          return { user, created };
        });

      let outcome: Outcome;
      try {
        outcome = await attempt();
      } catch (err) {
        // Two first-time requests for the same Google account can race; the loser retries and finds the winner's rows.
        if ((err as { code?: string }).code !== '23505') throw err;
        outcome = await attempt();
      }
      if (outcome === 'consent_required') return res.status(400).json({ error: 'consent_required' });

      const { user, created } = outcome;
      if (user.status !== 'active') return res.status(403).json({ error: 'account_unavailable' });

      const tokens = await issueTokens(user);
      res.status(created ? 201 : 200).json({
        ...tokens,
        user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name, locale: user.locale },
        isNewUser: created,
      });
    } catch (err) {
      next(err);
    }
  });

  // 3) Rotate a refresh token. Re-using an old one is treated as theft: every session for that user is revoked.
  router.post('/refresh', async (req, res, next) => {
    try {
      const parsed = refreshBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const hash = hashSecret(cfg, parsed.data.refreshToken);

      const { rows } = await db.query<{ id: string; user_id: string; revoked_at: Date | null; expired: boolean }>(
        'SELECT id, user_id, revoked_at, (expires_at <= now()) AS expired FROM refresh_tokens WHERE token_hash = $1',
        [hash],
      );
      const tok = rows[0];
      if (!tok) return res.status(401).json({ error: 'invalid_token' });
      if (tok.revoked_at) {
        await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [tok.user_id]);
        return res.status(401).json({ error: 'invalid_token' });
      }
      if (tok.expired) return res.status(401).json({ error: 'invalid_token' });

      const revoked = await db.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
        [tok.id],
      );
      if (revoked.rowCount === 0) return res.status(401).json({ error: 'invalid_token' });

      const user = (await db.query<UserRow>('SELECT id, email, role, status, full_name, locale FROM users WHERE id = $1', [tok.user_id])).rows[0];
      if (!user || user.status !== 'active') return res.status(401).json({ error: 'account_unavailable' });

      res.json(await issueTokens(user));
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const parsed = refreshBody.safeParse(req.body);
      if (parsed.success) {
        await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
          hashSecret(cfg, parsed.data.refreshToken),
        ]);
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth(cfg, db), async (req, res, next) => {
    try {
      const { rows } = await db.query<UserRow & { phone: string | null }>(
        'SELECT id, email, role, status, full_name, locale, phone FROM users WHERE id = $1',
        [req.user!.id],
      );
      const u = rows[0]!;
      res.json({ id: u.id, email: u.email, role: u.role, fullName: u.full_name, locale: u.locale, phone: u.phone });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
