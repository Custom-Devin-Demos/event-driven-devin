CREATE TABLE IF NOT EXISTS automation_triggers (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'schedule:recurring',
  interval_s INTEGER NOT NULL DEFAULT 300,
  next_fire_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_triggers_due
  ON automation_triggers (next_fire_at) WHERE enabled;
