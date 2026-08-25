CREATE TABLE IF NOT EXISTS automation_event_data (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  subpath TEXT NOT NULL DEFAULT 'automation_events',
  blob_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, fingerprint)
);
