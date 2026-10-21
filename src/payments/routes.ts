import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { loadBookingSettings } from '../bookings/settings.js';
import type { Db } from '../db/index.js';
import { GatewayError, type PaymentGateway } from './gateway.js';
import { applyGatewayEvent, PaymentError, startPayment, type EventResult } from './service.js';

const UUID = z.string().uuid();
const payBody = z.object({ method: z.enum(['fpx', 'ewallet']) }).strict();

const PAYMENT_ERROR_STATUS: Record<PaymentError['code'], number> = {
  booking_not_found: 404,
  booking_not_payable: 409,
  booking_expired: 409,
  gateway_unavailable: 502,
  nothing_to_refund: 409,
  refund_too_large: 400,
};
export const paymentErrorStatus = (err: PaymentError) => PAYMENT_ERROR_STATUS[err.code];

/** POST /bookings/:id/pay — mounted under /bookings behind requireAuth. */
export function bookingPaymentsRouter(db: Db, gateway: PaymentGateway, now: () => Date): Router {
  const router = Router();
  router.post('/:id/pay', async (req, res, next) => {
    try {
      const id = UUID.safeParse(req.params.id);
      const body = payBody.safeParse(req.body ?? {});
      if (!id.success) return res.status(404).json({ error: 'not_found' });
      if (!body.success) return res.status(400).json({ error: 'invalid_request', message: 'Choose FPX or e-wallet.' });
      const settings = await loadBookingSettings(db);
      try {
        const started = await startPayment(db, gateway, { bookingId: id.data, customerId: req.user!.id, method: body.data.method }, now(), settings);
        res.status(201).json(started);
      } catch (err) {
        if (err instanceof PaymentError) return res.status(paymentErrorStatus(err)).json({ error: err.code, message: err.message });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });
  return router;
}

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The gateway's message that a payment succeeded, failed or was cancelled. Not logged-in traffic: the only proof it is
 * genuine is the signature, which the gateway adapter checks over the exact bytes received.
 */
export function createWebhookProcessor(db: Db, gateway: PaymentGateway, now: () => Date) {
  return async function process(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookReply> {
    let event;
    try {
      event = gateway.parseWebhook(raw, headers);
    } catch (err) {
      if (err instanceof GatewayError) return { status: err.code === 'bad_signature' ? 401 : 400, body: { error: err.code } };
      throw err;
    }
    const settings = await loadBookingSettings(db);
    const result: EventResult = await applyGatewayEvent(db, gateway, event, now(), settings);
    // Unknown payment or a wrong amount: a non-2xx makes the gateway retry and makes the problem visible on their side.
    if (result === 'unknown_payment') return { status: 404, body: { error: 'unknown_payment' } };
    if (result === 'amount_mismatch') return { status: 422, body: { error: 'amount_mismatch' } };
    return { status: 200, body: { received: true, result } };
  };
}

/** Express handler for POST /payments/webhook. Must be mounted BEFORE express.json(), with express.raw(). */
export function webhookHandler(process: ReturnType<typeof createWebhookProcessor>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'bad_payload' });
      const reply = await process(req.body, req.headers);
      res.status(reply.status).json(reply.body);
    } catch (err) {
      next(err);
    }
  };
}
