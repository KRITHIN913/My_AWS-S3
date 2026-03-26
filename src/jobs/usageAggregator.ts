// src/jobs/usageAggregator.ts
/**
 * Monthly Usage Aggregator Job
 * 
 * Aggregates raw usage_metrics into finalised invoices.
 * Guaranteed idempotent via Postgres advisory locks and ON CONFLICT DO NOTHING.
 * Runs inside the Fastify process using a self-correcting wall-clock interval.
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DrizzleDb } from '../db/index.js';
import { tenants, invoices, usageMetrics, usageSnapshots } from '../drizzle/schema.js';
import { enqueueWebhook } from './webhookDispatcher.js';

/**
 * Ensures a self-correcting timer aligned to 00:05:00 UTC on the 1st of the month.
 */
function scheduleNextAggregation(fastify: FastifyInstance, db: DrizzleDb, redis: Redis) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5, 0));
  
  const msUntilNext = next.getTime() - now.getTime();
  
  fastify.log.info(`Scheduling next usage aggregation at ${next.toISOString()} (in ${msUntilNext}ms)`);
  
  setTimeout(async () => {
    try {
      // We run for the PREVIOUS month
      const billingPeriodStr = `${now.getUTCFullYear()}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}`;
      fastify.log.info(`Running usage aggregation for period ${billingPeriodStr}`);
      const result = await runAggregationForPeriod(billingPeriodStr, db, redis);
      fastify.log.info(`Usage aggregation complete: ${result.invoicesCreated} created, ${result.invoicesSkipped} skipped`);
    } catch (err) {
      fastify.log.error(err, 'Usage aggregation failed');
    }
    
    // Schedule the next one recursively to self-correct drift
    scheduleNextAggregation(fastify, db, redis);
  }, msUntilNext);
}

/**
 * Fastify plugin for the usage aggregator job.
 */
export default async function usageAggregatorPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis },
): Promise<void> {
  fastify.ready(() => {
    scheduleNextAggregation(fastify, opts.db, opts.redis);
  });
}

/**
 * Internal function to export for testing.
 * Runs aggregation for a given YYYY-MM period against all active tenants.
 */
