-- Step 4: booking durations (needed for availability and double-booking checks).

ALTER TABLE services
  ADD COLUMN fixed_minutes    integer NOT NULL DEFAULT 0  CHECK (fixed_minutes >= 0),
  ADD COLUMN minutes_per_unit integer NOT NULL DEFAULT 60 CHECK (minutes_per_unit >= 0);

-- Deep cleaning takes about 4 hours regardless of quantity (it is priced by property size).
UPDATE services SET fixed_minutes = 240, minutes_per_unit = 0 WHERE slug = 'deep-cleaning';

ALTER TABLE services
  ADD CONSTRAINT services_duration_positive CHECK (fixed_minutes + minutes_per_unit > 0);

ALTER TABLE bookings
  ADD COLUMN duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes > 0);

CREATE INDEX bookings_scheduled_idx ON bookings (scheduled_at);
CREATE INDEX booking_assignments_provider_idx ON booking_assignments (provider_id);
