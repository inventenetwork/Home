-- Step 8: reviews, disputes, chat, recurring bookings.

-- Recurring plans remember what to book each time. (No card is stored: every visit is paid by the customer, see src/recurring.)
ALTER TABLE recurring_plans
  ADD COLUMN units         integer,
  ADD COLUMN options       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN notes         text,
  ADD COLUMN next_at       timestamptz,                 -- when the next visit would normally be
  ADD COLUMN keep_provider boolean NOT NULL DEFAULT true,  -- offer a visit to the provider who did the last one first
  ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now();
ALTER TABLE recurring_plans ADD CONSTRAINT recurring_sessions_sane CHECK (
  sessions_total IS NULL OR (sessions_total BETWEEN 2 AND 26 AND sessions_remaining BETWEEN 0 AND sessions_total));
CREATE INDEX bookings_plan_idx ON bookings (recurring_plan_id) WHERE recurring_plan_id IS NOT NULL;
CREATE INDEX recurring_customer_idx ON recurring_plans (customer_id);

-- Chat
ALTER TABLE messages ADD CONSTRAINT messages_body_len CHECK (char_length(body) BETWEEN 1 AND 1000);
CREATE TABLE message_reads (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL,
  PRIMARY KEY (booking_id, user_id)
);

-- Reviews
CREATE INDEX reviews_provider_idx ON reviews (provider_id, created_at DESC);
ALTER TABLE reviews ADD CONSTRAINT reviews_comment_len CHECK (comment IS NULL OR char_length(comment) <= 500);

-- Disputes: one open dispute per booking; record how the admin settled it.
CREATE UNIQUE INDEX disputes_one_open ON disputes (booking_id) WHERE status = 'open';
ALTER TABLE disputes
  ADD COLUMN refund_cents    integer,
  ADD COLUMN charge_provider boolean NOT NULL DEFAULT false;
CREATE INDEX disputes_status_idx ON disputes (status, created_at);
