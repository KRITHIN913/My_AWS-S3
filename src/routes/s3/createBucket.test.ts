// src/routes/s3/createBucket.test.ts

/**
 * Test suite for the S3 CreateBucket route (`PUT /:bucketName`).
 *
 * Uses:
 *   - Vitest as the test runner
 *   - fastify.inject() for request simulation
 *   - Real PostgreSQL connection (p5_billing on localhost:5432)
 *   - Real Redis connection (localhost:6379)
 *   - Mocked MinIO client (vi.mock)
 *
 * Each test inserts its own tenant fixture and cleans up afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Redis } from 'ioredis';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../../drizzle/schema.js';
import { tenants, buckets, usageMetrics } from '../../drizzle/schema.js';
import authenticatePlugin from '../../plugins/authenticate.js';
import createBucketPlugin from './createBucket.js';
import type { DrizzleDb } from '../../db/index.js';

// ─────────────────────────────────────────────────────────────
// Mock MinIO
// ─────────────────────────────────────────────────────────────

const mockMakeBucket = vi.fn<(physicalName: string, region: string) => Promise<void>>();

vi.mock('../../lib/minio.js', () => ({
  minioClient: {
    makeBucket: (...args: [string, string]) => mockMakeBucket(...args),
  },
}));

// ─────────────────────────────────────────────────────────────
// Shared test state
// ─────────────────────────────────────────────────────────────

const { Pool } = pg;

let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;
let redis: InstanceType<typeof Redis>;
let app: FastifyInstance;

/** Default test tenant values. */
function createTestTenant(overrides: Partial<schema.NewTenant> = {}): schema.NewTenant {
  const id = randomUUID();
  const slug = `test-tenant-${id.slice(0, 8)}`;
  return {
    id,
    slug,
    displayName: 'Test Tenant',
    email: `${slug}@test.example.com`,
    status: 'active',
    maxBuckets: 10,
    maxStorageBytes: BigInt(107_374_182_400),
    maxMonthlyIngressBytes: BigInt(10_737_418_240),
    maxMonthlyEgressBytes: BigInt(10_737_418_240),
    ...overrides,
  };
}

/** Build the Authorization header value for inject requests. */
function authHeader(tenantId: string, tenantSlug: string): string {
  return `Bearer ${tenantId}:${tenantSlug}`;
}

/** Parse simple XML element content. Not a full XML parser — good enough for tests. */
function xmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────

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

/** IDs of tenant rows inserted during a test — cleaned up in afterEach. */
let createdTenantIds: string[] = [];

beforeEach(async () => {
  createdTenantIds = [];
  mockMakeBucket.mockReset();
  mockMakeBucket.mockResolvedValue(undefined);

  // Build a fresh Fastify instance for each test
  app = Fastify({ logger: false });
  await app.register(authenticatePlugin);
  await app.register(createBucketPlugin, { db, redis, minioClient: { makeBucket: mockMakeBucket } as never });
  await app.ready();
});

