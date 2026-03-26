// src/jobs/quotaBreachWatcher.ts
/**
 * Quota Breach Watcher Job
 * 
 * Runs every 5 minutes to detect and alert on quota breaches.
 * Reads hot counters from Redis and inserts breach events into Postgres.
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DrizzleDb } from '../db/index.js';
import { tenants, quotaBreachEvents, type BreachType } from '../drizzle/schema.js';
import { enqueueWebhook } from './webhookDispatcher.js';

/**
 * Returns the current billing period in 'YYYY-MM' format.
 */
function currentBillingPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}

export default async function quotaBreachWatcherPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis },
): Promise<void> {
  let timer: NodeJS.Timeout;

  fastify.ready(() => {
    // Run every 5 minutes
    timer = setInterval(async () => {
      try {
        fastify.log.info('Running quota breach watcher');
        const result = await runBreachCheck(opts.db, opts.redis);
        fastify.log.info(`Quota breach watcher complete: ${result.breachesDetected} breaches detected`);
      } catch (err) {
        fastify.log.error(err, 'Quota breach watcher failed');
      }
    }, 5 * 60 * 1000);
  });

  fastify.addHook('onClose', (instance, done) => {
    clearInterval(timer);
    done();
  });
}

/**
 * Internal function exported for testing.
 */
export async function runBreachCheck(
  db: DrizzleDb,
  redis: Redis,
): Promise<{ breachesDetected: number }> {
  let breachesDetected = 0;
  const currentPeriod = currentBillingPeriod();

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
    if (!tenant.id || !tenant.slug) continue;

    // 1. Load quota limits from Redis. On miss: load from Postgres and cache.
    const metaKey = `tenant:${tenant.slug}:meta`;
    let meta = await redis.hgetall(metaKey);

    if (Object.keys(meta).length === 0) {
      // Cache miss
      meta = {
        status: tenant.status,
        maxBuckets: tenant.maxBuckets.toString(),
        maxStorageBytes: tenant.maxStorageBytes.toString(),
        maxMonthlyIngressBytes: tenant.maxMonthlyIngressBytes.toString(),
        maxMonthlyEgressBytes: tenant.maxMonthlyEgressBytes.toString(),
      };
      await redis.hset(metaKey, meta);
      await redis.expire(metaKey, 300); // 5 minutes TTL
    }

    const maxStorageBytes = BigInt(meta.maxStorageBytes ?? tenant.maxStorageBytes);
    const maxIngressBytes = BigInt(meta.maxMonthlyIngressBytes ?? tenant.maxMonthlyIngressBytes);
    const maxEgressBytes = BigInt(meta.maxMonthlyEgressBytes ?? tenant.maxMonthlyEgressBytes);
    const maxBuckets = BigInt(meta.maxBuckets ?? tenant.maxBuckets);

    // 2. Read current counters from Redis
    const [storageStr, ingressStr, egressStr, bucketsStr] = await Promise.all([
      redis.get(`quota:${tenant.slug}:storage_bytes`),
      redis.get(`quota:${tenant.slug}:ingress:${currentPeriod}`),
      redis.get(`quota:${tenant.slug}:egress:${currentPeriod}`),
      redis.get(`quota:${tenant.slug}:bucket_count`),
    ]);

    const storageBytes = BigInt(storageStr || '0');
    const ingressBytes = BigInt(ingressStr || '0');
    const egressBytes = BigInt(egressStr || '0');
    const bucketCount = BigInt(bucketsStr || '0');

    const resources = [
      { name: 'storage', current: storageBytes, limit: maxStorageBytes },
      { name: 'ingress', current: ingressBytes, limit: maxIngressBytes },
      { name: 'egress', current: egressBytes, limit: maxEgressBytes },
      { name: 'bucket', current: bucketCount, limit: maxBuckets },
    ];

    let suspendTenant = false;

    // 3. For each resource
    for (const res of resources) {
      if (res.limit <= 0n) continue; // Prevent division by zero if limit is inexplicably 0

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
        // Check if recorded in last 24h
        const recent = await db.execute<{ id: string }>(sql`
          SELECT id FROM quota_breach_events
          WHERE tenant_id = ${tenant.id}
            AND breach_type = ${breachType}::breach_type
            AND billing_period = ${currentPeriod}
            AND detected_at > NOW() - INTERVAL '24 hours'
          LIMIT 1
        `);

        if (recent.length === 0) {
          // Record breach
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
              ${currentPeriod}
            )
          `);
          
          breachesDetected++;

          // Enqueue webhook
          if (tenant.webhookEndpointUrl) {
            await enqueueWebhook(db, {
              tenantId: tenant.id!,
              endpointUrl: tenant.webhookEndpointUrl,
              eventType: eventTypeString,
              payload: {
                breachType,
                currentValue: res.current.toString(),
                limitValue: res.limit.toString(),
                period: currentPeriod
              }
            });
          }
        }
      }
    }

    // 4. Auto-suspend tenant if ANY resource is at storage_exceeded
    // Implementation constraint: only suspend if they were active (prevent suspend-loop)
    // Filtered by `activeTenants` query so they are currently active.
    if (suspendTenant) {
      console.warn(`[WARN] Suspending tenant ${tenant.id} due to storage quota exceeded. Current: ${storageBytes}, Limit: ${maxStorageBytes}`);
      
      await db.execute(sql`
        UPDATE tenants 
        SET status = 'suspended', updated_at = NOW()
        WHERE id = ${tenant.id} AND status = 'active'
      `);
      
      // Update redis cache
      await redis.hset(metaKey, 'status', 'suspended');
    }
  }

  return { breachesDetected };
}
