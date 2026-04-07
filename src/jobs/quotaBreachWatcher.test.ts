// src/jobs/quotaBreachWatcher.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../drizzle/schema.js';
import { tenants, quotaBreachEvents, webhookDeliveries } from '../drizzle/schema.js';
import type { DrizzleDb } from '../db/index.js';
import { runBreachCheck } from './quotaBreachWatcher.js';
import { enqueueWebhook } from './webhookDispatcher.js';

vi.mock('./webhookDispatcher.js', () => ({
  enqueueWebhook: vi.fn(),
}));

const { Pool } = pg;
let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;
let redis: InstanceType<typeof Redis>;

/**
 * Returns the current billing period in 'YYYY-MM' format (UTC).
 */
function currentBillingPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}

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
const period = currentBillingPeriod();

beforeEach(async () => {
  vi.clearAllMocks();
  testTenantIds = [];
});

afterEach(async () => {
  for (const id of testTenantIds) {
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.tenantId, id));
    await db.delete(quotaBreachEvents).where(eq(quotaBreachEvents.tenantId, id));
    // Reset tenant status back to original before deleting
    await db.delete(tenants).where(eq(tenants.id, id));
  }

  // Clean up Redis test keys
  const tKeys = await redis.keys('tenant:t-*');
  const qKeys = await redis.keys('quota:t-*');
  if (tKeys.length > 0) await redis.del(...tKeys);
  if (qKeys.length > 0) await redis.del(...qKeys);
});

/**
 * Helper: insert a tenant with specified quota limits.
 */
async function insertTenant(
  status: schema.TenantStatus = 'active',
  maxStorageBytes = 1000n,
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await db.insert(tenants).values({
    id,
    slug,
    displayName: 'Test',
    email: `${slug}@test.com`,
    status,
    maxStorageBytes,
    maxMonthlyIngressBytes: 1000n,
    maxMonthlyEgressBytes: 1000n,
    maxBuckets: 10,
    webhookEndpointUrl: 'https://example.com/webhook',
    webhookSecret: 'test-secret',
  });
  testTenantIds.push(id);
  return { id, slug };
}

