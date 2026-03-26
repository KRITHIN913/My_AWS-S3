// src/lib/meteringService.ts

/**
 * Metering Service
 *
 * The core billing pipeline for all data operations. This is the ONLY module
 * allowed to write to usage_metrics and update Redis byte counters. No route
 * handler writes billing events directly — they all call this service.
 *
 * Design:
 *   - PostgreSQL INSERT is synchronous (must succeed or caller knows).
 *   - Redis counter updates are parallel (Promise.all) for throughput.
 *   - Idempotency is enforced via ON CONFLICT (idempotencyKey) DO NOTHING.
 *   - Storage counter decrements use a Lua script to clamp at zero.
 *   - BigInt is used throughout for byte arithmetic — no precision loss.
 */

import { eq, and, sql, sum } from 'drizzle-orm';
import { usageMetrics, tenants } from '../drizzle/schema.js';
import type { DrizzleDb } from '../db/index.js';
import type { Redis } from 'ioredis';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/** Parameters for recording a data_in (ingress / PutObject) event. */
export interface RecordIngressParams {
  tenantId: string;
  tenantSlug: string;
  bucketId: string;
  bucketName: string;
  objectKey: string;
  bytes: bigint;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

/** Parameters for recording a data_out (egress / GetObject) event. */
export interface RecordEgressParams {
  tenantId: string;
  tenantSlug: string;
  bucketId: string;
  bucketName: string;
  objectKey: string;
  bytes: bigint;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

/** Parameters for recording a deletion event. */
export interface RecordDeletionParams {
  tenantId: string;
  tenantSlug: string;
  bucketId: string;
  objectKey: string;
  freedBytes: bigint;
  idempotencyKey: string;
}

/** Result of a quota check — never throws, returns allowed:false instead. */
export interface QuotaCheckResult {
  allowed: boolean;
  currentBytes: bigint;
  limitBytes: bigint;
  reason?: 'storage_quota_exceeded' | 'ingress_quota_exceeded' | 'egress_quota_exceeded';
}

// ─────────────────────────────────────────────────────────────
// Redis key builders
// ─────────────────────────────────────────────────────────────

/** Redis key for total storage bytes consumed by a tenant. */
function storageKey(slug: string): string {
  return `quota:${slug}:storage_bytes`;
}

/** Redis key for monthly ingress bytes consumed by a tenant. */
function ingressKey(slug: string, period: string): string {
  return `quota:${slug}:ingress:${period}`;
}

/** Redis key for monthly egress bytes consumed by a tenant. */
function egressKey(slug: string, period: string): string {
  return `quota:${slug}:egress:${period}`;
}

/** Redis key for cached tenant quota metadata. */
function tenantMetaKey(slug: string): string {
  return `tenant:${slug}:meta`;
}

// ─────────────────────────────────────────────────────────────
// Billing period helper
// ─────────────────────────────────────────────────────────────

/**
 * Returns the current billing period in 'YYYY-MM' format.
 * @returns A string like '2025-06'.
 */
function currentBillingPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}

/** TTL for monthly counter keys — 35 days in seconds. */
const MONTHLY_TTL_SECONDS = 35 * 24 * 60 * 60;

// ─────────────────────────────────────────────────────────────
// BigInt JSON replacer
// ─────────────────────────────────────────────────────────────

/**
 * JSON.stringify replacer that converts BigInt values to strings.
 * Required because JSON.stringify throws on BigInt by default.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

// ─────────────────────────────────────────────────────────────
// Lua script for clamped DECRBY
// ─────────────────────────────────────────────────────────────

/**
 * Lua script that decrements a Redis key by ARGV[1] and clamps at 0.
 * Used for storage_bytes to prevent negative counters.
 *
 * Returns the new value after decrement (clamped).
 */
const CLAMPED_DECRBY_SCRIPT = `
local v = redis.call('DECRBY', KEYS[1], ARGV[1])
if tonumber(v) < 0 then
  redis.call('SET', KEYS[1], '0')
  return 0
end
return v
`;

// ─────────────────────────────────────────────────────────────
// Exported functions
// ─────────────────────────────────────────────────────────────

/**
 * Records a data_in (ingress) billing event.
 * Called after a successful PutObject stream completes.
 *
 * Writes atomically:
 *   1. INSERT into usage_metrics (eventType='data_in', bytes=bytesUploaded)
 *      with ON CONFLICT (idempotencyKey) DO NOTHING for retry safety.
 *   2. INCRBY quota:{slug}:storage_bytes {bytesUploaded}
 *   3. INCRBY quota:{slug}:ingress:{YYYY-MM} {bytesUploaded} (TTL: 35 days)
 *
 * Steps 2-3 are Redis INCRBY executed in parallel via Promise.all.
 *
 * @param params - Ingress event parameters.
 * @param db     - Drizzle database instance.
 * @param redis  - ioredis client instance.
 */
export async function recordIngress(
  params: RecordIngressParams,
  db: DrizzleDb,
  redis: Redis,
): Promise<void> {
  const period = currentBillingPeriod();

  // 1. Durable record in Postgres
  await db
    .insert(usageMetrics)
    .values({
      tenantId: params.tenantId,
      bucketId: params.bucketId,
      eventType: 'data_in',
      bytes: params.bytes,
      billingPeriod: period,
      idempotencyKey: params.idempotencyKey,
      metadata: JSON.stringify(params.metadata, bigintReplacer),
    })
    .onConflictDoNothing({ target: usageMetrics.idempotencyKey });

  // 2-3. Redis counter updates (parallel, fire-and-forget style but awaited)
  const bytesStr = params.bytes.toString();
  const sKey = storageKey(params.tenantSlug);
  const iKey = ingressKey(params.tenantSlug, period);

  await Promise.all([
    redis.incrby(sKey, bytesStr),
    redis.incrby(iKey, bytesStr).then(() => redis.expire(iKey, MONTHLY_TTL_SECONDS)),
  ]);
}

/**
 * Records a data_out (egress) billing event.
 * Called after a successful GetObject stream completes.
 *
 * Writes:
 *   1. INSERT into usage_metrics (eventType='data_out', bytes=bytesDownloaded)
 *   2. INCRBY quota:{slug}:egress:{YYYY-MM} {bytesDownloaded} (TTL: 35 days)
 *
 * Note: egress does NOT increment storage_bytes — storage is consumed
 * by writes and object retention, not by reads.
 *
 * @param params - Egress event parameters.
 * @param db     - Drizzle database instance.
 * @param redis  - ioredis client instance.
 */
export async function recordEgress(
  params: RecordEgressParams,
  db: DrizzleDb,
  redis: Redis,
): Promise<void> {
  const period = currentBillingPeriod();

  // 1. Durable record in Postgres
  await db
    .insert(usageMetrics)
    .values({
      tenantId: params.tenantId,
      bucketId: params.bucketId,
      eventType: 'data_out',
      bytes: params.bytes,
      billingPeriod: period,
      idempotencyKey: params.idempotencyKey,
      metadata: JSON.stringify(params.metadata, bigintReplacer),
    })
    .onConflictDoNothing({ target: usageMetrics.idempotencyKey });

  // 2. Redis egress counter update
  const eKey = egressKey(params.tenantSlug, period);
  await redis.incrby(eKey, params.bytes.toString());
  await redis.expire(eKey, MONTHLY_TTL_SECONDS);
}

/**
 * Records a deletion billing event and decrements the storage counter in Redis.
 *
 * Writes:
 *   1. INSERT into usage_metrics (eventType='bucket_deleted', bytes=freedBytes)
 *   2. DECRBY quota:{slug}:storage_bytes {freedBytes}
 *      — clamped to 0 via Lua script (never goes negative)
 *
 * @param params - Deletion event parameters.
 * @param db     - Drizzle database instance.
 * @param redis  - ioredis client instance.
 */
export async function recordDeletion(
  params: RecordDeletionParams,
  db: DrizzleDb,
  redis: Redis,
): Promise<void> {
  const period = currentBillingPeriod();

  // 1. Durable record in Postgres
  await db
    .insert(usageMetrics)
    .values({
      tenantId: params.tenantId,
      bucketId: params.bucketId,
      eventType: 'bucket_deleted',
      bytes: params.freedBytes,
      billingPeriod: period,
      idempotencyKey: params.idempotencyKey,
      metadata: JSON.stringify({ objectKey: params.objectKey }, bigintReplacer),
    })
    .onConflictDoNothing({ target: usageMetrics.idempotencyKey });

  // 2. Decrement storage counter with Lua clamp
  const sKey = storageKey(params.tenantSlug);
  await redis.eval(
    CLAMPED_DECRBY_SCRIPT,
    1,
    sKey,
    params.freedBytes.toString(),
  );
}

/**
 * Checks whether a tenant has sufficient ingress quota remaining for the
 * current billing period.
 *
 * Reads quota:{slug}:ingress:{YYYY-MM} from Redis first; falls back to
 * computing the sum from usage_metrics in Postgres on cache miss.
 *
 * @param tenantId     - UUID of the tenant.
 * @param tenantSlug   - Slug of the tenant (for Redis keys).
 * @param requestBytes - Bytes the current request wants to upload.
 * @param db           - Drizzle database instance.
 * @param redis        - ioredis client instance.
 * @returns QuotaCheckResult — never throws; returns allowed:false on breach.
 */
export async function checkIngressQuota(
  tenantId: string,
  tenantSlug: string,
  requestBytes: bigint,
  db: DrizzleDb,
  redis: Redis,
): Promise<QuotaCheckResult> {
  const period = currentBillingPeriod();
  const limitBytes = await getTenantLimit(tenantId, tenantSlug, 'maxMonthlyIngressBytes', db, redis);
  const currentBytes = await getCounterValue(
    ingressKey(tenantSlug, period),
    tenantId,
    period,
    'data_in',
    db,
    redis,
  );

  if (currentBytes + requestBytes > limitBytes) {
    return { allowed: false, currentBytes, limitBytes, reason: 'ingress_quota_exceeded' };
  }
  return { allowed: true, currentBytes, limitBytes };
}

/**
 * Checks whether a tenant has sufficient storage quota remaining.
 * Same pattern as checkIngressQuota but reads the total storage counter.
 *
 * @param tenantId     - UUID of the tenant.
 * @param tenantSlug   - Slug of the tenant (for Redis keys).
 * @param requestBytes - Bytes the current request wants to store.
 * @param db           - Drizzle database instance.
 * @param redis        - ioredis client instance.
 * @returns QuotaCheckResult — never throws; returns allowed:false on breach.
 */
export async function checkStorageQuota(
  tenantId: string,
  tenantSlug: string,
  requestBytes: bigint,
  db: DrizzleDb,
  redis: Redis,
): Promise<QuotaCheckResult> {
  const limitBytes = await getTenantLimit(tenantId, tenantSlug, 'maxStorageBytes', db, redis);
  const sKey = storageKey(tenantSlug);
  const cached = await redis.get(sKey);

  let currentBytes: bigint;
  if (cached !== null) {
    currentBytes = BigInt(cached);
  } else {
    // Cache miss — compute from Postgres (sum of all data_in minus bucket_deleted)
    const inResult = await db
      .select({ total: sum(usageMetrics.bytes) })
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenantId),
          eq(usageMetrics.eventType, 'data_in'),
        ),
      );
    const totalIn = BigInt(inResult[0]?.total ?? '0');

    const outResult = await db
      .select({ total: sum(usageMetrics.bytes) })
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenantId),
          eq(usageMetrics.eventType, 'bucket_deleted'),
        ),
      );
    const totalFreed = BigInt(outResult[0]?.total ?? '0');

    currentBytes = totalIn - totalFreed;
    if (currentBytes < 0n) currentBytes = 0n;

    // Write back to Redis
    await redis.set(sKey, currentBytes.toString());
  }

  if (currentBytes + requestBytes > limitBytes) {
    return { allowed: false, currentBytes, limitBytes, reason: 'storage_quota_exceeded' };
  }
  return { allowed: true, currentBytes, limitBytes };
}

