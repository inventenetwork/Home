import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';
import type { Role } from '../types.js';

const ISSUER = 'home360';

export function signAccessToken(cfg: Config, user: { id: string; role: Role }): string {
  return jwt.sign({ role: user.role }, cfg.JWT_SECRET, {
    subject: user.id,
    issuer: ISSUER,
    expiresIn: cfg.ACCESS_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(cfg: Config, token: string): { sub: string; role: Role } {
  const payload = jwt.verify(token, cfg.JWT_SECRET, { issuer: ISSUER, algorithms: ['HS256'] }) as jwt.JwtPayload;
  if (!payload.sub || typeof payload.role !== 'string') throw new Error('Malformed token');
  return { sub: payload.sub, role: payload.role as Role };
}

/** 6-digit numeric code from a CSPRNG. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** HMAC so a leaked database does not reveal live codes. */
export function hashSecret(cfg: Config, value: string): string {
  return createHmac('sha256', cfg.OTP_SECRET).update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}