describe('quotaBreachWatcher', () => {
  // ─── Test 1 ──────────────────────────────────────────────
  it('detects storage_exceeded when storage_bytes >= maxStorageBytes', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '1000');

    const result = await runBreachCheck(db, redis);
    expect(result.breachesDetected).toBe(1);

    const breaches = await db
      .select()
      .from(quotaBreachEvents)
      .where(eq(quotaBreachEvents.tenantId, id));
    expect(breaches).toHaveLength(1);
    expect(breaches[0].breachType).toBe('storage_exceeded');
  });

  // ─── Test 2 ──────────────────────────────────────────────
  it('detects storage_warning when storage_bytes >= 80% of maxStorageBytes', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '850');

    const result = await runBreachCheck(db, redis);
    expect(result.breachesDetected).toBe(1);

    const breaches = await db
      .select()
      .from(quotaBreachEvents)
      .where(eq(quotaBreachEvents.tenantId, id));
    expect(breaches).toHaveLength(1);
    expect(breaches[0].breachType).toBe('storage_warning');
  });

  // ─── Test 3 ──────────────────────────────────────────────
  it('detects ingress_exceeded for current billing period', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:ingress:${period}`, '1200');

    const result = await runBreachCheck(db, redis);
    expect(result.breachesDetected).toBe(1);

    const breaches = await db
      .select()
      .from(quotaBreachEvents)
      .where(eq(quotaBreachEvents.tenantId, id));
    expect(breaches[0].breachType).toBe('ingress_exceeded');
  });

  // ─── Test 4 ──────────────────────────────────────────────
  it('detects egress_warning threshold correctly', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:egress:${period}`, '800'); // exactly 80%

    const result = await runBreachCheck(db, redis);
    expect(result.breachesDetected).toBe(1);

    const breaches = await db
      .select()
      .from(quotaBreachEvents)
      .where(eq(quotaBreachEvents.tenantId, id));
    expect(breaches[0].breachType).toBe('egress_warning');
  });

  // ─── Test 5 ──────────────────────────────────────────────
  it('does NOT insert duplicate breach event within 24h window', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '1000');

    // 1st run
    const result1 = await runBreachCheck(db, redis);
    expect(result1.breachesDetected).toBe(1);

    // Reset tenant status since storage_exceeded suspends
    await db.execute(sql`
      UPDATE tenants SET status = 'active' WHERE id = ${id}
    `);

    // 2nd run immediately — should deduplicate
    const result2 = await runBreachCheck(db, redis);
    expect(result2.breachesDetected).toBe(0);

    const breaches = await db
      .select()
      .from(quotaBreachEvents)
      .where(eq(quotaBreachEvents.tenantId, id));
    expect(breaches).toHaveLength(1);
  });

  // ─── Test 6 ──────────────────────────────────────────────
  it('DOES insert a new breach event after 24h has elapsed', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '1000');

    // Insert old breach record 25 hours ago to simulate elapsed window
    await db.execute(sql`
      INSERT INTO quota_breach_events
        (tenant_id, breach_type, current_value, limit_value, billing_period, detected_at)
      VALUES
        (${id}, 'storage_exceeded'::breach_type, 1000, 1000, ${period}, NOW() - INTERVAL '25 hours')
    `);

    const result = await runBreachCheck(db, redis);
    expect(result.breachesDetected).toBe(1);

    const breaches = await db
      .select()
      .from(quotaBreachEvents)
      .where(eq(quotaBreachEvents.tenantId, id));
    expect(breaches).toHaveLength(2); // Old + new
  });

  // ─── Test 7 ──────────────────────────────────────────────
  it('suspends tenant when storage_exceeded and status was active', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '1000');

    await runBreachCheck(db, redis);

    const t = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(t[0].status).toBe('suspended');

    // Verify Redis cache reflects suspension
    const cachedStatus = await redis.hget(`tenant:${slug}:meta`, 'status');
    expect(cachedStatus).toBe('suspended');
  });

  // ─── Test 8 ──────────────────────────────────────────────
  it('does NOT suspend tenant that is already suspended', async () => {
    const { id, slug } = await insertTenant('suspended', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '1000');

    // runBreachCheck only iterates active tenants
    const result = await runBreachCheck(db, redis);
    expect(result.breachesDetected).toBe(0);

    const t = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(t[0].status).toBe('suspended');
  });

  // ─── Test 9 ──────────────────────────────────────────────
  it('enqueueWebhook called with quota.breach on _exceeded types', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '1000');

    await runBreachCheck(db, redis);

    expect(enqueueWebhook).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tenantId: id,
        eventType: 'quota.breach',
        payload: expect.objectContaining({
          breachType: 'storage_exceeded',
        }),
      }),
    );
  });

  // ─── Test 10 ─────────────────────────────────────────────
  it('enqueueWebhook called with quota.warning on _warning types', async () => {
    const { id, slug } = await insertTenant('active', 1000n);
    await redis.set(`quota:${slug}:storage_bytes`, '850');

    await runBreachCheck(db, redis);

    expect(enqueueWebhook).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tenantId: id,
        eventType: 'quota.warning',
        payload: expect.objectContaining({
          breachType: 'storage_warning',
        }),
      }),
    );
  });

  // ─── Test 11 ─────────────────────────────────────────────
  it('returns { breachesDetected: N } with correct count', async () => {
    const t1 = await insertTenant('active', 1000n);
    await redis.set(`quota:${t1.slug}:storage_bytes`, '1000'); // exceeded

    const t2 = await insertTenant('active', 1000n);
    await redis.set(`quota:${t2.slug}:storage_bytes`, '850'); // warning

    const result = await runBreachCheck(db, redis);
    expect(result.breachesDetected).toBe(2);
  });
});