/**
 * Checks whether a tenant has sufficient egress quota remaining for the
 * current billing period.
 *
 * @param tenantId     - UUID of the tenant.
 * @param tenantSlug   - Slug of the tenant.
 * @param requestBytes - Bytes the current request would transfer out.
 * @param db           - Drizzle database instance.
 * @param redis        - ioredis client instance.
 * @returns QuotaCheckResult — never throws; returns allowed:false on breach.
 */
export async function checkEgressQuota(
  tenantId: string,
  tenantSlug: string,
  requestBytes: bigint,
  db: DrizzleDb,
  redis: Redis,
): Promise<QuotaCheckResult> {
  const period = currentBillingPeriod();
  const limitBytes = await getTenantLimit(tenantId, tenantSlug, 'maxMonthlyEgressBytes', db, redis);
  const currentBytes = await getCounterValue(
    egressKey(tenantSlug, period),
    tenantId,
    period,
    'data_out',
    db,
    redis,
  );

  if (currentBytes + requestBytes > limitBytes) {
    return { allowed: false, currentBytes, limitBytes, reason: 'egress_quota_exceeded' };
  }
  return { allowed: true, currentBytes, limitBytes };
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Reads a tenant's quota limit from the Redis meta cache, falling back
 * to Postgres on cache miss. Returns the limit as bigint.
 *
 * @param tenantId - UUID of the tenant.
 * @param slug     - Tenant slug for Redis key.
 * @param field    - The specific limit field to read.
 * @param db       - Drizzle DB instance.
 * @param redis    - ioredis client.
 * @returns The quota limit value as bigint.
 */
async function getTenantLimit(
  tenantId: string,
  slug: string,
  field: 'maxStorageBytes' | 'maxMonthlyIngressBytes' | 'maxMonthlyEgressBytes',
  db: DrizzleDb,
  redis: Redis,
): Promise<bigint> {
  const metaKey = tenantMetaKey(slug);
  const cached = await redis.hget(metaKey, field);

  if (cached !== null) {
    return BigInt(cached);
  }

  // Cache miss — full tenant load and populate
  const rows = await db
    .select({
      maxStorageBytes: tenants.maxStorageBytes,
      maxMonthlyIngressBytes: tenants.maxMonthlyIngressBytes,
      maxMonthlyEgressBytes: tenants.maxMonthlyEgressBytes,
      status: tenants.status,
      maxBuckets: tenants.maxBuckets,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  const tenant = rows[0];
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  // Populate Redis cache
  await redis.hset(metaKey, {
    status: tenant.status,
    maxBuckets: tenant.maxBuckets.toString(),
    maxStorageBytes: tenant.maxStorageBytes.toString(),
    maxMonthlyIngressBytes: tenant.maxMonthlyIngressBytes.toString(),
    maxMonthlyEgressBytes: tenant.maxMonthlyEgressBytes.toString(),
  });
  await redis.expire(metaKey, 300);

  return tenant[field];
}

/**
 * Reads a monthly byte counter from Redis, falling back to Postgres SUM
 * on cache miss. Writes the computed value back to Redis.
 *
 * @param redisKey  - Full Redis key for this counter.
 * @param tenantId  - UUID of the tenant.
 * @param period    - Billing period (YYYY-MM).
 * @param eventType - The event type to sum from usage_metrics.
 * @param db        - Drizzle DB instance.
 * @param redis     - ioredis client.
 * @returns Current counter value as bigint.
 */
async function getCounterValue(
  redisKey: string,
  tenantId: string,
  period: string,
  eventType: 'data_in' | 'data_out',
  db: DrizzleDb,
  redis: Redis,
): Promise<bigint> {
  const cached = await redis.get(redisKey);

  if (cached !== null) {
    return BigInt(cached);
  }

  // Cache miss — compute from Postgres
  const result = await db
    .select({ total: sum(usageMetrics.bytes) })
    .from(usageMetrics)
    .where(
      and(
        eq(usageMetrics.tenantId, tenantId),
        eq(usageMetrics.eventType, eventType),
        eq(usageMetrics.billingPeriod, period),
      ),
    );

  const total = BigInt(result[0]?.total ?? '0');

  // Write back with TTL
  await redis.set(redisKey, total.toString());
  await redis.expire(redisKey, MONTHLY_TTL_SECONDS);

  return total;
}
