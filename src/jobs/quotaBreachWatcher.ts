// src/jobs/quotaBreachWatcher.ts

import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DrizzleDb } from '../db/index.js';
import { tenants, quotaBreachEvents, type BreachType } from '../drizzle/schema.js';
import { enqueueWebhook } from './webhookDispatcher.js';

/** Interval between breach-check runs (5 minutes). */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;


function currentBillingPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}

// ─────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────


export default async function quotaBreachWatcherPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis },
): Promise<void> {
  let timer: NodeJS.Timeout;

  fastify.ready(() => {
    timer = setInterval(async () => {
      try {
        fastify.log.info('Running quota breach watcher');
        const result = await runBreachCheck(opts.db, opts.redis);
        fastify.log.info(
          `Quota breach watcher complete: ${result.breachesDetected} breaches detected`,
        );
        // Record last successful run for /admin/system/health
        await opts.redis.set('jobs:lastRun:breachWatcher', new Date().toISOString());
      } catch (err) {
        fastify.log.error(err, 'Quota breach watcher failed');
      }
    }, CHECK_INTERVAL_MS);
  });

  fastify.addHook('onClose', (_instance, done) => {
    clearInterval(timer);
    done();
  });
}

// ─────────────────────────────────────────────────────────────
// Core breach-check logic — exported for testing
// ─────────────────────────────────────────────────────────────


interface ResourceCheck {
  /** Resource identifier used to build the breach type enum value */
  name: 'storage' | 'ingress' | 'egress' | 'bucket';
  /** Current usage value (from Redis) */
  current: bigint;
  /** Limit value (from tenant meta) */
  limit: bigint;
}



export async function runBreachCheck(
  db: DrizzleDb,
  redis: Redis,
): Promise<{ breachesDetected: number }> {
  let breachesDetected = 0;
  const period = currentBillingPeriod();

  // Load all active tenants up-front to avoid N+1 queries
  const activeTenants = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      status: tenants.status,
      webhookEndpointUrl: tenants.webhookEndpointUrl,
      maxBuckets: tenants.maxBuckets,
      maxStorageBytes: tenants.maxStorageBytes,
      maxMonthlyIngressBytes: tenants.maxMonthlyIngressBytes,
      maxMonthlyEgressBytes: tenants.maxMonthlyEgressBytes,
    })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  for (const tenant of activeTenants) {
    // ── Step 1: Load limits from Redis (cache with TTL 300s) ──
    const metaKey = `tenant:${tenant.slug}:meta`;
    let meta = await redis.hgetall(metaKey);

    if (Object.keys(meta).length === 0) {
      // Cache miss — populate from Postgres
      meta = {
        status: tenant.status,
        maxBuckets: tenant.maxBuckets.toString(),
        maxStorageBytes: tenant.maxStorageBytes.toString(),
        maxMonthlyIngressBytes: tenant.maxMonthlyIngressBytes.toString(),
        maxMonthlyEgressBytes: tenant.maxMonthlyEgressBytes.toString(),
      };
      await redis.hset(metaKey, meta);
      await redis.expire(metaKey, 300);
    }

    const maxStorageBytes = BigInt(meta['maxStorageBytes'] ?? tenant.maxStorageBytes.toString());
    const maxIngressBytes = BigInt(meta['maxMonthlyIngressBytes'] ?? tenant.maxMonthlyIngressBytes.toString());
    const maxEgressBytes = BigInt(meta['maxMonthlyEgressBytes'] ?? tenant.maxMonthlyEgressBytes.toString());
    const maxBuckets = BigInt(meta['maxBuckets'] ?? tenant.maxBuckets.toString());

    // ── Step 2: Read current counters from Redis ─────────────
    const [storageStr, ingressStr, egressStr, bucketsStr] = await Promise.all([
      redis.get(`quota:${tenant.slug}:storage_bytes`),
      redis.get(`quota:${tenant.slug}:ingress:${period}`),
      redis.get(`quota:${tenant.slug}:egress:${period}`),
      redis.get(`quota:${tenant.slug}:bucket_count`),
    ]);

    const storageBytes = BigInt(storageStr || '0');
    const ingressBytes = BigInt(ingressStr || '0');
    const egressBytes = BigInt(egressStr || '0');
    const bucketCount = BigInt(bucketsStr || '0');

    const resources: ResourceCheck[] = [
      { name: 'storage', current: storageBytes, limit: maxStorageBytes },
      { name: 'ingress', current: ingressBytes, limit: maxIngressBytes },
      { name: 'egress', current: egressBytes, limit: maxEgressBytes },
      { name: 'bucket', current: bucketCount, limit: maxBuckets },
    ];

    let suspendTenant = false;

    // ── Step 3: Evaluate each resource ───────────────────────
    for (const res of resources) {
      if (res.limit <= 0n) continue; // Prevent division by zero

      const usagePct = (res.current * 100n) / res.limit;
      let breachType: BreachType | null = null;
      let eventTypeString: 'quota.breach' | 'quota.warning' | null = null;

      if (usagePct >= 100n) {
        breachType = `${res.name}_exceeded` as BreachType;
        eventTypeString = 'quota.breach';
        if (res.name === 'storage') {
          suspendTenant = true;
        }
      } else if (usagePct >= 80n) {
        breachType = `${res.name}_warning` as BreachType;
        eventTypeString = 'quota.warning';
      }

      if (breachType && eventTypeString) {
        // Deduplicate: has this exact breach been recorded in the last 24 hours?
        const recentResult = await db.execute<{ id: string }>(sql`
          SELECT id FROM quota_breach_events
          WHERE tenant_id = ${tenant.id}
            AND breach_type = ${breachType}::breach_type
            AND billing_period = ${period}
            AND detected_at > NOW() - INTERVAL '24 hours'
          LIMIT 1
        `);

        if (recentResult.rows.length === 0) {
          // Record new breach event
          await db.execute(sql`
            INSERT INTO quota_breach_events (
              tenant_id,
              breach_type,
              current_value,
              limit_value,
              billing_period
            ) VALUES (
              ${tenant.id},
              ${breachType}::breach_type,
              ${res.current},
              ${res.limit},
              ${period}
            )
          `);

          breachesDetected++;

          // Enqueue webhook notification
          if (tenant.webhookEndpointUrl) {
            await enqueueWebhook(db, {
              tenantId: tenant.id,
              endpointUrl: tenant.webhookEndpointUrl,
              eventType: eventTypeString,
              payload: {
                breachType,
                currentValue: res.current.toString(),
                limitValue: res.limit.toString(),
                period,
              },
            });
          }
        }
      }
    }

    // ── Step 4: Auto-suspend on storage_exceeded ─────────────
    if (suspendTenant) {
      console.warn(
        `[WARN] Suspending tenant ${tenant.id} (slug: ${tenant.slug}) ` +
        `due to storage quota exceeded. Current: ${storageBytes}, Limit: ${maxStorageBytes}`,
      );

      await db.execute(sql`
        UPDATE tenants
        SET status = 'suspended', updated_at = NOW()
        WHERE id = ${tenant.id} AND status = 'active'
      `);

      // Update Redis cache to reflect suspension
      await redis.hset(metaKey, 'status', 'suspended');
    }
  }

  return { breachesDetected };
}
