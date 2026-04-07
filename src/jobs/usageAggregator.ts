// src/jobs/usageAggregator.ts

import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DrizzleDb } from '../db/index.js';
import { tenants, invoices, usageMetrics, usageSnapshots, buckets, plans } from '../drizzle/schema.js';
import { enqueueWebhook } from './webhookDispatcher.js';


function msUntilNextFirstOfMonth(): { ms: number; next: Date } {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    1, 0, 5, 0, 0,
  ));
  return { ms: next.getTime() - now.getTime(), next };
}


function previousBillingPeriod(): string {
  const now = new Date();
  // Day 0 of the current month = last day of the previous month
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const year = prev.getUTCFullYear();
  const month = (prev.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}


function scheduleNextAggregation(
  fastify: FastifyInstance,
  db: DrizzleDb,
  redis: Redis,
): NodeJS.Timeout {
  const { ms, next } = msUntilNextFirstOfMonth();

  fastify.log.info(
    `Scheduling next usage aggregation at ${next.toISOString()} (in ${ms}ms)`,
  );

  return setTimeout(async () => {
    const billingPeriod = previousBillingPeriod();
    try {
      fastify.log.info(`Running usage aggregation for period ${billingPeriod}`);
      const result = await runAggregationForPeriod(billingPeriod, db, redis);
      fastify.log.info(
        `Usage aggregation complete: ${result.invoicesCreated} created, ${result.invoicesSkipped} skipped`,
      );
      // Record last successful run for /admin/system/health
      await redis.set('jobs:lastRun:aggregator', new Date().toISOString());
    } catch (err) {
      fastify.log.error(err, 'Usage aggregation failed');
    }

    // Re-schedule; self-correcting — never accumulates drift
    scheduleNextAggregation(fastify, db, redis);
  }, ms);
}


export default async function usageAggregatorPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis },
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  fastify.ready(() => {
    timer = scheduleNextAggregation(fastify, opts.db, opts.redis);
  });

  fastify.addHook('onClose', (_instance, done) => {
    if (timer) clearTimeout(timer);
    done();
  });
}


/** $0.023 per GiB-month = 23,000 ucents per GiB-month */
const STORAGE_UCENTS_PER_GIB_MONTH = 23_000n;
/** Ingress: FREE ($0) */
const INGRESS_UCENTS = 0n;
/** $0.09 per GiB = 90,000 ucents per GiB */
const EGRESS_UCENTS_PER_GIB = 90_000n;
/** $0.50 per bucket-month = 500,000 ucents per bucket */
const BUCKETS_UCENTS_PER_MONTH = 500_000n;
/** $0.004 per 1,000 requests = 4 ucents per request */
const API_UCENTS_PER_REQ = 4n;
/** 1 GiB in bytes, as BigInt */
const GIB_BYTES = 1_073_741_824n;

// ─────────────────────────────────────────────────────────────
// Core aggregation logic — exported for testing
// ─────────────────────────────────────────────────────────────