afterEach(async () => {
  await app.close();

  // Clean up in reverse-dependency order: usage_metrics → buckets → tenants
  for (const tenantId of createdTenantIds) {
    await db.delete(usageMetrics).where(eq(usageMetrics.tenantId, tenantId));
    await db.delete(buckets).where(eq(buckets.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));

    // Flush Redis keys for this test tenant
    const keys = await redis.keys(`*${tenantId.slice(0, 8)}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  // Also clean by slug pattern
  const testKeys = await redis.keys('*test-tenant-*');
  if (testKeys.length > 0) {
    await redis.del(...testKeys);
  }
});

/**
 * Helper: inserts a tenant into Postgres and tracks it for cleanup.
 */
async function insertTenant(overrides: Partial<schema.NewTenant> = {}): Promise<schema.NewTenant> {
  const tenant = createTestTenant(overrides);
  await db.insert(tenants).values(tenant);
  createdTenantIds.push(tenant.id!);
  return tenant;
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('PUT /:bucketName — S3 CreateBucket', () => {
  // ──────────────────────────────────────────────────────────
  // ✓ Happy path
  // ──────────────────────────────────────────────────────────

  it('returns 200 and provisions bucket for a valid active tenant', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'PUT',
      url: '/my-test-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['location']).toBe('/my-test-bucket');
    expect(mockMakeBucket).toHaveBeenCalledWith(
      `${tenant.slug}--my-test-bucket`,
      'us-east-1',
    );
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Bucket name validation (400s)
  // ──────────────────────────────────────────────────────────

  it('returns 400 for bucket name shorter than 3 chars', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'PUT',
      url: '/ab',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(400);
    expect(xmlValue(res.body, 'Code')).toBe('InvalidBucketName');
  });

  it('returns 400 for bucket name longer than 63 chars', async () => {
    const tenant = await insertTenant();
    const longName = 'a'.repeat(64);

    const res = await app.inject({
      method: 'PUT',
      url: `/${longName}`,
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(400);
    expect(xmlValue(res.body, 'Code')).toBe('InvalidBucketName');
  });

  it('returns 400 for bucket name with uppercase letters', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'PUT',
      url: '/MyBucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(400);
    expect(xmlValue(res.body, 'Code')).toBe('InvalidBucketName');
  });

  it('returns 400 for bucket name starting with a hyphen', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'PUT',
      url: '/-my-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(400);
    expect(xmlValue(res.body, 'Code')).toBe('InvalidBucketName');
  });

  it('returns 400 for bucket name that is an IP address (e.g. 192.168.1.1)', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'PUT',
      url: '/192.168.1.1',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(400);
    expect(xmlValue(res.body, 'Code')).toBe('InvalidBucketName');
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Tenant status checks (403s)
  // ──────────────────────────────────────────────────────────

  it('returns 403 when tenant status is suspended', async () => {
    const tenant = await insertTenant({ status: 'suspended' });

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(403);
    expect(xmlValue(res.body, 'Code')).toBe('AccountSuspended');
  });

  it('returns 403 when tenant status is deleted', async () => {
    const tenant = await insertTenant({ status: 'deleted' });

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(403);
    expect(xmlValue(res.body, 'Code')).toBe('AccountSuspended');
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Quota exceeded (409)
  // ──────────────────────────────────────────────────────────

  it('returns 409 QuotaExceeded when tenant has reached maxBuckets', async () => {
    const tenant = await insertTenant({ maxBuckets: 1 });

    // Insert one active bucket to fill the quota
    await db.insert(buckets).values({
      tenantId: tenant.id!,
      name: 'existing-bucket',
      physicalName: `${tenant.slug}--existing-bucket`,
      status: 'active',
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/second-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(409);
    expect(xmlValue(res.body, 'Code')).toBe('QuotaExceeded');
    expect(xmlValue(res.body, 'Message')).toBe('Bucket quota reached');
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Duplicate bucket (409)
  // ──────────────────────────────────────────────────────────

  it('returns 409 BucketAlreadyExists when bucket already exists (active)', async () => {
    const tenant = await insertTenant();

    // Pre-insert an active bucket with the same name
    await db.insert(buckets).values({
      tenantId: tenant.id!,
      name: 'my-bucket',
      physicalName: `${tenant.slug}--my-bucket`,
      status: 'active',
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(409);
    expect(xmlValue(res.body, 'Code')).toBe('BucketAlreadyExists');
    expect(xmlValue(res.body, 'Message')).toBe('Bucket already exists');
  });

  it('returns 409 BucketAlreadyExists when bucket is in provisioning state', async () => {
    const tenant = await insertTenant();

    await db.insert(buckets).values({
      tenantId: tenant.id!,
      name: 'my-bucket',
      physicalName: `${tenant.slug}--my-bucket`,
      status: 'provisioning',
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(409);
    expect(xmlValue(res.body, 'Code')).toBe('BucketAlreadyExists');
    expect(xmlValue(res.body, 'Message')).toBe('Bucket is being provisioned');
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Usage metric insertion
  // ──────────────────────────────────────────────────────────

  it('inserts a usage_metrics row with eventType=bucket_created', async () => {
    const tenant = await insertTenant();

    await app.inject({
      method: 'PUT',
      url: '/metrics-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'bucket_created'),
        ),
      );

    expect(metrics.length).toBe(1);
    expect(metrics[0].eventType).toBe('bucket_created');
    expect(metrics[0].bytes).toBe(BigInt(0));
    expect(metrics[0].idempotencyKey).toBe(`bucket_created:${tenant.id}:metrics-bucket`);

    const metadata = JSON.parse(metrics[0].metadata!);
    expect(metadata.physicalName).toBe(`${tenant.slug}--metrics-bucket`);
    expect(metadata.region).toBe('us-east-1');
    expect(metadata.accessPolicy).toBe('private');
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Bucket status transitions
  // ──────────────────────────────────────────────────────────

  it('sets bucket status to active after successful MinIO provisioning', async () => {
    const tenant = await insertTenant();

    await app.inject({
      method: 'PUT',
      url: '/status-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const rows = await db
      .select({ status: buckets.status })
      .from(buckets)
      .where(
        and(
          eq(buckets.tenantId, tenant.id!),
          eq(buckets.name, 'status-bucket'),
        ),
      );

    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('active');
  });

  it('sets bucket status to deleted when MinIO makeBucket throws', async () => {
    const tenant = await insertTenant();
    mockMakeBucket.mockRejectedValueOnce(new Error('MinIO connection refused'));

    const res = await app.inject({
      method: 'PUT',
      url: '/fail-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(500);
    expect(xmlValue(res.body, 'Code')).toBe('InternalError');

    const rows = await db
      .select({ status: buckets.status, deletedAt: buckets.deletedAt })
      .from(buckets)
      .where(
        and(
          eq(buckets.tenantId, tenant.id!),
          eq(buckets.name, 'fail-bucket'),
        ),
      );

    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('deleted');
    expect(rows[0].deletedAt).not.toBeNull();
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Redis counter
  // ──────────────────────────────────────────────────────────

  it('increments Redis quota:{slug}:bucket_count after success', async () => {
    const tenant = await insertTenant();
    const redisKey = `quota:${tenant.slug}:bucket_count`;

    // Ensure key does not exist before the request
    await redis.del(redisKey);

    await app.inject({
      method: 'PUT',
      url: '/counter-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const countStr = await redis.get(redisKey);
    expect(countStr).not.toBeNull();
    // Count should be at least 1 (could be higher if getBucketCount wrote back 0 first, then INCR made it 1)
    expect(parseInt(countStr!, 10)).toBeGreaterThanOrEqual(1);
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Idempotency
  // ──────────────────────────────────────────────────────────

  it('is idempotent — duplicate idempotencyKey insert is a no-op (ON CONFLICT)', async () => {
    const tenant = await insertTenant();

    // First request succeeds
    const res1 = await app.inject({
      method: 'PUT',
      url: '/idempotent-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });
    expect(res1.statusCode).toBe(200);

    // Second request with same bucket name returns 409 (bucket exists)
    const res2 = await app.inject({
      method: 'PUT',
      url: '/idempotent-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });
    expect(res2.statusCode).toBe(409);
    expect(xmlValue(res2.body, 'Code')).toBe('BucketAlreadyExists');

    // Verify only one usage_metrics row exists (idempotencyKey dedup)
    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(eq(usageMetrics.idempotencyKey, `bucket_created:${tenant.id}:idempotent-bucket`));

    expect(metrics.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────
  // ✓ Response body / headers
  // ──────────────────────────────────────────────────────────

  it('response body on success is empty', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'PUT',
      url: '/empty-body-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('response Content-Type on error is application/xml', async () => {
    const tenant = await insertTenant();

    // Trigger a 400 with an invalid bucket name
    const res = await app.inject({
      method: 'PUT',
      url: '/AB',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/xml');
  });

  it('all error responses contain <Code> and <RequestId> XML elements', async () => {
    const tenant = await insertTenant();

    // 400 — invalid name
    const res400 = await app.inject({
      method: 'PUT',
      url: '/a',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });
    expect(res400.statusCode).toBe(400);
    expect(xmlValue(res400.body, 'Code')).toBeTruthy();
    expect(xmlValue(res400.body, 'RequestId')).toBeTruthy();

    // 403 — suspended tenant
    const suspendedTenant = await insertTenant({ status: 'suspended' });
    const res403 = await app.inject({
      method: 'PUT',
      url: '/some-bucket',
      headers: { authorization: authHeader(suspendedTenant.id!, suspendedTenant.slug!) },
    });
    expect(res403.statusCode).toBe(403);
    expect(xmlValue(res403.body, 'Code')).toBeTruthy();
    expect(xmlValue(res403.body, 'RequestId')).toBeTruthy();

    // 409 — duplicate bucket
    await db.insert(buckets).values({
      tenantId: tenant.id!,
      name: 'dup-check',
      physicalName: `${tenant.slug}--dup-check`,
      status: 'active',
    });
    const res409 = await app.inject({
      method: 'PUT',
      url: '/dup-check',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });
    expect(res409.statusCode).toBe(409);
    expect(xmlValue(res409.body, 'Code')).toBeTruthy();
    expect(xmlValue(res409.body, 'RequestId')).toBeTruthy();

    // 500 — MinIO failure
    mockMakeBucket.mockRejectedValueOnce(new Error('MinIO down'));
    const res500 = await app.inject({
      method: 'PUT',
      url: '/error-bucket',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });
    expect(res500.statusCode).toBe(500);
    expect(xmlValue(res500.body, 'Code')).toBeTruthy();
    expect(xmlValue(res500.body, 'RequestId')).toBeTruthy();
  });
});
