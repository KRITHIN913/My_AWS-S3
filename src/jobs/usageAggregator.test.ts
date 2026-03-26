// src/jobs/usageAggregator.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../drizzle/schema.js';
import { tenants, buckets, usageMetrics, usageSnapshots, invoices, webhookDeliveries } from '../drizzle/schema.js';
import type { DrizzleDb } from '../db/index.js';
import { runAggregationForPeriod } from './usageAggregator.js';
import { enqueueWebhook } from './webhookDispatcher.js';

// Mock enqueueWebhook
vi.mock('./webhookDispatcher.js', () => ({
  enqueueWebhook: vi.fn(),
}));

const { Pool } = pg;
let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;
let redis: InstanceType<typeof Redis>;

beforeAll(async () => {
  pool = new Pool({
    connectionString:
      process.env['DATABASE_URL'] ??
      'postgres://p5_admin:p5_secret@localhost:5432/p5_billing',
  });
  db = drizzle(pool, { schema });
  redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

let testTenantIds: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  testTenantIds = [];
});

afterEach(async () => {
  for (const id of testTenantIds) {
    await db.delete(invoices).where(eq(invoices.tenantId, id));
    await db.delete(usageSnapshots).where(eq(usageSnapshots.tenantId, id));
    await db.delete(usageMetrics).where(eq(usageMetrics.tenantId, id));
    await db.delete(buckets).where(eq(buckets.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
});

async function insertTenant(status: schema.TenantStatus = 'active') {
  const id = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await db.insert(tenants).values({
    id,
    slug,
    displayName: 'Test',
    email: `${slug}@test.com`,
    status,
    webhookEndpointUrl: 'https://example.com/webhook',
  });
  testTenantIds.push(id);
  return id;
}

async function insertBucket(tenantId: string) {
  const id = randomUUID();
  await db.insert(buckets).values({
    id,
    tenantId,
    name: 'test-bucket',
    physicalName: `${randomUUID()}-test`,
    lastKnownSizeBytes: 5000n,
  });
  return id;
}

describe('usageAggregator', () => {
  const period = '2025-06';

  it('runAggregationForPeriod creates a draft invoice for an active tenant', async () => {
    const tenantId = await insertTenant('active');
    
    // Some metrics
    const bucketId = await insertBucket(tenantId);
    await db.insert(usageMetrics).values([
      { tenantId, bucketId, eventType: 'data_in', bytes: 1000n, billingPeriod: period },
      { tenantId, bucketId, eventType: 'data_out', bytes: 2000n, billingPeriod: period },
      { tenantId, bucketId, eventType: 'api_request', requestCount: 50, billingPeriod: period },
    ]);
    
    // Snapshot
    await db.insert(usageSnapshots).values([
      { tenantId, bucketId, bytesStored: 8000n, snappedAt: new Date('2025-06-15T12:00:00Z') }
    ]);

    const result = await runAggregationForPeriod(period, db, redis);
    expect(result.invoicesCreated).toBe(1);
    expect(result.invoicesSkipped).toBe(0);

    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv).toHaveLength(1);
    expect(inv[0].status).toBe('draft');
    expect(inv[0].ingressBytes).toBe(1000n);
    expect(inv[0].egressBytes).toBe(2000n);
    expect(inv[0].apiRequestCount).toBe(50);
    expect(inv[0].storageByteAvg).toBe(8000n);
    
    // Pricing check:
    // API: (50 * 4)/1000 = 0
    // Egress: (2000 * 90000) / GIB_BYTES = 0
    // Storage: (8000 * 23000) / GIB_BYTES = 0
    // Buckets: 1 * 500_000 = 500_000
    // Total = 500_000
    expect(inv[0].totalChargeUcents).toBe(500000n);
  });

  it('runAggregationForPeriod skips tenants with status != active', async () => {
    const tenantId = await insertTenant('suspended');
    const result = await runAggregationForPeriod(period, db, redis);
    
    // no invoices should be created for this tenant
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv).toHaveLength(0);
  });

  it('running twice for the same period produces exactly one invoice (idempotency)', async () => {
    const tenantId = await insertTenant('active');
    
    // 1st run
    const result1 = await runAggregationForPeriod(period, db, redis);
    expect(result1.invoicesCreated).toBe(1);

    // 2nd run
    const result2 = await runAggregationForPeriod(period, db, redis);
    expect(result2.invoicesCreated).toBe(0);
    expect(result2.invoicesSkipped).toBe(1);

    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv).toHaveLength(1);
  });

  it('invoice storageByteAvg is computed from usage_snapshots average, not raw metrics', async () => {
    const tenantId = await insertTenant('active');
    const bucketId = await insertBucket(tenantId);
    
    // Snapshots: 2000, 4000, 6000 -> Avg: 4000
    await db.insert(usageSnapshots).values([
      { tenantId, bucketId, bytesStored: 2000n, snappedAt: new Date('2025-06-05T00:00:00Z') },
      { tenantId, bucketId, bytesStored: 4000n, snappedAt: new Date('2025-06-15T00:00:00Z') },
      { tenantId, bucketId, bytesStored: 6000n, snappedAt: new Date('2025-06-25T00:00:00Z') },
    ]);

    await runAggregationForPeriod(period, db, redis);
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv[0].storageByteAvg).toBe(4000n);
  });

  it('invoice falls back to lastKnownSizeBytes when no snapshots exist', async () => {
    const tenantId = await insertTenant('active');
    const bucketId = await insertBucket(tenantId);
    // lastKnownSizeBytes is 5000n from insertBucket
    // No snapshots inserted

    await runAggregationForPeriod(period, db, redis);
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv[0].storageByteAvg).toBe(5000n);
  });

  it('invoice ingressBytes equals SUM of data_in bytes in usage_metrics for the period', async () => {
    const tenantId = await insertTenant('active');
    const bucketId = await insertBucket(tenantId);
    
    await db.insert(usageMetrics).values([
      { tenantId, bucketId, eventType: 'data_in', bytes: 1500n, billingPeriod: period, idempotencyKey: 'x1' },
      { tenantId, bucketId, eventType: 'data_in', bytes: 2500n, billingPeriod: period, idempotencyKey: 'x2' },
    ]);

    await runAggregationForPeriod(period, db, redis);
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv[0].ingressBytes).toBe(4000n);
  });

  it('invoice egressBytes equals SUM of data_out bytes', async () => {
    const tenantId = await insertTenant('active');
    const bucketId = await insertBucket(tenantId);
    
    await db.insert(usageMetrics).values([
      { tenantId, bucketId, eventType: 'data_out', bytes: 1200n, billingPeriod: period, idempotencyKey: 'y1' },
      { tenantId, bucketId, eventType: 'data_out', bytes: 3800n, billingPeriod: period, idempotencyKey: 'y2' },
    ]);

    await runAggregationForPeriod(period, db, redis);
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv[0].egressBytes).toBe(5000n);
  });

  it('totalChargeUcents is computed correctly using BigInt pricing model', async () => {
    const tenantId = await insertTenant('active');
    
    // We add enough egress to trigger charge.
    // Egress: 90,000 ucents per 1GiB (1073741824 bytes)
    // To get 90,000 charge exactly, we need 1073741824 bytes
    const GIB = 1073741824n;
    
    const bucketId = await insertBucket(tenantId); // Adds 1 bucket => 500,000 ucents
    await db.insert(usageMetrics).values([
      { tenantId, bucketId, eventType: 'data_out', bytes: GIB * 5n, billingPeriod: period }, // 5 GiB -> 450,000
    ]);
    // 500,000 + 450,000 = 950,000

    await runAggregationForPeriod(period, db, redis);
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv[0].totalChargeUcents).toBe(950000n);
  });

  it('lineItemsJson is valid JSON with all required keys', async () => {
    const tenantId = await insertTenant('active');
    await runAggregationForPeriod(period, db, redis);
    
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv[0].lineItemsJson).toBeTypeOf('string');
    
    const parsed = JSON.parse(inv[0].lineItemsJson!);
    expect(parsed).toHaveProperty('storage');
    expect(parsed).toHaveProperty('ingress');
    expect(parsed).toHaveProperty('egress');
    expect(parsed).toHaveProperty('buckets');
    expect(parsed).toHaveProperty('apiRequests');
    expect(parsed).toHaveProperty('total');
    
    expect(parsed.total).toHaveProperty('chargeUcents');
    expect(typeof parsed.total.chargeUcents).toBe('string');
  });

  it('enqueueWebhook is called with event type "invoice.ready" after insert', async () => {
    const tenantId = await insertTenant('active');
    await runAggregationForPeriod(period, db, redis);
    
    expect(enqueueWebhook).toHaveBeenCalledTimes(1);
    expect(enqueueWebhook).toHaveBeenCalledWith(
      expect.anything(), // db transaction
      expect.objectContaining({
        tenantId,
        eventType: 'invoice.ready',
      })
    );
  });

  it('concurrent calls for the same tenant+period: advisory lock means only one succeeds', async () => {
    const tenantId = await insertTenant('active');
    
    // Call 5 times concurrently
    const results = await Promise.all([
      runAggregationForPeriod(period, db, redis),
      runAggregationForPeriod(period, db, redis),
      runAggregationForPeriod(period, db, redis),
      runAggregationForPeriod(period, db, redis),
      runAggregationForPeriod(period, db, redis),
    ]);
    
    let totalCreated = 0;
    let totalSkipped = 0;
    for (const r of results) {
      totalCreated += r.invoicesCreated;
      totalSkipped += r.invoicesSkipped;
    }
    
    expect(totalCreated).toBe(1);
    // Note: Due to pg_try_advisory_xact_lock some might get skipped by lock,
    // others might get skipped by the select for existing. 
    // The sum should be at least 4 skipped.
    expect(totalSkipped).toBeGreaterThanOrEqual(4);
    
    const inv = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    expect(inv).toHaveLength(1);
  });
  
  it('returns { invoicesCreated: N, invoicesSkipped: M } with correct counts', async () => {
    await insertTenant('active'); // tenant 1
    await insertTenant('active'); // tenant 2
    
    const result = await runAggregationForPeriod(period, db, redis);
    expect(result.invoicesCreated).toBe(2);
    expect(result.invoicesSkipped).toBe(0);
  });
});
