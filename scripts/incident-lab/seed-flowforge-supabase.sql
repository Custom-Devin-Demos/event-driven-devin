-- Seed data for the flowforge-scheduled-workflows Incident Lab scenario.
-- Idempotent: re-run any time (psql "$SUPABASE_WAREHOUSE_URL" -f this-file).
-- Relative timestamps (Weekly Export created "this week", this morning's
-- dead-lettered job) are recomputed from now() on every run, so re-run it
-- shortly before arming so the DLQ rows line up with the backdated burst.

begin;

create schema if not exists flowforge;

create table if not exists flowforge.organizations (
  id text primary key,
  name text not null,
  plan text not null default 'team',
  created_at timestamptz not null default now()
);

create table if not exists flowforge.projects (
  id text primary key,
  slug text not null unique,
  org_id text not null references flowforge.organizations (id),
  region text not null,
  created_at timestamptz not null default now()
);

create table if not exists flowforge.tenant_storage_configs (
  project_id text primary key references flowforge.projects (id),
  provider text not null check (provider in ('platform', 'byo_s3')),
  endpoint text,
  base_bucket text,
  storage_region text,
  updated_at timestamptz not null default now()
);

create table if not exists flowforge.workflows (
  id text primary key,
  project_id text not null references flowforge.projects (id),
  name text not null,
  trigger_type text not null check (trigger_type in ('schedule', 'webhook', 'manual')),
  schedule_cron text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists flowforge.schedule_cursors (
  workflow_id text primary key references flowforge.workflows (id),
  last_matched_occurrence_at timestamptz,
  last_advanced_at timestamptz
);

create table if not exists flowforge.queue_jobs (
  job_id text primary key,
  queue text not null,
  tick_id text not null,
  attempts integer not null default 0,
  max_receive_count integer not null default 8,
  status text not null check (status in ('queued', 'in_flight', 'completed', 'dead_lettered')),
  last_error_class text,
  first_received_at timestamptz,
  last_received_at timestamptz,
  dead_lettered_at timestamptz
);

create table if not exists flowforge.queue_job_deliveries (
  job_id text not null references flowforge.queue_jobs (job_id),
  attempt integer not null,
  received_at timestamptz not null,
  outcome text not null check (outcome in ('completed', 'returned_to_queue', 'dead_lettered')),
  primary key (job_id, attempt)
);

-- Organizations -------------------------------------------------------------
insert into flowforge.organizations (id, name, plan, created_at) values
  ('org_meridianfx',  'MeridianFX',           'enterprise', now() - interval '14 months'),
  ('org_northwind',   'Northwind Analytics',  'enterprise', now() - interval '3 years'),
  ('org_acme',        'Acme Billing',         'team',       now() - interval '2 years'),
  ('org_lumen',       'Lumen Retail',         'enterprise', now() - interval '20 months'),
  ('org_helios',      'Helios Health',        'team',       now() - interval '9 months'),
  ('org_kestrel',     'Kestrel Logistics',    'team',       now() - interval '16 months'),
  ('org_orbital',     'Orbital Media',        'starter',    now() - interval '5 months'),
  ('org_tidewater',   'Tidewater Insurance',  'enterprise', now() - interval '28 months')
on conflict (id) do update set name = excluded.name, plan = excluded.plan;

-- Projects ------------------------------------------------------------------
insert into flowforge.projects (id, slug, org_id, region, created_at) values
  ('proj_01hmfx', 'prj_meridianfx_eu',    'org_meridianfx', 'eu-central-1', now() - interval '13 months'),
  ('proj_01hnw1', 'prj-northwind-analytics', 'org_northwind', 'us-east-1',  now() - interval '3 years'),
  ('proj_01hnw2', 'prj-northwind-staging', 'org_northwind', 'us-east-1',    now() - interval '2 years'),
  ('proj_01hacm', 'prj-acme-billing',     'org_acme',       'us-east-1',    now() - interval '2 years'),
  ('proj_01hlum', 'prj-lumen-retail',     'org_lumen',      'us-west-2',    now() - interval '20 months'),
  ('proj_01hhel', 'prj-helios-health',    'org_helios',     'us-east-1',    now() - interval '9 months'),
  ('proj_01hkes', 'prj-kestrel-logistics','org_kestrel',    'eu-west-1',    now() - interval '16 months'),
  ('proj_01horb', 'prj-orbital-media',    'org_orbital',    'us-west-2',    now() - interval '5 months'),
  ('proj_01htid', 'prj-tidewater-ins',    'org_tidewater',  'us-east-1',    now() - interval '28 months')
on conflict (id) do update set slug = excluded.slug, org_id = excluded.org_id, region = excluded.region;

-- Tenant storage: exactly one bring-your-own row (meridianfx) ---------------
insert into flowforge.tenant_storage_configs (project_id, provider, endpoint, base_bucket, storage_region, updated_at)
select id, 'platform', null, null, null, now() - interval '30 days'
from flowforge.projects
where slug <> 'prj_meridianfx_eu'
on conflict (project_id) do update
  set provider = excluded.provider, endpoint = null, base_bucket = null, storage_region = null;

insert into flowforge.tenant_storage_configs (project_id, provider, endpoint, base_bucket, storage_region, updated_at) values
  ('proj_01hmfx', 'byo_s3', 'https://minio.storage.meridianfx.internal:9000', 'flowforge-artifacts', 'eu-central-1', now() - interval '11 days')
on conflict (project_id) do update
  set provider = excluded.provider, endpoint = excluded.endpoint,
      base_bucket = excluded.base_bucket, storage_region = excluded.storage_region,
      updated_at = excluded.updated_at;

-- Workflows -----------------------------------------------------------------
insert into flowforge.workflows (id, project_id, name, trigger_type, schedule_cron, active, created_at, updated_at) values
  -- meridianfx: the new weekly export plus healthy non-scheduled workflows
  ('wf_mfx_weekly_export',  'proj_01hmfx', 'Weekly Export',                 'schedule', '0 6 * * 1',   true,  now() - interval '5 days',    now() - interval '5 days'),
  ('wf_mfx_trade_webhook',  'proj_01hmfx', 'Trade Confirmation Intake',     'webhook',  null,          true,  now() - interval '11 months', now() - interval '2 months'),
  ('wf_mfx_manual_recon',   'proj_01hmfx', 'Ad-hoc Reconciliation',         'manual',   null,          true,  now() - interval '8 months',  now() - interval '8 months'),
  -- other tenants: hourly/daily schedules that share ticks with the weekly export
  ('wf_nwa_hourly_sync',    'proj_01hnw1', 'Hourly Warehouse Sync',         'schedule', '0 * * * *',   true,  now() - interval '2 years',   now() - interval '40 days'),
  ('wf_nwa_daily_report',   'proj_01hnw1', 'Daily KPI Report',              'schedule', '0 6 * * *',   true,  now() - interval '2 years',   now() - interval '3 months'),
  ('wf_nws_nightly_seed',   'proj_01hnw2', 'Nightly Staging Seed',          'schedule', '0 2 * * *',   true,  now() - interval '1 year',    now() - interval '1 year'),
  ('wf_acm_hourly_invoice', 'proj_01hacm', 'Hourly Invoice Batch',          'schedule', '0 * * * *',   true,  now() - interval '18 months', now() - interval '6 weeks'),
  ('wf_acm_dunning',        'proj_01hacm', 'Daily Dunning Run',             'schedule', '0 6 * * *',   true,  now() - interval '14 months', now() - interval '14 months'),
  ('wf_acm_stripe_webhook', 'proj_01hacm', 'Stripe Event Intake',           'webhook',  null,          true,  now() - interval '2 years',   now() - interval '5 months'),
  ('wf_lum_inventory',      'proj_01hlum', 'Inventory Snapshot',            'schedule', '0 */6 * * *', true,  now() - interval '19 months', now() - interval '2 weeks'),
  ('wf_lum_order_webhook',  'proj_01hlum', 'Order Created Hook',            'webhook',  null,          true,  now() - interval '19 months', now() - interval '19 months'),
  ('wf_hel_daily_export',   'proj_01hhel', 'Daily Claims Export',           'schedule', '0 6 * * *',   true,  now() - interval '8 months',  now() - interval '8 months'),
  ('wf_hel_manual_audit',   'proj_01hhel', 'Manual Audit Pull',             'manual',   null,          true,  now() - interval '6 months',  now() - interval '6 months'),
  ('wf_kes_hourly_eta',     'proj_01hkes', 'Hourly ETA Recompute',          'schedule', '0 * * * *',   true,  now() - interval '15 months', now() - interval '3 weeks'),
  ('wf_kes_tracking_hook',  'proj_01hkes', 'Carrier Tracking Webhook',      'webhook',  null,          true,  now() - interval '15 months', now() - interval '15 months'),
  ('wf_orb_daily_digest',   'proj_01horb', 'Daily Audience Digest',         'schedule', '30 6 * * *',  true,  now() - interval '4 months',  now() - interval '4 months'),
  ('wf_orb_old_weekly',     'proj_01horb', 'Weekly Sponsor Report (old)',   'schedule', '0 7 * * 1',   false, now() - interval '5 months',  now() - interval '6 weeks'),
  ('wf_tid_hourly_quotes',  'proj_01htid', 'Hourly Quote Refresh',          'schedule', '0 * * * *',   true,  now() - interval '2 years',   now() - interval '2 months'),
  ('wf_tid_fnol_webhook',   'proj_01htid', 'FNOL Intake Webhook',           'webhook',  null,          true,  now() - interval '2 years',   now() - interval '9 months')
on conflict (id) do update
  set project_id = excluded.project_id, name = excluded.name, trigger_type = excluded.trigger_type,
      schedule_cron = excluded.schedule_cron, active = excluded.active,
      created_at = excluded.created_at, updated_at = excluded.updated_at;

-- Schedule cursors: every active schedule stopped advancing about an hour ago
insert into flowforge.schedule_cursors (workflow_id, last_matched_occurrence_at, last_advanced_at)
select id,
       date_trunc('hour', now()) - interval '1 hour',
       date_trunc('minute', now()) - interval '61 minutes'
from flowforge.workflows
where trigger_type = 'schedule' and active
on conflict (workflow_id) do update
  set last_matched_occurrence_at = excluded.last_matched_occurrence_at,
      last_advanced_at = excluded.last_advanced_at;

-- This morning's dead-lettered job (the customer's manual test of the new export)
insert into flowforge.queue_jobs (job_id, queue, tick_id, attempts, max_receive_count, status, last_error_class, first_received_at, last_received_at, dead_lettered_at) values
  ('job_01j8mfxtest', 'schedule-ingest', 'tick_manual_01j8mfx', 8, 8, 'dead_lettered', 'S3UploadError',
   now() - interval '2 hours', now() - interval '2 hours' + interval '770 seconds', now() - interval '2 hours' + interval '770 seconds')
