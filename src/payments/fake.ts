import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  GatewayError,
  type ChargeRequest,
  type ChargeResult,
  type GatewayEvent,
  type PaymentGateway,
  type RefundRequest,
  type RefundResult,
} from './gateway.js';

const eventSchema = z.object({
  eventId: z.string().min(1).max(100),
  gatewayRef: z.string().min(1).max(100),
  type: z.enum(['payment.succeeded', 'payment.failed', 'payment.cancelled']),
  amountCents: z.number().int().nonnegative(),
});

/**
 * A pretend gateway for development and tests. No money moves.
 * It behaves like a real one: a hosted payment page the customer is sent to (see fake-page.ts), and a signed
 * webhook back to us. Because the webhook is signed and verified exactly as a real one would be, the payment code
 * that runs against this is the code that will run against the real gateway.
 */
export class FakeGateway implements PaymentGateway {
  readonly name = 'fake';
  /** Tests flip this to see what happens when the gateway refuses a refund. */
  failRefunds = false;
  readonly refundCalls: RefundRequest[] = [];

  constructor(private readonly secret: string) {}

  sign(raw: string | Buffer): string {
    return createHmac('sha256', this.secret).update(raw).digest('hex');
  }

  /** A signed webhook, as the gateway would send it. */
  signedEvent(event: GatewayEvent): { raw: Buffer; headers: Record<string, string> } {
    const raw = Buffer.from(JSON.stringify(event));
    return { raw, headers: { 'content-type': 'application/json', 'x-signature': this.sign(raw) } };
  }

  async createCharge(_req: ChargeRequest): Promise<ChargeResult> {
    const ref = `fake_${randomBytes(12).toString('hex')}`;
    return { gatewayRef: ref, redirectUrl: `/fake-pay/${ref}` };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayEvent {
    const given = headers['x-signature'];
    const sig = Array.isArray(given) ? given[0] : given;
    if (!sig) throw new GatewayError('bad_signature', 'Missing signature');
    const want = Buffer.from(this.sign(rawBody));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new GatewayError('bad_signature', 'Bad signature');
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new GatewayError('bad_payload', 'Not JSON');
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) throw new GatewayError('bad_payload', 'Unexpected event shape');
    return parsed.data;
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    this.refundCalls.push(req);
    if (this.failRefunds) throw new GatewayError('refund_failed', 'Fake gateway refused the refund');
    return { gatewayRef: `fakerf_${randomBytes(8).toString('hex')}`, status: 'succeeded' };
  }
}

/** A stable secret for the fake gateway, derived from JWT_SECRET so there is nothing extra to configure. */
export function fakeGatewaySecret(jwtSecret: string): string {
  return createHmac('sha256', jwtSecret).update('fake-gateway-v1').digest('hex');
}
