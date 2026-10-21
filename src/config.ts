import 'dotenv/config';
import { z } from 'zod';

/** An empty value, as in a copied .env.example, counts as not set. */
const optionalText = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('./data/pglite'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  OTP_SECRET: z.string().min(32, 'OTP_SECRET must be at least 32 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Home360 <no-reply@example.com>'),
  ADMIN_EMAIL: z.string().optional(),
  // Development only: also print login codes in the server console when SMTP is configured (handy with fake test emails).
  DEV_LOG_OTP: z.string().optional(),
  // Google sign-in. Public by design (it identifies our app to Google). Leave empty to hide the Google button.
  GOOGLE_CLIENT_ID: z.string().optional(),
  // Payments. Only the pretend gateway exists so far; real gateways (Billplz, Toyyibpay, Stripe...) plug in behind the same interface.
  PAYMENT_GATEWAY: z.enum(['fake']).default('fake'),
  // Encrypts providers' bank account numbers in the database. Required in production; development falls back to JWT_SECRET.
  // (An empty value, as in a copied .env.example, counts as not set.)
  DATA_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32, 'DATA_KEY must be at least 32 characters').optional()),
  // Where uploaded photos and ID documents are stored (private; never served as static files).
  UPLOAD_DIR: z.string().default('./data/uploads'),
  // Where photos and ID documents live: 'db' (inside the database; demo only), 'disk' (UPLOAD_DIR, for your own computer or a server with a permanent disk) or 's3'
  // (any S3-compatible private bucket: AWS S3, Cloudflare R2, ...). Hosts without a permanent disk, like Vercel, must use 's3'.
  STORAGE: z.enum(['disk', 's3', 'db']).default('disk'),
  S3_BUCKET: optionalText,
  S3_REGION: z.string().default('ap-southeast-1'),
  S3_ENDPOINT: optionalText, // only for non-AWS services such as Cloudflare R2
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  S3_PREFIX: z.string().default('uploads/'),
  // Lets a scheduler (Vercel Cron) call /internal/housekeeping. Vercel sends it as "Authorization: Bearer <value>".
  CRON_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional()),
  // Production normally refuses the pretend payment gateway. Set to 'true' ONLY for a labelled online demo with no real money.
  ALLOW_FAKE_PAYMENTS: z.enum(['true', 'false']).default('false'),
  // Online demo only: log in with a username and password (admin / vendor / user) instead of an emailed code. Needs no SMTP.
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  DEMO_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8, 'DEMO_PASSWORD must be at least 8 characters').default('demo1234')),
  // Maximum database connections per running instance. Keep it small on serverless hosts (they start many instances).
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  // Set automatically by Vercel.
  VERCEL: optionalText,
  // Shown in the Terms and Privacy pages. Replace the placeholders before launch.
  COMPANY_NAME: z.string().default('Home360 (company name to be added)'),
  SUPPORT_EMAIL: z.string().default('support@example.com'),
  // Tunables (rarely changed; tests override them)
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  OTP_MAX_PER_HOUR: z.coerce.number().int().positive().default(5),
  ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

export type Config = z.infer<typeof schema> & { corsOrigins: string[]; dataKey: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && !cfg.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production');
  }
  if (cfg.NODE_ENV === 'production' && !cfg.SMTP_HOST && cfg.DEMO_MODE !== 'true') {
    throw new Error('SMTP_HOST is required in production (OTP emails must actually be sent)');
  }
  if (cfg.NODE_ENV === 'production' && cfg.DEV_LOG_OTP === 'true') {
    throw new Error('DEV_LOG_OTP must not be enabled in production (it would write login codes to the logs)');
  }
  if (cfg.NODE_ENV === 'production' && !cfg.DATA_KEY) {
    throw new Error('DATA_KEY is required in production (it encrypts providers\' bank details)');
  }
  if (cfg.NODE_ENV === 'production' && cfg.PAYMENT_GATEWAY === 'fake' && cfg.ALLOW_FAKE_PAYMENTS !== 'true') {
    throw new Error('PAYMENT_GATEWAY=fake is for development only. Production needs a real payment gateway (not built yet). For a labelled online demo with no real money, set ALLOW_FAKE_PAYMENTS=true.');
  }
  if (cfg.NODE_ENV === 'production' && cfg.DEMO_MODE === 'true' && cfg.ALLOW_FAKE_PAYMENTS !== 'true') {
    throw new Error('DEMO_MODE=true (shared demo logins) is only for a labelled demo: also set ALLOW_FAKE_PAYMENTS=true, and never use it with real customers.');
  }
  if (cfg.STORAGE === 's3' && (!cfg.S3_BUCKET || !cfg.S3_ACCESS_KEY_ID || !cfg.S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  if (cfg.VERCEL && cfg.STORAGE === 'disk') {
    throw new Error('On Vercel there is no permanent disk: set STORAGE=s3 (and the S3_* settings), or STORAGE=db for a small demo, so photos and ID documents are kept.');
  }
  if (cfg.STORAGE === 'db' && cfg.NODE_ENV === 'production' && cfg.DEMO_MODE !== 'true') {
    throw new Error('STORAGE=db keeps photos and ID documents in the database and is for the DEMO_MODE demo only. Use STORAGE=s3 for real use.');
  }
  return {
    ...cfg,
    dataKey: cfg.DATA_KEY ?? cfg.JWT_SECRET,
    corsOrigins: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
