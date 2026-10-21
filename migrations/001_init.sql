-- Home360 initial schema. All money is stored as integer sen (RM 1.00 = 100).

-- ───────────── Identity & auth ─────────────
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  phone       text,
  full_name   text,
  role        text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','provider','admin')),
  locale      text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ms','zh')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  consent_at  timestamptz,                 -- PDPA consent timestamp
  deleted_at  timestamptz,                 -- PDPA deletion request fulfilled
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  code_hash    text NOT NULL,              -- HMAC of the 6-digit code, never the code itself
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_email_idx ON otp_codes (email, created_at DESC);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ───────────── Geography ─────────────
CREATE TABLE areas (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug    text NOT NULL UNIQUE,
  name    text NOT NULL,
  state   text NOT NULL,
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE addresses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          text NOT NULL DEFAULT 'Home',
  line1          text NOT NULL,
  line2          text,
  postcode       text NOT NULL,
  area_id        uuid REFERENCES areas(id),
  lat            double precision,
  lng            double precision,
  property_type  text CHECK (property_type IN ('apartment','terrace','semi_d','bungalow','other')),
  size_sqft      integer,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id);

-- ───────────── Providers ─────────────
CREATE TABLE providers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  vetting_status   text NOT NULL DEFAULT 'pending' CHECK (vetting_status IN ('pending','approved','rejected','suspended')),
  bio              text,
  rating_avg       numeric(3,2) NOT NULL DEFAULT 0,
  rating_count     integer NOT NULL DEFAULT 0,
  jobs_completed   integer NOT NULL DEFAULT 0,
  offers_received  integer NOT NULL DEFAULT 0,
  offers_accepted  integer NOT NULL DEFAULT 0,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  doc_type      text NOT NULL CHECK (doc_type IN ('id_front','id_back','selfie','certificate','other')),
  file_url      text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_areas (
  provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  area_id      uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  PRIMARY KEY (provider_id, area_id)
);

CREATE TABLE provider_availability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  weekday      smallint CHECK (weekday BETWEEN 0 AND 6),      -- 0 = Sunday; NULL for one-off exceptions
  start_time   time,
  end_time     time,
  on_date      date,                                           -- set for one-off exceptions
  is_available boolean NOT NULL DEFAULT true                   -- false = time off on on_date
);
CREATE INDEX provider_availability_idx ON provider_availability (provider_id);

-- ───────────── Service catalogue ─────────────
-- New services (grass cutting, glass cleaning, ...) are rows here: no schema change needed.
CREATE TABLE services (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE,
  name_en        text NOT NULL,
  name_ms        text NOT NULL,
  description_en text,
  description_ms text,
  pricing_model  text NOT NULL CHECK (pricing_model IN ('hourly','per_unit','per_size','quote')),
  base_price_cents integer NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0),  -- per hour / per unit; 0 for per_size and quote
  unit_label     text,                       -- e.g. 'hour', 'unit', 'basket'
  min_units      integer NOT NULL DEFAULT 1, -- e.g. 2 for a 2-hour minimum
  phase          smallint NOT NULL DEFAULT 1,
  active         boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_options (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('choice','addon','size')),
  group_key     text NOT NULL,               -- e.g. 'aircon_type', 'tools', 'property_size'
  code          text NOT NULL,
  label_en      text NOT NULL,
  label_ms      text NOT NULL,
  price_cents   integer NOT NULL DEFAULT 0,  -- added to (choice/addon) or replaces (size) the base price
  per_unit      boolean NOT NULL DEFAULT false, -- true = multiplied by units (e.g. per aircon unit)
  is_default    boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (service_id, group_key, code)
);

CREATE TABLE skills (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text NOT NULL UNIQUE,
  name  text NOT NULL
);
CREATE TABLE service_skills (
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  skill_id   uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, skill_id)
);
CREATE TABLE provider_skills (
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  skill_id    uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (provider_id, skill_id)
);

-- ───────────── Bookings ─────────────
CREATE TABLE recurring_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL REFERENCES users(id),
  service_id            uuid NOT NULL REFERENCES services(id),
  address_id            uuid NOT NULL REFERENCES addresses(id),
  frequency             text NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly')),
  sessions_total        integer,
  sessions_remaining    integer,
  preferred_provider_id uuid REFERENCES providers(id),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','completed')),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES users(id),
  service_id       uuid NOT NULL REFERENCES services(id),
  address_id       uuid NOT NULL REFERENCES addresses(id),
  recurring_plan_id uuid REFERENCES recurring_plans(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN
                     ('pending','offered','confirmed','on_the_way','in_progress','completed','paid_out','cancelled','disputed')),
  scheduled_at     timestamptz NOT NULL,
  units            integer NOT NULL DEFAULT 1,        -- hours / aircon units / baskets
  notes            text,
  subtotal_cents   integer NOT NULL DEFAULT 0,
  sst_cents        integer NOT NULL DEFAULT 0,
  total_cents      integer NOT NULL DEFAULT 0,
  commission_rate  numeric(5,4) NOT NULL DEFAULT 0.2000,   -- snapshot at booking time
  price_breakdown  jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancelled_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_customer_idx ON bookings (customer_id, scheduled_at DESC);
CREATE INDEX bookings_status_idx ON bookings (status);

CREATE TABLE booking_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  option_id   uuid REFERENCES service_options(id),
  label       text NOT NULL,                 -- snapshot of the label at booking time
  qty         integer NOT NULL DEFAULT 1,
  price_cents integer NOT NULL DEFAULT 0
);

CREATE TABLE job_offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  provider_id  uuid NOT NULL REFERENCES providers(id),
  status       text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','expired','withdrawn')),
  offered_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (booking_id, provider_id)
);

CREATE TABLE booking_assignments (
  booking_id    uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL REFERENCES providers(id),
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  checkin_photo_url  text,
  checkout_photo_url text
);

-- ───────────── Money ─────────────
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES bookings(id),
  gateway       text NOT NULL,                      -- 'billplz', 'toyyibpay', ...
  gateway_ref   text,
  method        text CHECK (method IN ('fpx','ewallet')),
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','held','released','refunded','failed')),
  refunded_cents integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_ref)
);

CREATE TABLE payouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      uuid NOT NULL REFERENCES providers(id),
  booking_id       uuid REFERENCES bookings(id),
  gross_cents      integer NOT NULL,
  commission_cents integer NOT NULL,
  net_cents        integer NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','requested','paid','failed')),
  requested_at     timestamptz,
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Communication & trust ─────────────
CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_booking_idx ON messages (booking_id, created_at);

CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES providers(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id),
  opened_by   uuid NOT NULL REFERENCES users(id),
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_refund','resolved_redo','rejected')),
  resolution_note text,
  resolved_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- ───────────── Admin ─────────────
CREATE TABLE app_config (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