export async function runAggregationForPeriod(
  period: string,
  db: DrizzleDb,
  redis: Redis,
): Promise<{ invoicesCreated: number; invoicesSkipped: number }> {
  let invoicesCreated = 0;
  let invoicesSkipped = 0;

  // Fetch all active tenants up-front (no N+1 inside the loop)
  const activeTenants = await db
    .select({
      id: tenants.id,
      webhookEndpointUrl: tenants.webhookEndpointUrl,
      planPrice: sql<bigint>`COALESCE(${plans.priceUcentsPerMonth}, 0)`.mapWith(Number),
    })
    .from(tenants)
    .leftJoin(plans, eq(tenants.planId, plans.id))
    .where(eq(tenants.status, 'active'));

  for (const tenant of activeTenants) {
    const lockKey = `invoice:${tenant.id}:${period}`;

    // Wrap everything in a transaction so the advisory lock holds
    await db.transaction(async (tx) => {
      // ── Step 1: Advisory lock ──────────────────────────────
      const lockResult = await tx.execute<{ lockAcquired: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS "lockAcquired"
      `);
      const lockAcquired = lockResult.rows[0]?.lockAcquired;

      if (!lockAcquired) {
        invoicesSkipped++;
        return;
      }

      // ── Step 2: Idempotency check ─────────────────────────
      const existing = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.id),
            eq(invoices.billingPeriod, period),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        console.debug(
          `Skipping invoice for tenant ${tenant.id} period ${period} (already exists)`,
        );
        invoicesSkipped++;
        return;
      }

      // ── Step 3: Aggregate usage_metrics (single SQL) ──────
      const metricsResult = await tx.execute<{
        event_type: string;
        total_bytes: string;
        total_requests: string;
      }>(sql`
        SELECT
          event_type,
          COALESCE(SUM(bytes), 0)          AS total_bytes,
          COALESCE(SUM(request_count), 0)  AS total_requests
        FROM usage_metrics
        WHERE tenant_id = ${tenant.id}
          AND billing_period = ${period}
        GROUP BY event_type
      `);

      let ingressBytes = 0n;
      let egressBytes = 0n;
      let apiRequests = 0n;

      for (const row of metricsResult.rows) {
        const bytes = BigInt(row.total_bytes || '0');
        const reqs = BigInt(row.total_requests || '0');

        switch (row.event_type) {
          case 'data_in':
            ingressBytes += bytes;
            break;
          case 'data_out':
            egressBytes += bytes;
            break;
          case 'api_request':
            apiRequests += reqs;
            break;
          default:
            break;
        }
      }

      // Bucket count: all buckets that existed at any point during the period
      const bucketResult = await tx.execute<{ count: string }>(sql`
        SELECT COUNT(*)::bigint AS count
        FROM buckets
        WHERE tenant_id = ${tenant.id}
          AND created_at < (DATE_TRUNC('month', ${period}::date) + INTERVAL '1 month')
          AND (deleted_at IS NULL OR deleted_at >= DATE_TRUNC('month', ${period}::date))
      `);
      const totalBuckets = BigInt(bucketResult.rows[0]?.count || '0');
      const bucketCountInt = Number(totalBuckets);

      // ── Step 4: Average storage from snapshots ─────────────
      let storageByteAvg = 0n;
      const snapshotResult = await tx.execute<{ avg_bytes: string | null }>(sql`
        SELECT AVG(bytes_stored)::bigint AS avg_bytes
        FROM usage_snapshots
        WHERE tenant_id = ${tenant.id}
          AND DATE_TRUNC('month', snapped_at) = DATE_TRUNC('month', ${period}::date)
      `);

      if (snapshotResult.rows[0]?.avg_bytes != null) {
        storageByteAvg = BigInt(snapshotResult.rows[0].avg_bytes);
      } else {
        // Fall back to sum of lastKnownSizeBytes across active buckets
        const fallbackResult = await tx.execute<{ total: string | null }>(sql`
          SELECT COALESCE(SUM(last_known_size_bytes), 0)::bigint AS total
          FROM buckets
          WHERE tenant_id = ${tenant.id}
            AND deleted_at IS NULL
        `);
        storageByteAvg = BigInt(fallbackResult.rows[0]?.total || '0');
      }

      // ── Step 5: Compute charges (all BigInt, truncation) ──
      const basePlanCharge = BigInt(tenant.planPrice);
      const storageCharge =
        (storageByteAvg * STORAGE_UCENTS_PER_GIB_MONTH) / GIB_BYTES;
      const ingressCharge = INGRESS_UCENTS;
      const egressCharge =
        (egressBytes * EGRESS_UCENTS_PER_GIB) / GIB_BYTES;
      const bucketsCharge = totalBuckets * BUCKETS_UCENTS_PER_MONTH;
      const apiReqCharge = apiRequests * API_UCENTS_PER_REQ;

      const totalChargeUcents =
        basePlanCharge +
        storageCharge +
        ingressCharge +
        egressCharge +
        bucketsCharge +
        apiReqCharge;

      // ── Step 6: Build line items JSON ─────────────────────
      const lineItemsJson = JSON.stringify({
        basePlan: {
          chargeUcents: basePlanCharge.toString(),
        },
        storage: {
          bytes: storageByteAvg.toString(),
          avgGib: (storageByteAvg / GIB_BYTES).toString(),
          chargeUcents: storageCharge.toString(),
        },
        ingress: {
          bytes: ingressBytes.toString(),
          chargeUcents: ingressCharge.toString(),
        },
        egress: {
          bytes: egressBytes.toString(),
          chargeUcents: egressCharge.toString(),
        },
        buckets: {
          count: bucketCountInt,
          chargeUcents: bucketsCharge.toString(),
        },
        apiRequests: {
          count: Number(apiRequests),
          chargeUcents: apiReqCharge.toString(),
        },
        total: {
          chargeUcents: totalChargeUcents.toString(),
        },
      });

      // ── Step 7: INSERT ... ON CONFLICT DO NOTHING ─────────
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

      if (insertResult.rowCount === 1) {
        invoicesCreated++;
        if (tenant.webhookEndpointUrl) {
          const invoiceId = insertResult.rows[0]?.id;
          await enqueueWebhook(tx as unknown as DrizzleDb, {
            tenantId: tenant.id,
            endpointUrl: tenant.webhookEndpointUrl,
            eventType: 'invoice.ready',
            payload: {
              invoiceId,
              period,
              totalChargeUcents: totalChargeUcents.toString(),
            },
          });
        }
      } else {
        console.debug(
          `Silent no-op during invoice insert for tenant ${tenant.id} period ${period}`,
        );
        invoicesSkipped++;
      }

      // ── Step 8: Advisory lock released automatically at tx end
    });
  }

  return { invoicesCreated, invoicesSkipped };
}
