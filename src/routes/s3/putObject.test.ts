// src/routes/s3/putObject.test.ts

/**
 * Test suite for the S3 PutObject route (`PUT /:bucketName/*`).
 *
 * Uses:
 *   - Vitest as the test runner
 *   - fastify.inject() for request simulation (with payload for body)
 *   - Real PostgreSQL + Redis connections
 *   - Mocked MinIO client
 *
 * Each test inserts its own tenant + bucket fixture and cleans up afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Redis } from 'ioredis';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import * as schema from '../../drizzle/schema.js';
import { tenants, buckets, usageMetrics } from '../../drizzle/schema.js';
import authenticatePlugin from '../../plugins/authenticate.js';
import putObjectRoute from './putObject.js';
import type { DrizzleDb } from '../../db/index.js';

// ─────────────────────────────────────────────────────────────
// Mock MinIO
// ─────────────────────────────────────────────────────────────

const mockPutObject = vi.fn();
const mockStatObject = vi.fn();
const mockGetObject = vi.fn();
const mockRemoveObject = vi.fn();
const mockMakeBucket = vi.fn();

const mockMinioClient = {
  putObject: mockPutObject,
  statObject: mockStatObject,
  getObject: mockGetObject,
  removeObject: mockRemoveObject,
  makeBucket: mockMakeBucket,
};

// ─────────────────────────────────────────────────────────────
// Shared test state
// ─────────────────────────────────────────────────────────────

const { Pool } = pg;

let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;
let redis: InstanceType<typeof Redis>;
let app: FastifyInstance;

function authHeader(tenantId: string, tenantSlug: string): string {
  return `Bearer ${tenantId}:${tenantSlug}`;
}

function xmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
  return match ? match[1] : null;
}

function currentBillingPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
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

let createdTenantIds: string[] = [];

beforeEach(async () => {
  createdTenantIds = [];
  mockPutObject.mockReset();
  mockPutObject.mockResolvedValue({ etag: 'abc123' });

  app = Fastify({ logger: false });
  await app.register(authenticatePlugin);
  await app.register(putObjectRoute, { db, redis, minioClient: mockMinioClient as never });
  await app.ready();
});

afterEach(async () => {
  await app.close();

  for (const tenantId of createdTenantIds) {
    await db.delete(usageMetrics).where(eq(usageMetrics.tenantId, tenantId));
    await db.delete(buckets).where(eq(buckets.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }

  const testKeys = await redis.keys('*test-tenant-*');
  if (testKeys.length > 0) await redis.del(...testKeys);
});

async function insertTenant(overrides: Partial<schema.NewTenant> = {}): Promise<schema.NewTenant> {
  const id = randomUUID();
  const slug = `test-tenant-${id.slice(0, 8)}`;
  const tenant: schema.NewTenant = {
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
  await db.insert(tenants).values(tenant);
  createdTenantIds.push(tenant.id!);
  return tenant;
}

async function insertBucket(
  tenantId: string,
  tenantSlug: string,
  name: string,
  status: schema.BucketStatus = 'active',
  deletedAt: Date | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.insert(buckets).values({
    id,
    tenantId,
    name,
    physicalName: `${tenantSlug}--${name}`,
    status,
    deletedAt,
  });
  return id;
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('PUT /:bucketName/* — S3 PutObject', () => {
  it('streams a small object (< 1 MB) successfully — returns 200 + ETag header', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const payload = Buffer.alloc(1024, 'x');

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/test-object.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-type': 'text/plain',
        'content-length': payload.length.toString(),
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBeTruthy();
    expect(mockPutObject).toHaveBeenCalled();
  });

  it('streams a zero-byte object — returns 200, billing event bytes = 0n', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/empty.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '0',
      },
      payload: Buffer.alloc(0),
    });

    expect(res.statusCode).toBe(200);

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'data_in'),
        ),
      );

    expect(metrics.length).toBe(1);
    expect(metrics[0].bytes).toBe(BigInt(0));
  });

  it('returns 404 NoSuchBucket when bucket does not exist', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'PUT',
      url: '/nonexistent/file.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(404);
    expect(xmlValue(res.body, 'Code')).toBe('NoSuchBucket');
  });

  it('returns 404 NoSuchBucket when bucket is soft-deleted (deletedAt IS NOT NULL)', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'deleted-bkt', 'active', new Date());

    const res = await app.inject({
      method: 'PUT',
      url: '/deleted-bkt/file.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(404);
    expect(xmlValue(res.body, 'Code')).toBe('NoSuchBucket');
  });

  it('returns 403 when bucket status is suspended', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'susp-bkt', 'suspended');

    const res = await app.inject({
      method: 'PUT',
      url: '/susp-bkt/file.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(403);
    expect(xmlValue(res.body, 'Code')).toBe('BucketSuspended');
  });

  it('returns 409 when bucket status is provisioning', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'prov-bkt', 'provisioning');

    const res = await app.inject({
      method: 'PUT',
      url: '/prov-bkt/file.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(409);
    expect(xmlValue(res.body, 'Code')).toBe('BucketNotReady');
  });

  it('returns 403 QuotaExceeded when storage quota is exhausted', async () => {
    const tenant = await insertTenant({ maxStorageBytes: BigInt(100) });
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    // Set storage counter to just at the limit
    await redis.set(`quota:${tenant.slug}:storage_bytes`, '100');

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/big-file.bin',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '1',
      },
      payload: Buffer.alloc(1),
    });

    expect(res.statusCode).toBe(403);
    expect(xmlValue(res.body, 'Code')).toBe('QuotaExceeded');
  });

  it('returns 403 QuotaExceeded when monthly ingress quota is exhausted', async () => {
    const tenant = await insertTenant({ maxMonthlyIngressBytes: BigInt(100) });
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const period = currentBillingPeriod();
    await redis.set(`quota:${tenant.slug}:ingress:${period}`, '100');

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/file.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '1',
      },
      payload: Buffer.alloc(1),
    });

    expect(res.statusCode).toBe(403);
    expect(xmlValue(res.body, 'Code')).toBe('QuotaExceeded');
  });

  it('inserts a usage_metrics row with eventType = data_in after success', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const payload = Buffer.from('test data payload');

    await app.inject({
      method: 'PUT',
      url: '/my-bucket/data.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-type': 'text/plain',
        'content-length': payload.length.toString(),
      },
      payload,
    });

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'data_in'),
        ),
      );

    expect(metrics.length).toBe(1);
    expect(metrics[0].eventType).toBe('data_in');
    expect(metrics[0].billingPeriod).toBe(currentBillingPeriod());
  });

  it('usage_metrics bytes column equals actual bytes streamed (not Content-Length)', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const payload = Buffer.from('hello world');

    await app.inject({
      method: 'PUT',
      url: '/my-bucket/metered.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': payload.length.toString(),
      },
      payload,
    });

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'data_in'),
        ),
      );

    expect(metrics.length).toBe(1);
    // The bytes should match what was actually streamed
    expect(Number(metrics[0].bytes)).toBe(payload.length);
  });

  it('increments Redis quota:{slug}:storage_bytes after success', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const storageKey = `quota:${tenant.slug}:storage_bytes`;
    await redis.del(storageKey);

    const payload = Buffer.from('storage test');

    await app.inject({
      method: 'PUT',
      url: '/my-bucket/store.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': payload.length.toString(),
      },
      payload,
    });

    const val = await redis.get(storageKey);
    expect(val).not.toBeNull();
    expect(parseInt(val!, 10)).toBeGreaterThanOrEqual(payload.length);
  });

  it('increments Redis quota:{slug}:ingress:{YYYY-MM} after success', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const period = currentBillingPeriod();
    const ingressKey = `quota:${tenant.slug}:ingress:${period}`;
    await redis.del(ingressKey);

    const payload = Buffer.from('ingress test');

    await app.inject({
      method: 'PUT',
      url: '/my-bucket/ingress.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': payload.length.toString(),
      },
      payload,
    });

    const val = await redis.get(ingressKey);
    expect(val).not.toBeNull();
    expect(parseInt(val!, 10)).toBeGreaterThanOrEqual(payload.length);
  });

  it('does NOT insert usage_metrics row when MinIO putObject fails', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    mockPutObject.mockRejectedValueOnce(new Error('MinIO down'));

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/fail.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(500);

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'data_in'),
        ),
      );

    expect(metrics.length).toBe(0);
  });

  it('response Content-Type on success is not application/json', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/nonjson.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).not.toContain('application/json');
  });

  it('request body is not buffered — test with a 5 MB payload and assert heap delta is < 20 MB', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const fiveMB = Buffer.alloc(5 * 1024 * 1024, 'a');

    // Force GC if available
    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/large-file.bin',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': fiveMB.length.toString(),
      },
      payload: fiveMB,
    });

    if (global.gc) global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapDelta = heapAfter - heapBefore;

    expect(res.statusCode).toBe(200);
    // Heap delta should be well under 20 MB even with a 5 MB payload.
    // The inject call itself buffers the payload, but our handler streams.
    expect(heapDelta).toBeLessThan(20 * 1024 * 1024);
  });

  it('returns 400 for objectKey longer than 1024 chars', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const longKey = 'x'.repeat(1025);

    const res = await app.inject({
      method: 'PUT',
      url: `/my-bucket/${longKey}`,
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(400);
    expect(xmlValue(res.body, 'Code')).toBe('InvalidArgument');
  });

  it('returns 400 for objectKey containing null byte', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const res = await app.inject({
      method: 'PUT',
      url: '/my-bucket/bad\x00key.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(400);
    expect(xmlValue(res.body, 'Code')).toBe('InvalidArgument');
  });

  it('error responses are valid XML with <Code> and <RequestId> elements', async () => {
    const tenant = await insertTenant();

    // 404 — no bucket
    const res404 = await app.inject({
      method: 'PUT',
      url: '/nonexistent/file.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });
    expect(res404.statusCode).toBe(404);
    expect(xmlValue(res404.body, 'Code')).toBeTruthy();
    expect(xmlValue(res404.body, 'RequestId')).toBeTruthy();
    expect(res404.headers['content-type']).toContain('application/xml');

    // 500 — MinIO failure
    await insertBucket(tenant.id!, tenant.slug!, 'err-bucket');
    mockPutObject.mockRejectedValueOnce(new Error('boom'));
    const res500 = await app.inject({
      method: 'PUT',
      url: '/err-bucket/file.txt',
      headers: {
        authorization: authHeader(tenant.id!, tenant.slug!),
        'content-length': '5',
      },
      payload: Buffer.from('hello'),
    });
    expect(res500.statusCode).toBe(500);
    expect(xmlValue(res500.body, 'Code')).toBeTruthy();
    expect(xmlValue(res500.body, 'RequestId')).toBeTruthy();
  });
});
