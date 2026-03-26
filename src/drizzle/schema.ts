/**
 * src/db/schema.ts
 *
 * Project 5 — Multi-Tenant Usage Metering & Billing Engine
 *
 * Schema Design Principles
 * ────────────────────────
 * 1. Multi-tenant isolation is enforced at the DB layer, not just
 *    application logic. Every resource row carries a tenant_id FK.
 *    The composite unique constraint on (tenant_id, name) means two
 *    tenants can both own "my-bucket" without collision.
 *
 * 2. usage_metrics is an APPEND-ONLY event log. We never UPDATE rows
 *    here. This is the billing source of truth. Aggregations are
 *    derived on read (or materialised via a separate job).
 *
 * 3. byte values use bigint — no float precision drift on large numbers.
 *
 * 4. Timestamps are timestamptz (timezone-aware). Always store UTC.
 *
 * 5. We use pgEnum for status/event_type so Postgres enforces the
 *    domain; application code gets type safety for free via Drizzle's
 *    inference.
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
// Enums
// ─────────────────────────────────────────────────────────────

/**
 * Lifecycle state of a tenant account.
 * 'suspended' blocks all new operations but retains data.
 * 'deleted'   is a soft-delete sentinel; hard purge is a separate job.
 */
export const tenantStatusEnum = pgEnum('tenant_status', [
  'active',
  'suspended',
  'deleted',
]);

/**
 * Lifecycle state of a physical bucket.
 * 'provisioning' — MinIO call in-flight (used for idempotency guard).
 * 'active'       — healthy and accepting objects.
 * 'suspended'    — quota exceeded; reads allowed, writes blocked.
 * 'deleted'      — soft-deleted; physical purge is async.
 */
export const bucketStatusEnum = pgEnum('bucket_status', [
  'provisioning',
  'active',
  'suspended',
  'deleted',
]);

/**
 * The set of billable events we meter.
 * Extend this enum (and add a migration) when new operations are added.
 *
 * bucket_created    — flat per-bucket charge or quota deduction
 * bucket_deleted    — may trigger a credit or quota release
 * storage_recorded  — periodic snapshot of bytes stored
 * data_in           — ingress bytes (PUT/POST object)
 * data_out          — egress bytes (GET object)
 * api_request       — per-request charge (optional; enable per plan)
 */
export const eventTypeEnum = pgEnum('event_type', [
  'bucket_created',
  'bucket_deleted',
  'storage_recorded',
  'data_in',
  'data_out',
  'api_request',
]);

// ─────────────────────────────────────────────────────────────
// tenants
// The root of the multi-tenant hierarchy. Every other table
// references this via tenant_id.
// ─────────────────────────────────────────────────────────────

