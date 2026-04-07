-- Migration: 0003_plans_audit
-- plans table, audit_log table, audit_log_action enum.
-- ALTERs tenants to add plan_id, webhook_endpoint_url, webhook_secret,
-- and deleted_at (added in Phase 3 soft-delete work).
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

DO $$ BEGIN
  CREATE TYPE audit_log_action AS ENUM (
    'tenant.created',
    'tenant.updated',
    'tenant.suspended',
    'tenant.deleted',
    'tenant.plan_changed',
    'invoice.voided',
    'plan.created',
    'plan.updated',
    'quota.overridden'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── plans ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plans (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      VARCHAR(64)  NOT NULL UNIQUE,
  max_buckets               INTEGER      NOT NULL,
  max_storage_bytes         BIGINT       NOT NULL,
  max_monthly_ingress_bytes BIGINT       NOT NULL,
  max_monthly_egress_bytes  BIGINT       NOT NULL,
  price_ucents_per_month    BIGINT       NOT NULL DEFAULT 0,
  is_active                 BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── ALTER tenants — add Phase 3 & 4 columns ───────────────────────

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id) ON DELETE SET NULL;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_endpoint_url VARCHAR(2048);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(128);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ─── audit_log ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  action      audit_log_action  NOT NULL,
  admin_id    VARCHAR(128)      NOT NULL,
  target_type VARCHAR(32)       NOT NULL,
  target_id   UUID              NOT NULL,
  before      TEXT,
  after       TEXT,
  ip          VARCHAR(45),
  occurred_at TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS al_action_idx   ON audit_log(action);
CREATE INDEX IF NOT EXISTS al_target_idx   ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS al_admin_idx    ON audit_log(admin_id);
CREATE INDEX IF NOT EXISTS al_occurred_idx ON audit_log(occurred_at);
