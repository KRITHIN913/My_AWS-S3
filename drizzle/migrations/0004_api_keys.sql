-- Migration: 0004_api_keys
-- api_keys table and api_key_status enum.
-- Safe to re-run: all statements use IF NOT EXISTS.

DO $$ BEGIN
  CREATE TYPE api_key_status AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── api_keys ──────────────────────────────────────────────────────
-- The raw key is NEVER stored. Only the SHA-256 hex hash (key_hash)
-- is persisted. key_prefix holds the first 8 chars for display only.

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash     VARCHAR(64)    NOT NULL UNIQUE,
  key_prefix   VARCHAR(8)     NOT NULL,
  label        VARCHAR(128),
  status       api_key_status NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ak_tenant_idx ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS ak_status_idx ON api_keys(status);