export const tenants = pgTable('tenants', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  /** Human-readable slug; used in API paths and Redis key prefixes. */
  slug: varchar('slug', { length: 63 })
    .notNull()
    .unique(),

  /** Display name shown in the billing dashboard. */
  displayName: varchar('display_name', { length: 255 }).notNull(),

  /** Contact email for billing alerts and suspension notices. */
  email: varchar('email', { length: 320 }).notNull().unique(),

  status: tenantStatusEnum('status').notNull().default('active'),

  // ── Quota limits (enforced at the interceptor layer) ──────

  /** Maximum number of buckets this tenant may own simultaneously. */
  maxBuckets: integer('max_buckets').notNull().default(10),

  /**
   * Maximum total storage in bytes across all buckets.
   * bigint: supports up to ~9.2 exabytes per tenant.
   * Default: 107,374,182,400 bytes = 100 GiB
   */
  maxStorageBytes: bigint('max_storage_bytes', { mode: 'bigint' })
    .notNull()
    .default(sql`107374182400`),

  /**
   * Maximum ingress bytes per calendar month.
   * Default: 10,737,418,240 bytes = 10 GiB/month
   */
  maxMonthlyIngressBytes: bigint('max_monthly_ingress_bytes', { mode: 'bigint' })
    .notNull()
    .default(sql`10737418240`),

  /**
   * Maximum egress bytes per calendar month.
   * Default: 10,737,418,240 bytes = 10 GiB/month
   */
  maxMonthlyEgressBytes: bigint('max_monthly_egress_bytes', { mode: 'bigint' })
    .notNull()
    .default(sql`10737418240`),

  webhookEndpointUrl: varchar('webhook_endpoint_url', { length: 2048 }),
  webhookSecret:      varchar('webhook_secret', { length: 128 }),

  // ── Timestamps ───────────────────────────────────────────

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─────────────────────────────────────────────────────────────
// buckets
// Represents a provisioned MinIO bucket owned by a tenant.
// The composite unique index on (tenant_id, name) is the
// multi-tenant isolation boundary at the storage layer.
// ─────────────────────────────────────────────────────────────

export const buckets = pgTable(
  'buckets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    /**
     * The bucket name as presented in the S3 API call.
     * Must conform to S3 naming rules (3–63 chars, lowercase,
     * alphanumeric + hyphens). Validation is in the route handler.
     *
     * The physical bucket name in MinIO is: `{tenant_slug}--{name}`
     * This avoids cross-tenant name collisions at the MinIO level
     * while keeping the API surface clean for each tenant.
     */
    name: varchar('name', { length: 63 }).notNull(),

    /**
     * The actual bucket name provisioned in MinIO.
     * Format: `{tenant_slug}--{bucket_name}`
     * Stored so we never recompute it and can audit it directly.
     */
    physicalName: varchar('physical_name', { length: 128 }).notNull().unique(),

    status: bucketStatusEnum('status').notNull().default('provisioning'),

    /** AWS-style canned ACL or custom policy name for future use. */
    accessPolicy: varchar('access_policy', { length: 64 })
      .notNull()
      .default('private'),

    /** Versioning enabled on this bucket in MinIO. */
    versioningEnabled: boolean('versioning_enabled').notNull().default(false),

    /**
     * Last known storage usage for this bucket in bytes.
     * Updated by the periodic usage-recording job — NOT on every PUT.
     * For real-time usage, read from Redis.
     */
    lastKnownSizeBytes: bigint('last_known_size_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    /** Timestamp of the last size snapshot. */
    lastSizeSnapshotAt: timestamp('last_size_snapshot_at', {
      withTimezone: true,
    }),

    /** Region hint — useful when MinIO is deployed in federated mode. */
    region: varchar('region', { length: 64 }).notNull().default('us-east-1'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Soft-delete timestamp. NULL = alive. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    /**
     * THE multi-tenant isolation constraint.
     * Two tenants may both call PUT /my-bucket but this ensures
     * they each get their own row and their own physical bucket.
     */
    tenantBucketUnique: uniqueIndex('buckets_tenant_id_name_unique').on(
      table.tenantId,
      table.name,
    ),

    /** Fast look-up by tenant for dashboard and quota queries. */
    tenantIdIdx: index('buckets_tenant_id_idx').on(table.tenantId),

    /** Soft-delete filter — partial index would be ideal in raw SQL. */
    statusIdx: index('buckets_status_idx').on(table.status),
  }),
);

// ─────────────────────────────────────────────────────────────
// usage_metrics
// Append-only billing event log. Every metered operation
// produces a row here. This is the source of truth for
// invoice generation and quota roll-ups.
//
// Redis holds the hot counters (fast, ephemeral).
// This table holds the durable record (slow, permanent).
// ─────────────────────────────────────────────────────────────

export const usageMetrics = pgTable(
  'usage_metrics',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    /**
     * Nullable — some events are tenant-scoped, not bucket-scoped.
     * Example: a tenant-level API quota event.
     */
    bucketId: uuid('bucket_id').references(() => buckets.id, {
      onDelete: 'set null',
    }),

    eventType: eventTypeEnum('event_type').notNull(),

    /**
     * The byte quantity associated with this event.
     * For bucket_created / api_request: 0 (not byte-based).
     * For storage_recorded: snapshot of bytes at time of recording.
     * For data_in / data_out: bytes transferred in this operation.
     */
    bytes: bigint('bytes', { mode: 'bigint' }).notNull().default(sql`0`),

    /**
     * Number of API requests in this event record.
     * Usually 1. For batch aggregation records, may be > 1.
     */
    requestCount: integer('request_count').notNull().default(1),

    /**
     * Billing period this event belongs to.
     * Format: YYYY-MM (e.g. '2025-06').
     * Derived at insert time — never updated.
     * Enables fast monthly roll-ups: WHERE billing_period = '2025-06'
     */
    billingPeriod: varchar('billing_period', { length: 7 }).notNull(),

    /**
     * Arbitrary JSON payload for event-specific metadata.
     * Examples:
     *   bucket_created: { region, accessPolicy, physicalName }
     *   data_in:        { objectKey, contentType, sourceIp }
     *   api_request:    { method, path, statusCode, durationMs }
     */
    metadata: text('metadata'),

    /**
     * Idempotency key for deduplication.
     * The caller may set this to prevent double-billing on retries.
     * Unique constraint means a duplicate insert is a no-op (ON CONFLICT).
     */
    idempotencyKey: varchar('idempotency_key', { length: 128 }).unique(),

    /** Wall-clock time the event occurred (client-reported). */
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Wall-clock time the row was written to this table. */
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Primary query pattern: all events for a tenant in a period. */
    tenantPeriodIdx: index('usage_metrics_tenant_period_idx').on(
      table.tenantId,
      table.billingPeriod,
    ),

    /** Bucket-level drill-down for the billing dashboard. */
    bucketIdIdx: index('usage_metrics_bucket_id_idx').on(table.bucketId),

    /** Event type filter (e.g. sum all data_in for a period). */
    eventTypeIdx: index('usage_metrics_event_type_idx').on(table.eventType),

    /** Time-series queries — partition candidate for large deployments. */
    occurredAtIdx: index('usage_metrics_occurred_at_idx').on(table.occurredAt),
  }),
);

