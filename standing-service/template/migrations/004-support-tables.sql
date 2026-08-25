CREATE TABLE IF NOT EXISTS feature_flags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  org_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (name, org_id)
);

CREATE TABLE IF NOT EXISTS storage_cloud_provider_configs (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS vpc_deployments (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
