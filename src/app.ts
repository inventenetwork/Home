import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { addressesRouter, areasRouter } from './addresses/routes.js';
import { adminBookingsRouter } from './admin/bookings.js';
import { adminCatalogRouter } from './admin/catalog.js';
import { adminProvidersRouter } from './admin/providers.js';
import { adminDisputesRouter } from './admin/disputes.js';
import { adminAuditRouter } from './admin/audit-log.js';
import { adminHandoverRouter } from './admin/handover.js';
import { timingSafeEqual } from 'node:crypto';
import { runHousekeeping } from './housekeeping.js';
import { adminAnalyticsRouter } from './admin/analytics.js';
import { adminReportsRouter } from './admin/reports.js';
import { adminSettingsRouter } from './admin/settings.js';
import { adminUsersRouter } from './admin/users.js';
import { chatRouter, unreadRouter } from './chat/routes.js';
import { disputesRouter } from './disputes/routes.js';
import { recurringRouter } from './recurring/routes.js';
import { reviewsRouter } from './reviews/routes.js';
import { bookingsRouter } from './bookings/routes.js';
import { providerRouter, requireApprovedProvider } from './bookings/provider-routes.js';
import { createSecretBox } from './crypto.js';
import { LEGAL_VERSION } from './legal.js';
import { privacyRouter } from './privacy/routes.js';
import { providerOnboardingRouter } from './provider/onboarding.js';
import { bookingPhotosRouter } from './provider/photo-view.js';
import { providerWorkRouter } from './provider/work.js';
import { createDiskStore, type ImageStore } from './storage.js';
import { authRouter } from './auth/routes.js';
import { createGoogleVerifier, type GoogleVerifier } from './auth/google.js';
import { loadBookingSettings } from './bookings/settings.js';
import { catalogRouter } from './catalog/routes.js';
import { requireAuth, requireRole } from './auth/middleware.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { DEMO_ACCOUNTS } from './auth/demo.js';
import type { Mailer } from './mailer.js';
import { FakeGateway, fakeGatewaySecret } from './payments/fake.js';
import { fakeCheckoutRouter } from './payments/fake-page.js';
import type { PaymentGateway } from './payments/gateway.js';
import { bookingPaymentsRouter, createWebhookProcessor, webhookHandler } from './payments/routes.js';

export interface AppDeps {
  cfg: Config;
  db: Db;
  mailer: Mailer;
  /** Injectable clock so tests can control "now". */
  now?: () => Date;
  /** Injectable so tests can fake Google. Defaults to the real verifier when GOOGLE_CLIENT_ID is set. */
  googleVerifier?: GoogleVerifier;
  /** Injectable so tests can inspect or break the gateway. Defaults to the pretend gateway. */
  gateway?: PaymentGateway;
  /** Where photos and ID documents are kept. Tests pass an in-memory store; defaults to UPLOAD_DIR on disk. */
  store?: ImageStore;
}

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');

