-- Migration: 0001_initial_schema
-- Tenants, buckets, usage_metrics and their supporting enums.
-- Safe to re-run: all statements use IF NOT EXISTS.

DO $$ BEGIN
  CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bucket_status AS ENUM ('provisioning', 'active', 'suspended', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE event_type AS ENUM (
    'bucket_created',
    'bucket_deleted',
    'storage_recorded',
    'data_in',
    'data_out',
    'api_request'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── tenants ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     VARCHAR(63)  NOT NULL UNIQUE,
  display_name             VARCHAR(255) NOT NULL,
  email                    VARCHAR(320) NOT NULL UNIQUE,
  status                   tenant_status NOT NULL DEFAULT 'active',
  max_buckets              INTEGER      NOT NULL DEFAULT 10,
  max_storage_bytes        BIGINT       NOT NULL DEFAULT 107374182400,
  max_monthly_ingress_bytes BIGINT      NOT NULL DEFAULT 10737418240,
  max_monthly_egress_bytes  BIGINT      NOT NULL DEFAULT 10737418240,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ
);

-- ─── buckets ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS buckets (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name                  VARCHAR(63)  NOT NULL,
  physical_name         VARCHAR(128) NOT NULL UNIQUE,
  status                bucket_status NOT NULL DEFAULT 'provisioning',
  access_policy         VARCHAR(64)  NOT NULL DEFAULT 'private',
  versioning_enabled    BOOLEAN      NOT NULL DEFAULT FALSE,
  last_known_size_bytes BIGINT       NOT NULL DEFAULT 0,
  last_size_snapshot_at TIMESTAMPTZ,
  region                VARCHAR(64)  NOT NULL DEFAULT 'us-east-1',
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS buckets_tenant_id_name_unique ON buckets(tenant_id, name);
CREATE INDEX IF NOT EXISTS buckets_tenant_id_idx ON buckets(tenant_id);
CREATE INDEX IF NOT EXISTS buckets_status_idx    ON buckets(status);

-- ─── usage_metrics ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_metrics (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  bucket_id        UUID         REFERENCES buckets(id) ON DELETE SET NULL,
  event_type       event_type   NOT NULL,
  bytes            BIGINT       NOT NULL DEFAULT 0,
  request_count    INTEGER      NOT NULL DEFAULT 1,
  billing_period   VARCHAR(7)   NOT NULL,
  metadata         TEXT,
  idempotency_key  VARCHAR(128) UNIQUE,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  recorded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_metrics_tenant_period_idx ON usage_metrics(tenant_id, billing_period);
CREATE INDEX IF NOT EXISTS usage_metrics_bucket_id_idx     ON usage_metrics(bucket_id);
CREATE INDEX IF NOT EXISTS usage_metrics_event_type_idx    ON usage_metrics(event_type);
CREATE INDEX IF NOT EXISTS usage_metrics_occurred_at_idx   ON usage_metrics(occurred_at);