on conflict (job_id) do update
  set attempts = excluded.attempts, status = excluded.status, last_error_class = excluded.last_error_class,
      first_received_at = excluded.first_received_at, last_received_at = excluded.last_received_at,
      dead_lettered_at = excluded.dead_lettered_at;

insert into flowforge.queue_job_deliveries (job_id, attempt, received_at, outcome)
select 'job_01j8mfxtest', n,
       now() - interval '2 hours' + (n - 1) * interval '110 seconds',
       case when n = 8 then 'dead_lettered' else 'returned_to_queue' end
from generate_series(1, 8) as n
on conflict (job_id, attempt) do update
  set received_at = excluded.received_at, outcome = excluded.outcome;

commit;

-- Verification --------------------------------------------------------------
\echo
\echo '== project slug'
select p.slug, p.region, o.name as org from flowforge.projects p join flowforge.organizations o on o.id = p.org_id order by p.slug;
\echo '== storage rows (byo_s3)'
select p.slug, s.provider, s.endpoint, s.base_bucket, s.storage_region from flowforge.tenant_storage_configs s join flowforge.projects p on p.id = s.project_id where s.provider = 'byo_s3';
\echo '== active scheduled workflows'
select p.slug, w.name, w.schedule_cron, w.created_at::date as created from flowforge.workflows w join flowforge.projects p on p.id = w.project_id where w.trigger_type = 'schedule' and w.active order by p.slug, w.name;
\echo '== dead-lettered job'
select job_id, attempts || '/' || max_receive_count as attempts, status, last_error_class, first_received_at, dead_lettered_at from flowforge.queue_jobs where status = 'dead_lettered';
