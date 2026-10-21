-- Uploaded photos and ID documents when STORAGE=db (demo hosting without a file bucket). Unused otherwise.
CREATE TABLE IF NOT EXISTS stored_files (
  key text PRIMARY KEY,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