export async function runAggregationForPeriod(
  period: string, // 'YYYY-MM'
  db: DrizzleDb,
  redis: Redis,
): Promise<{ invoicesCreated: number; invoicesSkipped: number }> {
  let invoicesCreated = 0;
  let invoicesSkipped = 0;

  // Pricing Model (Hardcoded BigInt values)
  const STORAGE_UCENTS_PER_GIB_MONTH = 23_000n;
  const EGRESS_UCENTS_PER_GIB = 90_000n;
  const BUCKETS_UCENTS_PER_MONTH = 500_000n;
  const API_REQ_UCENTS_PER_1000 = 4n;
  const GIB_BYTES = 1073741824n;

  // We only run for tenants that are 'active'
  const activeTenants = await db
    .select({
      id: tenants.id,
      webhookEndpointUrl: tenants.webhookEndpointUrl,
    })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  for (const tenant of activeTenants) {
    if (!tenant.id) continue;
    
    // 1. Acquire Postgres advisory lock
    // Use hashtext to convert 'invoice:tenantId:period' into a 32-bit integer for the lock
    const lockKey = `invoice:${tenant.id}:${period}`;
    const [{ lockAcquired }] = await db.execute<{ lockAcquired: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) as "lockAcquired"
    `);

    // We must execute this inside a transaction so the advisory lock holds for the duration
    // Actually, pg_try_advisory_xact_lock only makes sense inside a transaction block.
    // If not in a transaction, it acquires and releases immediately or fails.
    // Let's use a transaction manually.
    await db.transaction(async (tx) => {
      const [{ lockAcquired }] = await tx.execute<{ lockAcquired: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) as "lockAcquired"
      `);

      if (!lockAcquired) {
        // Another instance is processing this tenant+period
        invoicesSkipped++;
        return;
      }

      // 2. Check for existing invoice
      const existing = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.id),
            eq(invoices.billingPeriod, period)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        console.debug(`Skipping invoice for tenant ${tenant.id} period ${period} (already exists)`);
        invoicesSkipped++;
        return;
      }

      // 3. Aggregate usage_metrics for this tenant + period using a SINGLE SQL query
      const metricsCounts = await tx.execute<{
        event_type: string;
        total_bytes: string;
        total_requests: string;
      }>(sql`
        SELECT
          event_type,
          SUM(bytes) AS total_bytes,
          SUM(request_count) AS total_requests
        FROM usage_metrics
        WHERE tenant_id = ${tenant.id}
          AND billing_period = ${period}
        GROUP BY event_type
      `);

      let ingressBytes = 0n;
      let egressBytes = 0n;
      let apiRequests = 0n;
      let totalBuckets = 0n;

      for (const row of metricsCounts) {
        const bytes = BigInt(row.total_bytes || 0);
        const reqs = BigInt(row.total_requests || 0);
        
        if (row.event_type === 'data_in') {
          ingressBytes += bytes;
        } else if (row.event_type === 'data_out') {
          egressBytes += bytes;
        } else if (row.event_type === 'api_request') {
          apiRequests += reqs;
        } else if (row.event_type === 'bucket_created') {
          // Note: totalBuckets might be more complex if we just use current count
          // The spec says "number of buckets active at any point" but didn't specify
          // exactly how to aggregate it in metrics, we'll try to find from DB for this period
        }
      }

      // The spec states: "Total number of buckets active at any point in the period"
      // We'll calculate bucket count using the buckets table
      const bucketResult = await tx.execute<{ count: number }>(sql`
        SELECT COUNT(*)::integer AS count
        FROM buckets
        WHERE tenant_id = ${tenant.id}
          AND created_at < (DATE_TRUNC('month', ${period}::date) + INTERVAL '1 month')
          AND (deleted_at IS NULL OR deleted_at >= DATE_TRUNC('month', ${period}::date))
      `);
      totalBuckets = BigInt(bucketResult[0]?.count || 0);
      const bucketCountInt = Number(totalBuckets);

      // 4. Aggregate storage snapshots
      // (Fall back to lastKnownSizeBytes if no snapshots exist)
      let storageByteAvg = 0n;
      const snapshotResult = await tx.execute<{ avg_bytes: string | null }>(sql`
        SELECT AVG(bytes_stored)::bigint AS avg_bytes
        FROM usage_snapshots
        WHERE tenant_id = ${tenant.id}
          AND DATE_TRUNC('month', snapped_at) = DATE_TRUNC('month', ${period}::date)
      `);
      
      if (snapshotResult[0]?.avg_bytes != null) {
        storageByteAvg = BigInt(snapshotResult[0].avg_bytes);
      } else {
        const fallbackResult = await tx.execute<{ sum: string | null }>(sql`
          SELECT SUM(last_known_size_bytes)::bigint as sum
          FROM buckets
          WHERE tenant_id = ${tenant.id} AND deleted_at IS NULL
        `);
        storageByteAvg = BigInt(fallbackResult[0]?.sum || 0);
      }

      // 5. Compute charges using PRICING MODEL. All BigInt arithmetic
      const storageCharge = (storageByteAvg * STORAGE_UCENTS_PER_GIB_MONTH) / GIB_BYTES;
      const ingressCharge = 0n; // FREE
      const egressCharge = (egressBytes * EGRESS_UCENTS_PER_GIB) / GIB_BYTES;
      const bucketsCharge = totalBuckets * BUCKETS_UCENTS_PER_MONTH;
      const apiReqCharge = (apiRequests * API_REQ_UCENTS_PER_1000) / 1000n;
      
      const totalChargeUcents = storageCharge + ingressCharge + egressCharge + bucketsCharge + apiReqCharge;

      // 6. Build lineItemsJson
      const lineItemsJson = JSON.stringify({
        storage: { 
          bytes: storageByteAvg.toString(), 
          avgGib: (storageByteAvg / GIB_BYTES).toString(), 
          chargeUcents: storageCharge.toString() 
        },
        ingress: { 
          bytes: ingressBytes.toString(), 
          chargeUcents: ingressCharge.toString() 
        },
        egress: { 
          bytes: egressBytes.toString(), 
          chargeUcents: egressCharge.toString() 
        },
        buckets: { 
          count: bucketCountInt, 
          chargeUcents: bucketsCharge.toString() 
        },
        apiRequests: { 
          count: Number(apiRequests), 
          chargeUcents: apiReqCharge.toString() 
        },
        total: { 
          chargeUcents: totalChargeUcents.toString() 
        }
      });

      // 7. INSERT INTO invoices ... ON CONFLICT
      // using returning id to verify it wasn't a no-op
      const insertResult = await tx.execute<{ id: string }>(sql`
        INSERT INTO invoices (
          tenant_id,
          billing_period,
          status,
          storage_byte_avg,
          ingress_bytes,
          egress_bytes,
          bucket_count,
          api_request_count,
          total_charge_ucents,
          line_items_json
        ) VALUES (
          ${tenant.id},
          ${period},
          'draft',
          ${storageByteAvg},
          ${ingressBytes},
          ${egressBytes},
          ${bucketCountInt},
          ${Number(apiRequests)},
          ${totalChargeUcents},
          ${lineItemsJson}
        )
        ON CONFLICT (tenant_id, billing_period) DO NOTHING
        RETURNING id
      `);

      if (insertResult.length === 1) {
        // Insert succeeded (not a no-op)
        invoicesCreated++;
        if (tenant.webhookEndpointUrl) {
          await enqueueWebhook(tx, {
            tenantId: tenant.id!,
            endpointUrl: tenant.webhookEndpointUrl,
            eventType: 'invoice.ready',
            payload: { invoiceId: insertResult[0].id, period, totalChargeUcents: totalChargeUcents.toString() }
          });
        }
      } else {
        console.debug(`Silent no-op during invoice insert for tenant ${tenant.id} period ${period}`);
        invoicesSkipped++;
      }
      
      // 8. Release advisory lock (automatic at transaction end)
    });
  }

  return { invoicesCreated, invoicesSkipped };
}
