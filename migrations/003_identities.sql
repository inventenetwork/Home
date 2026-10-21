-- Social sign-in (Google now, Apple later). One user can have several identities; one identity belongs to one user.
CREATE TABLE user_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('google', 'apple')),
  subject       text NOT NULL,                -- the provider's stable user id ("sub"); never the email
  email         text NOT NULL,                -- email the provider reported when this identity was linked
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (provider, subject)
);

CREATE INDEX user_identities_user_idx ON user_identities (user_id);
