import express, { Router } from 'express';
import type { Db } from '../db/index.js';
import type { FakeGateway } from './fake.js';
import type { createWebhookProcessor } from './routes.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const rm = (cents: number) => `RM ${(cents / 100).toFixed(2)}`;
const METHOD: Record<string, string> = { fpx: 'FPX online banking', ewallet: 'E-wallet' };

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="/css/styles.css"></head>
<body><main class="container narrow"><div class="card">${body}</div></main></body></html>`;
}

/**
 * The pretend bank page. Only exists while the fake gateway is in use (never in production).
 * Its buttons make the fake gateway send our own webhook endpoint a signed message, exactly like a real one would.
 */
export function fakeCheckoutRouter(db: Db, gateway: FakeGateway, process: ReturnType<typeof createWebhookProcessor>): Router {
  const router = Router();

  async function find(ref: string) {
    return (
      await db.query<{ id: string; booking_id: string; amount_cents: number; status: string; method: string | null }>(
        'SELECT id, booking_id, amount_cents, status, method FROM payments WHERE gateway = $1 AND gateway_ref = $2',
        [gateway.name, ref],
      )
    ).rows[0];
  }

  router.get('/:ref', async (req, res, next) => {
    try {
      const p = await find(req.params.ref!);
      res.set('Cache-Control', 'no-store');
      if (!p) return res.status(404).type('html').send(page('Not found', '<h1>Payment not found</h1>'));
      const back = `/#/bookings/${p.booking_id}?pay=return`;
      if (p.status !== 'pending') {
        return res.type('html').send(page('Payment', `<h1>Payment ${esc(p.status)}</h1><p class="muted">This payment is no longer waiting.</p><a class="btn btn-primary" href="${back}">Back to my booking</a>`));
      }
      res.type('html').send(
        page(
          'Test payment',
          `<h1>Test payment</h1>
<p class="muted">This is a pretend payment page for development. No real money moves.</p>
<dl class="facts"><div class="row"><dt>Amount</dt><dd>${esc(rm(p.amount_cents))}</dd></div>
<div class="row"><dt>Method</dt><dd>${esc(METHOD[p.method ?? ''] ?? 'Online payment')}</dd></div></dl>
<form method="post" action="/fake-pay/${esc(req.params.ref!)}" class="actions">
<button class="btn btn-primary" type="submit" name="outcome" value="success">Pay ${esc(rm(p.amount_cents))}</button>
<button class="btn btn-ghost" type="submit" name="outcome" value="failed">Simulate a declined payment</button>
<button class="btn btn-ghost" type="submit" name="outcome" value="cancelled">Cancel</button>
</form>`,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/:ref', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {
    try {
      const p = await find(req.params.ref!);
      if (!p) return res.status(404).type('html').send(page('Not found', '<h1>Payment not found</h1>'));
      const outcome = req.body?.outcome;
      const type = outcome === 'success' ? 'payment.succeeded' : outcome === 'failed' ? 'payment.failed' : outcome === 'cancelled' ? 'payment.cancelled' : null;
      if (!type) return res.status(400).type('html').send(page('Bad request', '<h1>Unknown choice</h1>'));
      const signed = gateway.signedEvent({
        eventId: `evt_${p.id}_${Date.now()}`,
        gatewayRef: req.params.ref!,
        type,
        amountCents: p.amount_cents,
      });
      await process(signed.raw, signed.headers); // the same code path a real gateway's webhook takes
      res.redirect(303, `/#/bookings/${p.booking_id}?pay=return`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
