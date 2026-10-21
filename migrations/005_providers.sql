-- Step 7: provider onboarding, calendar, job photos, payouts.

ALTER TABLE providers
  ADD COLUMN submitted_at        timestamptz,   -- application sent for review
  ADD COLUMN reviewed_at         timestamptz,
  ADD COLUMN rejection_reason    text,
  ADD COLUMN bank_name           text,
  ADD COLUMN bank_account_name   text,
  ADD COLUMN bank_account_enc    text,          -- account number, encrypted (AES-256-GCM, see src/crypto.ts)
  ADD COLUMN bank_account_last4  text;          -- the only part ever shown back to the provider

-- provider_documents.file_url holds the private storage key, never a public URL.
ALTER TABLE provider_documents
  ADD COLUMN review_note text,
  ADD COLUMN reviewed_at timestamptz;
-- One current file per identity document; a re-upload replaces it.
CREATE UNIQUE INDEX provider_documents_one_per_type ON provider_documents (provider_id, doc_type)
  WHERE doc_type IN ('id_front', 'id_back', 'selfie');

-- Weekly rows need a weekday and a sensible time range; dated rows are time off or special hours.
ALTER TABLE provider_availability
  ADD CONSTRAINT availability_shape CHECK (
    on_date IS NOT NULL
    OR (weekday IS NOT NULL AND start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
  );
CREATE UNIQUE INDEX provider_time_off_one_per_day ON provider_availability (provider_id, on_date)
  WHERE on_date IS NOT NULL AND is_available = false;

-- booking_assignments.checkin_photo_url / checkout_photo_url hold storage keys for the "before" and "after" photos.

-- Payouts: one row per completed job. pending -> requested (provider asks) -> paid (admin has transferred the money).
ALTER TABLE payouts
  ADD COLUMN available_at    timestamptz,       -- the job's dispute window ends here; only then can it be requested
  ADD COLUMN paid_reference  text,              -- bank transfer reference, entered by the admin
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX payouts_one_per_booking ON payouts (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX payouts_provider_idx ON payouts (provider_id, status);