// ─────────────────────────────────────────────────────────────
// Phase 3 Tables
// ─────────────────────────────────────────────────────────────

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',       // aggregation complete, not yet finalised
  'finalised',   // locked — no further changes
  'void',        // cancelled (e.g. tenant deleted mid-period)
]);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    /** Billing period this invoice covers. Format: 'YYYY-MM'. */
    billingPeriod: varchar('billing_period', { length: 7 }).notNull(),

    status: invoiceStatusEnum('status').notNull().default('draft'),

    /** Total bytes stored (average over the period, from snapshots). */
    storageByteAvg: bigint('storage_byte_avg', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    /** Total ingress bytes this period. */
    ingressBytes: bigint('ingress_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    /** Total egress bytes this period. */
    egressBytes: bigint('egress_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    /** Total number of buckets active at any point in the period. */
    bucketCount: integer('bucket_count').notNull().default(0),

    /** Total API requests this period. */
    apiRequestCount: integer('api_request_count').notNull().default(0),

    /**
     * Computed charge in micro-units of currency (e.g. micro-USD).
     * Stored as bigint to avoid float rounding. Divide by 1_000_000 for display.
     * Formula is applied by the aggregator — see PRICING MODEL section.
     */
    totalChargeUcents: bigint('total_charge_ucents', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    /** ISO 4217 currency code. Default USD. */
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),

    /** When this invoice was first generated (draft created). */
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** When this invoice was finalised (locked). Null if still draft. */
    finalisedAt: timestamp('finalised_at', { withTimezone: true }),

    /** Full JSON breakdown of line items — stored for audit trail. */
    lineItemsJson: text('line_items_json'),
  },
  (table) => ({
    /**
     * Core idempotency constraint.
     * One invoice per tenant per billing period, always.
     */
    tenantPeriodUnique: uniqueIndex('invoices_tenant_period_unique').on(
      table.tenantId,
      table.billingPeriod,
    ),
    tenantIdIdx: index('invoices_tenant_id_idx').on(table.tenantId),
    statusIdx:   index('invoices_status_idx').on(table.status),
  }),
);

export const breachTypeEnum = pgEnum('breach_type', [
  'storage_warning',    // >= 80% of maxStorageBytes
  'storage_exceeded',   // >= 100% of maxStorageBytes
  'ingress_warning',    // >= 80% of maxMonthlyIngressBytes
  'ingress_exceeded',   // >= 100%
  'egress_warning',
  'egress_exceeded',
  'bucket_warning',     // >= 80% of maxBuckets
  'bucket_exceeded',    // >= 100%
]);

export const quotaBreachEvents = pgTable(
  'quota_breach_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    breachType: breachTypeEnum('breach_type').notNull(),
    /** The value that triggered the breach (bytes or count). */
    currentValue: bigint('current_value', { mode: 'bigint' }).notNull(),
    /** The limit that was crossed. */
    limitValue:   bigint('limit_value',   { mode: 'bigint' }).notNull(),
    /** Billing period this breach belongs to (for monthly quotas). */
    billingPeriod: varchar('billing_period', { length: 7 }),
    detectedAt: timestamp('detected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Whether a webhook has been dispatched for this event. */
    webhookDispatched: boolean('webhook_dispatched').notNull().default(false),
    webhookDispatchedAt: timestamp('webhook_dispatched_at', { withTimezone: true }),
  },
  (table) => ({
    tenantBreachIdx: index('qbe_tenant_breach_idx').on(
      table.tenantId,
      table.breachType,
      table.billingPeriod,
    ),
  }),
);

export const webhookStatusEnum = pgEnum('webhook_status', [
  'pending',    // not yet attempted
  'success',    // HTTP 2xx received
  'failed',     // all retries exhausted
  'retrying',   // currently in backoff
]);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** The URL to POST to. Stored at delivery time, not looked up again. */
    endpointUrl: varchar('endpoint_url', { length: 2048 }).notNull(),

    /** Event type string — e.g. 'invoice.ready', 'quota.breach', 'quota.warning' */
    eventType: varchar('event_type', { length: 64 }).notNull(),

    /** Full JSON payload to deliver. */
    payload: text('payload').notNull(),

    status: webhookStatusEnum('status').notNull().default('pending'),

    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts:  integer('max_attempts').notNull().default(5),

    /** Timestamp of most recent attempt. */
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),

    /** HTTP status code of most recent attempt. Null if not yet attempted. */
    lastStatusCode: integer('last_status_code'),

    /** Error message from most recent failed attempt. */
    lastError: text('last_error'),

    /** When to next attempt delivery (exponential backoff). */
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt:   timestamp('created_at',   { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    /** Dispatcher polls this index every tick. */
    pendingRetryIdx: index('wd_pending_retry_idx').on(
      table.status,
      table.nextRetryAt,
    ),
    tenantIdx: index('wd_tenant_idx').on(table.tenantId),
  }),
);