export function createApp({ cfg, db, mailer, now = () => new Date(), googleVerifier, gateway = new FakeGateway(fakeGatewaySecret(cfg.JWT_SECRET)), store = createDiskStore(cfg.UPLOAD_DIR) }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.NODE_ENV === 'production') app.set('trust proxy', 1); // behind a reverse proxy: needed for correct client IPs

  const box = createSecretBox(cfg.dataKey);
  const googleClientId = cfg.GOOGLE_CLIENT_ID || undefined;
  const verifier = googleVerifier ?? (googleClientId ? createGoogleVerifier({ clientId: googleClientId, now }) : undefined);

  // The web app ships no inline scripts or styles. The only third-party origin allowed is Google's sign-in library.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
          styleSrc: ["'self'", 'https://accounts.google.com/gsi/style'],
          frameSrc: ["'self'", 'https://accounts.google.com/gsi/'],
          imgSrc: ["'self'", 'data:', 'blob:'], // blob: = photos fetched with the login token and shown on the page
          connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
          // Plain-http localhost must not be force-upgraded to https in development.
          upgradeInsecureRequests: cfg.NODE_ENV === 'production' ? [] : null,
        },
      },
      // The Google sign-in pop-up needs to talk back to this page.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  );
  // Static web app first, so page assets never count against the API rate limit.
  app.use(express.static(WEB_DIR, { maxAge: cfg.NODE_ENV === 'production' ? '1h' : 0 }));
  app.use(cors({ origin: cfg.corsOrigins }));

  // The gateway's "payment done" message. It needs the exact raw bytes (the signature covers them), so it is
  // registered before the JSON parser. No login: the signature is the proof.
  const processWebhook = createWebhookProcessor(db, gateway, now);
  app.post('/payments/webhook', express.raw({ type: () => true, limit: '16kb' }), webhookHandler(processWebhook));

  // Photo uploads are base64 in JSON and need more room than other requests. Only logged-in callers get the larger limit.
  const UPLOAD_PATH = /^\/provider\/(documents|jobs\/[0-9a-f-]{36}\/photos)$/;
  const smallJson = express.json({ limit: '100kb' });
  const uploadJson = express.json({ limit: '5mb' });
  app.use((req, res, next) => {
    const big = req.method === 'POST' && UPLOAD_PATH.test(req.path) && !!req.headers.authorization;
    (big ? uploadJson : smallJson)(req, res, next);
  });
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: cfg.RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Public settings the web app needs before login. Nothing secret here.
  app.get('/config', async (_req, res, next) => {
    try {
      const b = await loadBookingSettings(db);
      res.json({
        googleClientId: verifier ? googleClientId ?? null : null,
        pendingExpiryMinutes: b.pendingExpiryMin,
        maxAdvanceDays: b.maxAdvanceDays,
        minLeadHours: b.minLeadHours,
        freeCancelHours: b.freeCancelHours,
        paymentGateway: gateway.name, // 'fake' shows a "test payments" notice in the web app
        demo: cfg.DEMO_MODE === 'true' ? { password: cfg.DEMO_PASSWORD, accounts: DEMO_ACCOUNTS.map((a) => ({ username: a.username, label: a.label })) } : null,
        legal: { company: cfg.COMPANY_NAME, email: cfg.SUPPORT_EMAIL, version: LEGAL_VERSION },
      });
    } catch (err) {
      next(err);
    }
  });

  // Called by a scheduler (Vercel Cron) when the app runs on a host that has no always-on process. Needs CRON_SECRET.
  app.all('/internal/housekeeping', async (req, res, next) => {
    try {
      if (!cfg.CRON_SECRET) return res.status(404).json({ error: 'not_found' });
      const given = Buffer.from(String(req.headers.authorization ?? ''));
      const want = Buffer.from(`Bearer ${cfg.CRON_SECRET}`);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ error: 'unauthorized' });
      await runHousekeeping(db, now());
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  app.use('/auth', authRouter(cfg, db, mailer, verifier));
  app.use('/services', catalogRouter(db, now));
  app.use('/areas', areasRouter(db));

  if (gateway instanceof FakeGateway) app.use('/fake-pay', fakeCheckoutRouter(db, gateway, processWebhook));

  const auth = requireAuth(cfg, db);
  app.use('/addresses', auth, addressesRouter(db));
  app.use('/me', auth, privacyRouter(db, store, now));
  app.use('/bookings', auth, bookingPaymentsRouter(db, gateway, now));
  app.use('/bookings', auth, bookingsRouter(db, gateway, now));
  app.use('/bookings', auth, bookingPhotosRouter(db, store));
  app.use('/bookings', auth, reviewsRouter(db, now));
  app.use('/bookings', auth, disputesRouter(db, now));
  app.use('/bookings', auth, chatRouter(db, now));
  app.use('/chat', auth, unreadRouter(db));
  app.use('/recurring', auth, recurringRouter(db, now));
  // The application (profile, bank, documents) is open to any provider; everything else needs approval.
  app.use('/provider', auth, requireRole('provider'), providerOnboardingRouter(db, now, store, box));
  app.use('/provider', auth, requireRole('provider'), requireApprovedProvider(db), providerWorkRouter(db, now, store));
  app.use('/provider', auth, requireRole('provider'), providerRouter(db, now));

  // Everything under /admin requires a logged-in admin.
  const admin = express.Router();
  admin.use(auth, requireRole('admin'));
  admin.get('/ping', (_req, res) => res.json({ ok: true }));
  admin.use(adminCatalogRouter(db));
  admin.use(adminBookingsRouter(db, gateway, now));
  admin.use(adminProvidersRouter(db, now, store, box));
  admin.use(adminDisputesRouter(db, gateway, now));
  admin.use(adminReportsRouter(db, now));
  admin.use(adminAnalyticsRouter(db, now));
  admin.use(adminUsersRouter(db, now));
  admin.use(adminSettingsRouter(db, now));
  admin.use(adminHandoverRouter(db, now));
  admin.use(adminAuditRouter(db));
  app.use('/admin', admin);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === 'object' && 'type' in err && (err as any).type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    if (err && typeof err === 'object' && 'type' in err && (err as any).type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
