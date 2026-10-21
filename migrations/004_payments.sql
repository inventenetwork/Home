-- Step 6: payments. The payments table already exists (001); this adds what a real payment flow needs.
--   payments.status: pending (customer is paying) -> held (we have the money; released to the provider after the job, step 7)
--                    -> refunded (all of it went back) | failed (abandoned, declined or replaced by a newer attempt)

ALTER TABLE payments
  ADD COLUMN paid_at        timestamptz,
  ADD COLUMN failure_reason text;

ALTER TABLE payments
  ADD CONSTRAINT payments_refund_bounds CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents);

CREATE INDEX payments_booking_idx ON payments (booking_id);
-- At most one payment per booking can be holding money at a time.
CREATE UNIQUE INDEX payments_one_held_per_booking ON payments (booking_id) WHERE status = 'held';

-- One row per refund. payments.refunded_cents is the amount we owe back; this table tracks whether the gateway delivered it.
CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','failed')),
  gateway_ref  text,
  created_by   uuid REFERENCES users(id),     -- null = automatic
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
