CREATE TABLE IF NOT EXISTS automation_queued_events (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'failed', 'completed')),
  error_message TEXT,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_queued_events_pending
  ON automation_queued_events (id) WHERE status = 'pending';