export const usageSnapshots = pgTable(
  'usage_snapshots',
  {
    id:           uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId:     uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    bucketId:     uuid('bucket_id').notNull().references(() => buckets.id, { onDelete: 'cascade' }),
    bytesStored:  bigint('bytes_stored', { mode: 'bigint' }).notNull(),
    snappedAt:    timestamp('snapped_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantTimeIdx: index('us_tenant_time_idx').on(table.tenantId, table.snappedAt),
    bucketTimeIdx: index('us_bucket_time_idx').on(table.bucketId, table.snappedAt),
  }),
);

// ─────────────────────────────────────────────────────────────
// Relations
// Drizzle's relational query builder uses these to generate
// typed JOINs. These are purely declarative — no DDL impact.
// ─────────────────────────────────────────────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  buckets:      many(buckets),
  usageMetrics: many(usageMetrics),
}));

export const bucketsRelations = relations(buckets, ({ one, many }) => ({
  tenant:       one(tenants, { fields: [buckets.tenantId],      references: [tenants.id] }),
  usageMetrics: many(usageMetrics),
}));

export const usageMetricsRelations = relations(usageMetrics, ({ one }) => ({
  tenant: one(tenants, { fields: [usageMetrics.tenantId], references: [tenants.id] }),
  bucket: one(buckets, { fields: [usageMetrics.bucketId], references: [buckets.id] }),
}));

// ─────────────────────────────────────────────────────────────
// Type exports
// Inferred from the schema — zero runtime cost.
// Use these throughout the application instead of redeclaring.
// ─────────────────────────────────────────────────────────────

export type Tenant        = typeof tenants.$inferSelect;
export type NewTenant     = typeof tenants.$inferInsert;
export type Bucket        = typeof buckets.$inferSelect;
export type NewBucket     = typeof buckets.$inferInsert;
export type UsageMetric   = typeof usageMetrics.$inferSelect;
export type NewUsageMetric = typeof usageMetrics.$inferInsert;

export type TenantStatus  = typeof tenantStatusEnum.enumValues[number];
export type BucketStatus  = typeof bucketStatusEnum.enumValues[number];
export type EventType     = typeof eventTypeEnum.enumValues[number];

export type Invoice          = typeof invoices.$inferSelect;
export type NewInvoice       = typeof invoices.$inferInsert;
export type QuotaBreachEvent = typeof quotaBreachEvents.$inferSelect;
export type NewQuotaBreachEvent = typeof quotaBreachEvents.$inferInsert;
export type WebhookDelivery  = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type UsageSnapshot    = typeof usageSnapshots.$inferSelect;
export type NewUsageSnapshot = typeof usageSnapshots.$inferInsert;

export type InvoiceStatus    = typeof invoiceStatusEnum.enumValues[number];
export type BreachType       = typeof breachTypeEnum.enumValues[number];
export type WebhookStatus    = typeof webhookStatusEnum.enumValues[number];