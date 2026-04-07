// src/lib/quotaService.ts



import { eq, and, isNull, count } from 'drizzle-orm';
import { tenants, buckets, type Tenant } from '../drizzle/schema.js';
import type { DrizzleDb } from '../db/index.js';
import type { Redis } from 'ioredis';

// ─────────────────────────────────────────────────────────────
// Redis key builders
// ─────────────────────────────────────────────────────────────


function bucketCountKey(tenantSlug: string): string {
  return `quota:${tenantSlug}:bucket_count`;
}


function tenantMetaKey(tenantSlug: string): string {
  return `tenant:${tenantSlug}:meta`;
}

// ─────────────────────────────────────────────────────────────
// Exported functions
// ─────────────────────────────────────────────────────────────

export async function getBucketCount(
  tenantId: string,
  tenantSlug: string,
  db: DrizzleDb,
  redis: Redis,
): Promise<number> {
  const key = bucketCountKey(tenantSlug);
  const cached = await redis.get(key);

  if (cached !== null) {
    return parseInt(cached, 10);
  }

  // Cache miss — count from Postgres
  const result = await db
    .select({ value: count() })
    .from(buckets)
    .where(
      and(
        eq(buckets.tenantId, tenantId),
        isNull(buckets.deletedAt),
      ),
    );

  const bucketCount = result[0]?.value ?? 0;

  // Write back to Redis (no TTL — counter is kept in sync via INCR/DECR)
  await redis.set(key, bucketCount.toString());

  return bucketCount;
}


export async function incrementBucketCount(
  tenantSlug: string,
  redis: Redis,
): Promise<void> {
  const key = bucketCountKey(tenantSlug);
  await redis.incr(key);
}


export async function getTenantQuota(
  tenantId: string,
  tenantSlug: string,
  db: DrizzleDb,
  redis: Redis,
): Promise<
  Pick<
    Tenant,
    'status' | 'maxBuckets' | 'maxStorageBytes' | 'maxMonthlyIngressBytes' | 'maxMonthlyEgressBytes'
  >
> {
  const key = tenantMetaKey(tenantSlug);
  const cached = await redis.hgetall(key);

  // hgetall returns {} on miss (empty object, no keys)
  if (cached && Object.keys(cached).length > 0) {
    return {
      status: cached['status'] as Tenant['status'],
      maxBuckets: parseInt(cached['maxBuckets'], 10),
      maxStorageBytes: BigInt(cached['maxStorageBytes']),
      maxMonthlyIngressBytes: BigInt(cached['maxMonthlyIngressBytes']),
      maxMonthlyEgressBytes: BigInt(cached['maxMonthlyEgressBytes']),
    };
  }

  // Cache miss — query Postgres
  const rows = await db
    .select({
      status: tenants.status,
      maxBuckets: tenants.maxBuckets,
      maxStorageBytes: tenants.maxStorageBytes,
      maxMonthlyIngressBytes: tenants.maxMonthlyIngressBytes,
      maxMonthlyEgressBytes: tenants.maxMonthlyEgressBytes,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  const tenant = rows[0];

  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  // Populate Redis cache
  await redis.hset(key, {
    status: tenant.status,
    maxBuckets: tenant.maxBuckets.toString(),
    maxStorageBytes: tenant.maxStorageBytes.toString(),
    maxMonthlyIngressBytes: tenant.maxMonthlyIngressBytes.toString(),
    maxMonthlyEgressBytes: tenant.maxMonthlyEgressBytes.toString(),
  });
  await redis.expire(key, 300);

  return tenant;
}
