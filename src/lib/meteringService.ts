// src/lib/meteringService.ts



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
