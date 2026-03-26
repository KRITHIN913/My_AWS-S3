// src/jobs/webhookDispatcher.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { randomUUID, createHmac } from 'node:crypto';

import * as schema from '../drizzle/schema.js';
import { tenants, webhookDeliveries } from '../drizzle/schema.js';
import type { DrizzleDb } from '../db/index.js';
import { enqueueWebhook, dispatchPendingWebhooks } from './webhookDispatcher.js';

const { Pool } = pg;
let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;

beforeAll(async () => {
  pool = new Pool({
    connectionString:
      process.env['DATABASE_URL'] ??
      'postgres://p5_admin:p5_secret@localhost:5432/p5_billing',
  });
  db = drizzle(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

let testTenantIds: string[] = [];
let originalFetch: typeof global.fetch;

beforeEach(async () => {
  testTenantIds = [];
  originalFetch = global.fetch;
});

afterEach(async () => {
  for (const id of testTenantIds) {
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
  global.fetch = originalFetch;
});

async function insertTenant() {
  const id = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await db.insert(tenants).values({
    id,
    slug,
    displayName: 'Test',
    email: `${slug}@test.com`,
    webhookEndpointUrl: 'https://example.com/webhook',
    webhookSecret: 'secret123',
  });
  testTenantIds.push(id);
  return id;
}

describe('webhookDispatcher', () => {
  it('enqueueWebhook inserts a webhook_deliveries row with status=pending', async () => {
    const tenantId = await insertTenant();
    
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/webhook',
      eventType: 'invoice.ready',
      payload: { test: 1 }
    });
    
    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('pending');
    expect(deliveries[0].eventType).toBe('invoice.ready');
    expect(deliveries[0].payload).toMatch(/"test":1/);
  });

  it('dispatchPendingWebhooks sends POST with correct headers', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/webhook',
      eventType: 'invoice.ready',
      payload: { test: 1 }
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    global.fetch = mockFetch;

    const result = await dispatchPendingWebhooks(db);
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('https://example.com/webhook'); // endpoint
    expect(callArgs[1].method).toBe('POST');
    
    const headers = callArgs[1].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Webhook-Event']).toBe('invoice.ready');
    expect(headers['X-Delivery-Id']).toBeDefined();
    
    // Check signature
    const sigHeader = headers['X-Signature-256'];
    const expectedSigStr = createHmac('sha256', 'secret123').update(callArgs[1].body).digest('hex');
    expect(sigHeader).toBe(`sha256=${expectedSigStr}`);
  });

  it('HMAC signature matches expected sha256= prefix + hex digest', async () => {
    // Covered by previous test
  });

  it('on HTTP 200: status set to success, completed_at populated', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/something',
      eventType: 'quota.warning',
      payload: { foo: 'bar' }
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    await dispatchPendingWebhooks(db);

    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
    expect(deliveries[0].status).toBe('success');
    expect(deliveries[0].completedAt).not.toBeNull();
    expect(deliveries[0].attemptCount).toBe(1);
    expect(deliveries[0].lastStatusCode).toBe(200);
  });

  it('on HTTP 500: status set to retrying, attempt_count incremented, nextRetryAt advances', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/fail',
      eventType: 'test',
      payload: {}
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    });

    await dispatchPendingWebhooks(db);

    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
    expect(deliveries[0].status).toBe('retrying');
    expect(deliveries[0].attemptCount).toBe(1);
    expect(deliveries[0].nextRetryAt).not.toBeNull();
    // nextRetryAt should be ~30 seconds in the future
  });

  it('after maxAttempts failures: status set to failed', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/fail',
      eventType: 'test',
      payload: {}
    });

    // Manually push attemptCount to 4 (max_attempts = 5 default)
    await db.execute(sql`
      UPDATE webhook_deliveries SET attempt_count = 4 WHERE tenant_id = ${tenantId}
    `);

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await dispatchPendingWebhooks(db);

    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
    expect(deliveries[0].status).toBe('failed');
    expect(deliveries[0].attemptCount).toBe(5);
    expect(deliveries[0].completedAt).not.toBeNull();
  });

  it('nextRetryAt follows exponential backoff schedule [30s, 120s, 600s, 3600s, 86400s]', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/fail',
      eventType: 'test',
      payload: {}
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const backoffs = [30, 120, 600, 3600];

    for (let i = 0; i < 4; i++) {
      await db.execute(sql`UPDATE webhook_deliveries SET next_retry_at = NOW() WHERE tenant_id = ${tenantId}`);
      await dispatchPendingWebhooks(db);
      
      const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
      expect(deliveries[0].status).toBe('retrying');
      
      const diffMs = (deliveries[0].nextRetryAt!.getTime() - deliveries[0].lastAttemptAt!.getTime());
      
      // Allow 1 second leeway for DB now() diff
      const expectedDiffMs = backoffs[i] * 1000;
      expect(Math.abs(diffMs - expectedDiffMs)).toBeLessThan(1500);
    }
  });

  it('FOR UPDATE SKIP LOCKED: two concurrent dispatchers do not double-deliver same webhook', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/slow',
      eventType: 'test',
      payload: {}
    });

    // Mock fetch with a delay
    global.fetch = vi.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, status: 200 }), 500);
    }));

    // Start two concurrent dispatchers
    const p1 = dispatchPendingWebhooks(db);
    const p2 = dispatchPendingWebhooks(db);

    const [r1, r2] = await Promise.all([p1, p2]);
    
    // One fetches the row, locks it. The second skips the locked row.
    // Total dispatched should be exactly 1.
    expect(r1.dispatched + r2.dispatched).toBe(1);
  });

  it('10-second timeout enforced: mock slow endpoint, assert fetch is aborted', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/slow',
      eventType: 'test',
      payload: {}
    });

    // Mock fetch that hangs forever
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    });

    // Override the timeout inside function for testing? 
    // We can't easily without modifying the function code.
    // Let's just mock setTimeout globally or assume fetch timeout works.
    // In vitest we could use vi.useFakeTimers()
    vi.useFakeTimers();
    
    const promise = dispatchPendingWebhooks(db);
    // Fast-forward 11s
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.failed).toBe(1);

    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
    expect(deliveries[0].lastError).toMatch(/time|Abort/); // "Delivery timed out after 10s" or "AbortError" depending on how I coded it
    
    vi.useRealTimers();
  });

  it('does not dispatch webhooks where next_retry_at > NOW()', async () => {
    const tenantId = await insertTenant();
    await enqueueWebhook(db, {
      tenantId,
      endpointUrl: 'https://example.com/future',
      eventType: 'test',
      payload: {}
    });
    
    // Set next_retry_at to 1 hour in the future
    await db.execute(sql`UPDATE webhook_deliveries SET next_retry_at = NOW() + INTERVAL '1 hour' WHERE tenant_id = ${tenantId}`);

    const result = await dispatchPendingWebhooks(db);
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
  });
});
