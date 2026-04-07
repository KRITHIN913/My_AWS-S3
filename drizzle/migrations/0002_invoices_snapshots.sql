-- Migration: 0002_invoices_snapshots
-- invoices, quota_breach_events, webhook_deliveries, usage_snapshots
-- and their supporting enums.
-- Safe to re-run: all statements use IF NOT EXISTS.

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft', 'finalised', 'void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE breach_type AS ENUM (
    'storage_warning', 'storage_exceeded',
    'ingress_warning',  'ingress_exceeded',
    'egress_warning',   'egress_exceeded',
    'bucket_warning',   'bucket_exceeded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE webhook_status AS ENUM ('pending', 'success', 'failed', 'retrying');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── invoices ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoices (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  billing_period       VARCHAR(7)    NOT NULL,
  status               invoice_status NOT NULL DEFAULT 'draft',
  storage_byte_avg     BIGINT        NOT NULL DEFAULT 0,
  ingress_bytes        BIGINT        NOT NULL DEFAULT 0,
  egress_bytes         BIGINT        NOT NULL DEFAULT 0,
  bucket_count         INTEGER       NOT NULL DEFAULT 0,
  api_request_count    INTEGER       NOT NULL DEFAULT 0,
  total_charge_ucents  BIGINT        NOT NULL DEFAULT 0,
  currency             VARCHAR(3)    NOT NULL DEFAULT 'USD',
  generated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finalised_at         TIMESTAMPTZ,
  line_items_json      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_period_unique ON invoices(tenant_id, billing_period);
CREATE INDEX IF NOT EXISTS invoices_tenant_id_idx ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx    ON invoices(status);

-- ─── quota_breach_events ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quota_breach_events (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  breach_type           breach_type  NOT NULL,
  current_value         BIGINT       NOT NULL,
  limit_value           BIGINT       NOT NULL,
  billing_period        VARCHAR(7),
  detected_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  webhook_dispatched    BOOLEAN      NOT NULL DEFAULT FALSE,
  webhook_dispatched_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS qbe_tenant_breach_idx
  ON quota_breach_events(tenant_id, breach_type, billing_period);

-- ─── webhook_deliveries ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_url    VARCHAR(2048)  NOT NULL,
  event_type      VARCHAR(64)    NOT NULL,
  payload         TEXT           NOT NULL,
  status          webhook_status NOT NULL DEFAULT 'pending',
  attempt_count   INTEGER        NOT NULL DEFAULT 0,
  max_attempts    INTEGER        NOT NULL DEFAULT 5,
  last_attempt_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error      TEXT,
  next_retry_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wd_pending_retry_idx ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS wd_tenant_idx         ON webhook_deliveries(tenant_id);

-- ─── usage_snapshots ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket_id    UUID        NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  bytes_stored BIGINT      NOT NULL,
  snapped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS us_tenant_time_idx ON usage_snapshots(tenant_id, snapped_at);
CREATE INDEX IF NOT EXISTS us_bucket_time_idx ON usage_snapshots(bucket_id, snapped_at);
