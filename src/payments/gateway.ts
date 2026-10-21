/**
 * What the rest of the app needs from a payment gateway. Billplz, Toyyibpay, Stripe and so on each get one small
 * adapter that implements this; nothing else in the code base knows which gateway is in use.
 * All amounts are integer sen (RM 1.00 = 100).
 */

export type PaymentMethod = 'fpx' | 'ewallet';

export interface ChargeRequest {
  paymentId: string; // our id; send it to the gateway as the merchant reference
  bookingId: string;
  amountCents: number;
  method: PaymentMethod;
  description: string;
}

export interface ChargeResult {
  gatewayRef: string; // the gateway's id for this charge
  redirectUrl: string; // where to send the customer to pay (absolute, or a path on this server)
}

/** What a gateway tells us happened. Parsed (and signature-checked) by the adapter. */
export interface GatewayEvent {
  eventId: string;
  gatewayRef: string;
  type: 'payment.succeeded' | 'payment.failed' | 'payment.cancelled';
  amountCents: number;
}

export interface RefundRequest {
  paymentGatewayRef: string;
  refundId: string; // our id; also the idempotency key, so a retry never refunds twice
  amountCents: number;
  reason: string;
}

export interface RefundResult {
  gatewayRef: string;
  status: 'succeeded' | 'pending';
}

export class GatewayError extends Error {
  constructor(
    public readonly code: 'bad_signature' | 'bad_payload' | 'unavailable' | 'refund_failed',
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface PaymentGateway {
  /** Stored in payments.gateway. */
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  /** Verify the gateway's signature over the raw request body, then return the event. Throws GatewayError if it is not genuine. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayEvent;
  /** Throws GatewayError('refund_failed') if the gateway declines. */
  refund(req: RefundRequest): Promise<RefundResult>;
}
