// src/lib/quotaService.ts

/**
 * Quota Service
 *
 * Encapsulates all quota-related operations for multi-tenant S3 billing.
 * This module is a pure service — no Fastify dependency. Route handlers
 * call these functions, passing in the DB and Redis clients explicitly.
 *
 * Design:
 *   - Redis is the "hot" cache for fast quota checks on the request path.
 *   - PostgreSQL is the durable source of truth.
 *   - On Redis cache miss, we query Postgres and write back to Redis.
 *   - Redis keys are namespaced by tenant slug to prevent cross-tenant leaks.
 */

import { eq, and, isNull, count } from 'drizzle-orm';
import { tenants, buckets, type Tenant } from '../drizzle/schema.js';
import type { DrizzleDb } from '../db/index.js';
import type { Redis } from 'ioredis';

// ─────────────────────────────────────────────────────────────
// Redis key builders
// ─────────────────────────────────────────────────────────────

/**
 * Builds the Redis key for a tenant's active bucket count.
 * @param tenantSlug - The tenant's URL-safe slug.
 * @returns The fully-qualified Redis key.
 */
function bucketCountKey(tenantSlug: string): string {
  return `quota:${tenantSlug}:bucket_count`;
}

/**
 * Builds the Redis key for cached tenant quota metadata.
 * @param tenantSlug - The tenant's URL-safe slug.
 * @returns The fully-qualified Redis key.
 */
function tenantMetaKey(tenantSlug: string): string {
  return `tenant:${tenantSlug}:meta`;
}

// ─────────────────────────────────────────────────────────────
// Exported functions
// ─────────────────────────────────────────────────────────────

/**
 * Returns the current active (non-soft-deleted) bucket count for a tenant.
 *
 * Strategy:
 *   1. Try Redis `GET quota:{slug}:bucket_count`.
 *   2. On miss, `COUNT(*)` from `buckets` where `deleted_at IS NULL`.
 *   3. Write the count back to Redis.
 *
 * @param tenantId   - UUID of the tenant (used for the Postgres query).
 * @param tenantSlug - Slug of the tenant (used for the Redis key).
 * @param db         - Drizzle database instance.
 * @param redis      - ioredis client instance.
 * @returns The number of active buckets owned by the tenant.
 */
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

/**
 * Increments the bucket counter in Redis by 1.
 *
 * This does NOT touch Postgres — Postgres is updated transactionally
 * by the route handler. Redis is a best-effort hot counter.
 *
 * @param tenantSlug - Slug of the tenant (used for the Redis key).
 * @param redis      - ioredis client instance.
 */
export async function incrementBucketCount(
  tenantSlug: string,
  redis: Redis,
): Promise<void> {
  const key = bucketCountKey(tenantSlug);
  await redis.incr(key);
}

/**
 * Returns cached tenant quota limits from Redis.
 * On cache miss, loads the full tenant row from Postgres, populates
 * Redis with an HSET + 300-second TTL, and returns the quota fields.
 *
 * Cached fields:
 *   - status
 *   - maxBuckets
 *   - maxStorageBytes
 *   - maxMonthlyIngressBytes
 *   - maxMonthlyEgressBytes
 *
 * @param tenantId   - UUID of the tenant.
 * @param tenantSlug - Slug of the tenant (used for Redis key).
 * @param db         - Drizzle database instance.
 * @param redis      - ioredis client instance.
 * @returns An object containing the tenant's quota limits and status.
 * @throws Error if the tenant does not exist in Postgres.
 */
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
