// src/drizzle/schema.ts
/**
 * src/db/schema.ts
 *
 * Project 5 — Multi-Tenant Usage Metering & Billing Engine
 *
 * Schema Design Principles
 * ────────────────────────
 * 1. Multi-tenant isolation enforced at the DB layer. Every resource row
 *    carries a tenant_id FK.
 * 2. usage_metrics is an APPEND-ONLY event log.
 * 3. Byte values use bigint — no float precision drift.
 * 4. Timestamps are timestamptz. Always store UTC.
 * 5. pgEnum for status/event_type so Postgres enforces the domain.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  bigint,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────
// Enums — Phases 1-3
// ─────────────────────────────────────────────────────────────

export const tenantStatusEnum = pgEnum('tenant_status', [
  'active',
  'suspended',
  'deleted',
]);

export const bucketStatusEnum = pgEnum('bucket_status', [
  'provisioning',
  'active',
  'suspended',
  'deleted',
]);

export const eventTypeEnum = pgEnum('event_type', [
  'bucket_created',
  'bucket_deleted',
  'storage_recorded',
  'data_in',
  'data_out',
  'api_request',
]);

// ─────────────────────────────────────────────────────────────
// Enums — Phase 4
// ─────────────────────────────────────────────────────────────

export const auditLogActionEnum = pgEnum('audit_log_action', [
  'tenant.created',
  'tenant.updated',
  'tenant.suspended',
  'tenant.deleted',
  'tenant.plan_changed',
  'invoice.voided',
  'plan.created',
  'plan.updated',
  'quota.overridden',
]);

// ─────────────────────────────────────────────────────────────
// Phase 4 — plans
// ─────────────────────────────────────────────────────────────

export const plans = pgTable('plans', {
  id:   uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: varchar('name', { length: 64 }).notNull().unique(),

  maxBuckets:             integer('max_buckets').notNull(),
  maxStorageBytes:        bigint('max_storage_bytes',         { mode: 'bigint' }).notNull(),
  maxMonthlyIngressBytes: bigint('max_monthly_ingress_bytes', { mode: 'bigint' }).notNull(),
  maxMonthlyEgressBytes:  bigint('max_monthly_egress_bytes',  { mode: 'bigint' }).notNull(),

  priceUcentsPerMonth: bigint('price_ucents_per_month', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────
// tenants
// ─────────────────────────────────────────────────────────────

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

  slug: varchar('slug', { length: 63 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  status: tenantStatusEnum('status').notNull().default('active'),

  /** FK to plans — nullable, existing tenants may predate plans. */
  planId: uuid('plan_id').references(() => plans.id, { onDelete: 'set null' }),

  maxBuckets: integer('max_buckets').notNull().default(10),
  maxStorageBytes: bigint('max_storage_bytes', { mode: 'bigint' })
    .notNull()
    .default(sql`107374182400`),
  maxMonthlyIngressBytes: bigint('max_monthly_ingress_bytes', { mode: 'bigint' })
    .notNull()
    .default(sql`10737418240`),
  maxMonthlyEgressBytes: bigint('max_monthly_egress_bytes', { mode: 'bigint' })
    .notNull()
    .default(sql`10737418240`),

  webhookEndpointUrl: varchar('webhook_endpoint_url', { length: 2048 }),
  webhookSecret:      varchar('webhook_secret',       { length: 128 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// ─────────────────────────────────────────────────────────────
// buckets
// ─────────────────────────────────────────────────────────────

export const buckets = pgTable(
  'buckets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
    name:         varchar('name',          { length: 63  }).notNull(),
    physicalName: varchar('physical_name', { length: 128 }).notNull().unique(),
    status:       bucketStatusEnum('status').notNull().default('provisioning'),
    accessPolicy: varchar('access_policy', { length: 64 }).notNull().default('private'),
    versioningEnabled: boolean('versioning_enabled').notNull().default(false),
    lastKnownSizeBytes: bigint('last_known_size_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    lastSizeSnapshotAt: timestamp('last_size_snapshot_at', { withTimezone: true }),
    region:    varchar('region', { length: 64 }).notNull().default('us-east-1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    tenantBucketUnique: uniqueIndex('buckets_tenant_id_name_unique').on(table.tenantId, table.name),
    tenantIdIdx: index('buckets_tenant_id_idx').on(table.tenantId),
    statusIdx:   index('buckets_status_idx').on(table.status),
  }),
);

// ─────────────────────────────────────────────────────────────
// usage_metrics — append-only event log
// ─────────────────────────────────────────────────────────────

export const usageMetrics = pgTable(
  'usage_metrics',
  {
    id:       uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
    bucketId: uuid('bucket_id').references(() => buckets.id, { onDelete: 'set null' }),
    eventType:    eventTypeEnum('event_type').notNull(),
    bytes:        bigint('bytes', { mode: 'bigint' }).notNull().default(sql`0`),
    requestCount: integer('request_count').notNull().default(1),
    billingPeriod: varchar('billing_period', { length: 7 }).notNull(),
    metadata:      text('metadata'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).unique(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    recordedAt: timestamp('recorded_at',  { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPeriodIdx: index('usage_metrics_tenant_period_idx').on(table.tenantId, table.billingPeriod),
    bucketIdIdx:     index('usage_metrics_bucket_id_idx').on(table.bucketId),
    eventTypeIdx:    index('usage_metrics_event_type_idx').on(table.eventType),
    occurredAtIdx:   index('usage_metrics_occurred_at_idx').on(table.occurredAt),
  }),
);

// ─────────────────────────────────────────────────────────────
// Phase 3 Tables
// ─────────────────────────────────────────────────────────────

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'finalised',
  'void',
]);

export const invoices = pgTable(
  'invoices',
  {
    id:       uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
    billingPeriod:    varchar('billing_period', { length: 7 }).notNull(),
    status:           invoiceStatusEnum('status').notNull().default('draft'),
    storageByteAvg:   bigint('storage_byte_avg',   { mode: 'bigint' }).notNull().default(sql`0`),
    ingressBytes:     bigint('ingress_bytes',       { mode: 'bigint' }).notNull().default(sql`0`),
    egressBytes:      bigint('egress_bytes',        { mode: 'bigint' }).notNull().default(sql`0`),
    bucketCount:      integer('bucket_count').notNull().default(0),
    apiRequestCount:  integer('api_request_count').notNull().default(0),
    totalChargeUcents: bigint('total_charge_ucents', { mode: 'bigint' }).notNull().default(sql`0`),
    currency:         varchar('currency', { length: 3 }).notNull().default('USD'),
    generatedAt:      timestamp('generated_at',  { withTimezone: true }).notNull().defaultNow(),
    finalisedAt:      timestamp('finalised_at',  { withTimezone: true }),
    lineItemsJson:    text('line_items_json'),
  },
  (table) => ({
    tenantPeriodUnique: uniqueIndex('invoices_tenant_period_unique').on(table.tenantId, table.billingPeriod),
    tenantIdIdx: index('invoices_tenant_id_idx').on(table.tenantId),
    statusIdx:   index('invoices_status_idx').on(table.status),
  }),
);

export const breachTypeEnum = pgEnum('breach_type', [
  'storage_warning',
  'storage_exceeded',
  'ingress_warning',
  'ingress_exceeded',
  'egress_warning',
  'egress_exceeded',
  'bucket_warning',
  'bucket_exceeded',
]);

export const quotaBreachEvents = pgTable(
  'quota_breach_events',
  {
    id:           uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId:     uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    breachType:   breachTypeEnum('breach_type').notNull(),
    currentValue: bigint('current_value', { mode: 'bigint' }).notNull(),
    limitValue:   bigint('limit_value',   { mode: 'bigint' }).notNull(),
    billingPeriod: varchar('billing_period', { length: 7 }),
    detectedAt:   timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    webhookDispatched:   boolean('webhook_dispatched').notNull().default(false),
    webhookDispatchedAt: timestamp('webhook_dispatched_at', { withTimezone: true }),
  },
  (table) => ({
    tenantBreachIdx: index('qbe_tenant_breach_idx').on(table.tenantId, table.breachType, table.billingPeriod),
  }),
);

export const webhookStatusEnum = pgEnum('webhook_status', [
  'pending',
  'success',
  'failed',
  'retrying',
]);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id:          uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId:    uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    endpointUrl: varchar('endpoint_url', { length: 2048 }).notNull(),
    eventType:   varchar('event_type',   { length: 64 }).notNull(),
    payload:     text('payload').notNull(),
    status:      webhookStatusEnum('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts:  integer('max_attempts').notNull().default(5),
    lastAttemptAt:  timestamp('last_attempt_at',  { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError:      text('last_error'),
    nextRetryAt:    timestamp('next_retry_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt:      timestamp('created_at',    { withTimezone: true }).notNull().defaultNow(),
    completedAt:    timestamp('completed_at',  { withTimezone: true }),
  },
  (table) => ({
    pendingRetryIdx: index('wd_pending_retry_idx').on(table.status, table.nextRetryAt),
    tenantIdx:       index('wd_tenant_idx').on(table.tenantId),
  }),
);

export const usageSnapshots = pgTable(
  'usage_snapshots',
  {
    id:          uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId:    uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    bucketId:    uuid('bucket_id').notNull().references(() => buckets.id, { onDelete: 'cascade' }),
    bytesStored: bigint('bytes_stored', { mode: 'bigint' }).notNull(),
    snappedAt:   timestamp('snapped_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantTimeIdx: index('us_tenant_time_idx').on(table.tenantId, table.snappedAt),
    bucketTimeIdx: index('us_bucket_time_idx').on(table.bucketId, table.snappedAt),
  }),
);

// ─────────────────────────────────────────────────────────────
// Phase 4 Tables
// ─────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id:         uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    action:     auditLogActionEnum('action').notNull(),
    adminId:    varchar('admin_id', { length: 128 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId:   uuid('target_id').notNull(),
    before:     text('before'),
    after:      text('after'),
    ip:         varchar('ip', { length: 45 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actionIdx:   index('al_action_idx').on(t.action),
    targetIdx:   index('al_target_idx').on(t.targetType, t.targetId),
    adminIdx:    index('al_admin_idx').on(t.adminId),
    occurredIdx: index('al_occurred_idx').on(t.occurredAt),
  }),
);

// ─────────────────────────────────────────────────────────────
// Phase 5 — api_keys
// ─────────────────────────────────────────────────────────────

export const apiKeyStatusEnum = pgEnum('api_key_status', ['active', 'revoked']);

/**
 * Tenant API keys — used to authenticate S3 and Portal requests.
 * The raw key is NEVER stored; only its SHA-256 hex hash is persisted.
 * keyPrefix (first 8 chars of the raw key) is shown in the UI for identification.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id:       uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

    /** SHA-256 hex digest of the raw key. Only this is stored. */
    keyHash:   varchar('key_hash',   { length: 64  }).notNull().unique(),

    /** First 8 characters of the raw key — displayed in the UI. */
    keyPrefix: varchar('key_prefix', { length: 8   }).notNull(),

    label:  varchar('label', { length: 128 }),
    status: apiKeyStatusEnum('status').notNull().default('active'),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    /** null = never expires */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index('ak_tenant_idx').on(t.tenantId),
    statusIdx: index('ak_status_idx').on(t.status),
  }),
);

// ─────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────

export const plansRelations = relations(plans, ({ many }) => ({
  tenants: many(tenants),
}));

export const tenantsRelations = relations(tenants, ({ one, many }) => ({
  plan:        one(plans, { fields: [tenants.planId], references: [plans.id] }),
  buckets:     many(buckets),
  usageMetrics: many(usageMetrics),
  apiKeys:     many(apiKeys),
}));

export const bucketsRelations = relations(buckets, ({ one, many }) => ({
  tenant:      one(tenants, { fields: [buckets.tenantId], references: [tenants.id] }),
  usageMetrics: many(usageMetrics),
}));

export const usageMetricsRelations = relations(usageMetrics, ({ one }) => ({
  tenant: one(tenants, { fields: [usageMetrics.tenantId], references: [tenants.id] }),
  bucket: one(buckets, { fields: [usageMetrics.bucketId], references: [buckets.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  tenant: one(tenants, { fields: [apiKeys.tenantId], references: [tenants.id] }),
}));

// ─────────────────────────────────────────────────────────────
// Type Exports
// ─────────────────────────────────────────────────────────────

export type Tenant        = typeof tenants.$inferSelect;
export type NewTenant     = typeof tenants.$inferInsert;
export type Bucket        = typeof buckets.$inferSelect;
export type NewBucket     = typeof buckets.$inferInsert;
export type UsageMetric   = typeof usageMetrics.$inferSelect;
export type NewUsageMetric = typeof usageMetrics.$inferInsert;

export type TenantStatus = typeof tenantStatusEnum.enumValues[number];
export type BucketStatus = typeof bucketStatusEnum.enumValues[number];
export type EventType    = typeof eventTypeEnum.enumValues[number];

export type Invoice           = typeof invoices.$inferSelect;
export type NewInvoice        = typeof invoices.$inferInsert;
export type QuotaBreachEvent  = typeof quotaBreachEvents.$inferSelect;
export type NewQuotaBreachEvent = typeof quotaBreachEvents.$inferInsert;
export type WebhookDelivery   = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type UsageSnapshot     = typeof usageSnapshots.$inferSelect;
export type NewUsageSnapshot  = typeof usageSnapshots.$inferInsert;

export type InvoiceStatus = typeof invoiceStatusEnum.enumValues[number];
export type BreachType    = typeof breachTypeEnum.enumValues[number];
export type WebhookStatus = typeof webhookStatusEnum.enumValues[number];

export type Plan            = typeof plans.$inferSelect;
export type NewPlan         = typeof plans.$inferInsert;
export type AuditLogEntry   = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type AuditLogAction  = typeof auditLogActionEnum.enumValues[number];

export type ApiKey       = typeof apiKeys.$inferSelect;
export type NewApiKey    = typeof apiKeys.$inferInsert;
export type ApiKeyStatus = typeof apiKeyStatusEnum.enumValues[number];