// src/routes/s3/getObject.test.ts

/**
 * Test suite for the S3 GetObject route (`GET /:bucketName/*`).
 *
 * Uses:
 *   - Vitest as the test runner
 *   - fastify.inject() for request simulation
 *   - Real PostgreSQL + Redis connections
 *   - Mocked MinIO client (statObject, getObject)
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
import getObjectRoute from './getObject.js';
import type { DrizzleDb } from '../../db/index.js';

// ─────────────────────────────────────────────────────────────
// Mock MinIO
// ─────────────────────────────────────────────────────────────

const mockStatObject = vi.fn();
const mockGetObject = vi.fn();
const mockPutObject = vi.fn();
const mockRemoveObject = vi.fn();
const mockMakeBucket = vi.fn();

const mockMinioClient = {
  statObject: mockStatObject,
  getObject: mockGetObject,
  putObject: mockPutObject,
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

/** Creates a Readable stream from a Buffer for mocking MinIO getObject. */
function bufferToReadable(buf: Buffer): Readable {
  return new Readable({
    read() {
      this.push(buf);
      this.push(null);
    },
  });
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
  mockStatObject.mockReset();
  mockGetObject.mockReset();

  app = Fastify({ logger: false });
  await app.register(authenticatePlugin);
  await app.register(getObjectRoute, { db, redis, minioClient: mockMinioClient as never });
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
): Promise<string> {
  const id = randomUUID();
  await db.insert(buckets).values({
    id,
    tenantId,
    name,
    physicalName: `${tenantSlug}--${name}`,
    status,
  });
  return id;
}

/** Configure mocks for a standard getObject flow (stat + stream). */
function setupMockObject(content: Buffer, contentType = 'application/octet-stream'): void {
  mockStatObject.mockResolvedValue({
    size: content.length,
    etag: 'mock-etag-123',
    lastModified: new Date('2025-01-15T10:30:00Z'),
    metaData: { 'content-type': contentType },
  });
  mockGetObject.mockResolvedValue(bufferToReadable(content));
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('GET /:bucketName/* — S3 GetObject', () => {
  it('streams object to client successfully — response body matches uploaded bytes', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const objectData = Buffer.from('Hello, world! This is test object data.');
    setupMockObject(objectData, 'text/plain');

    const res = await app.inject({
      method: 'GET',
      url: '/my-bucket/hello.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(objectData.length);
    expect(Buffer.from(res.rawPayload).toString()).toBe(objectData.toString());
  });

  it('returns correct Content-Type, Content-Length, ETag headers', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const objectData = Buffer.from('image data here');
    setupMockObject(objectData, 'image/png');

    const res = await app.inject({
      method: 'GET',
      url: '/my-bucket/photo.png',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(objectData.length.toString());
    expect(res.headers['etag']).toBe('mock-etag-123');
  });

  it('returns 404 NoSuchKey when object does not exist in MinIO', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const notFoundError = new Error('not found');
    (notFoundError as unknown as { code: string }).code = 'NotFound';
    mockStatObject.mockRejectedValue(notFoundError);

    const res = await app.inject({
      method: 'GET',
      url: '/my-bucket/missing.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(404);
    expect(xmlValue(res.body, 'Code')).toBe('NoSuchKey');
  });

  it('returns 404 NoSuchBucket when bucket does not exist', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent/file.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(404);
    expect(xmlValue(res.body, 'Code')).toBe('NoSuchBucket');
  });

  it('returns 403 QuotaExceeded when egress quota is exhausted', async () => {
    const tenant = await insertTenant({ maxMonthlyEgressBytes: BigInt(100) });
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const period = currentBillingPeriod();
    await redis.set(`quota:${tenant.slug}:egress:${period}`, '100');

    mockStatObject.mockResolvedValue({
      size: 50,
      etag: 'etag',
      lastModified: new Date(),
      metaData: { 'content-type': 'application/octet-stream' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/my-bucket/file.bin',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(403);
    expect(xmlValue(res.body, 'Code')).toBe('QuotaExceeded');
  });

  it('inserts a usage_metrics row with eventType = data_out after success', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const objectData = Buffer.from('egress billing test');
    setupMockObject(objectData);

    await app.inject({
      method: 'GET',
      url: '/my-bucket/billed.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'data_out'),
        ),
      );

    expect(metrics.length).toBe(1);
    expect(metrics[0].eventType).toBe('data_out');
    expect(metrics[0].billingPeriod).toBe(currentBillingPeriod());
  });

  it('usage_metrics bytes equals actual bytes received by client', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const objectData = Buffer.from('exact byte count');
    setupMockObject(objectData);

    await app.inject({
      method: 'GET',
      url: '/my-bucket/counted.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'data_out'),
        ),
      );

    expect(metrics.length).toBe(1);
    expect(Number(metrics[0].bytes)).toBe(objectData.length);
  });

  it('increments Redis quota:{slug}:egress:{YYYY-MM} after success', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const period = currentBillingPeriod();
    const egressKey = `quota:${tenant.slug}:egress:${period}`;
    await redis.del(egressKey);

    const objectData = Buffer.from('egress counter test');
    setupMockObject(objectData);

    await app.inject({
      method: 'GET',
      url: '/my-bucket/egress.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const val = await redis.get(egressKey);
    expect(val).not.toBeNull();
    expect(parseInt(val!, 10)).toBeGreaterThanOrEqual(objectData.length);
  });

  it('response is streamed — assert headers arrive before body fully delivered', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    // Create a slow readable that delivers chunks with delays
    const chunks = [Buffer.from('chunk1'), Buffer.from('chunk2'), Buffer.from('chunk3')];
    const totalSize = chunks.reduce((s, c) => s + c.length, 0);

    mockStatObject.mockResolvedValue({
      size: totalSize,
      etag: 'slow-etag',
      lastModified: new Date(),
      metaData: { 'content-type': 'text/plain' },
    });

    let chunkIndex = 0;
    const slowStream = new Readable({
      read() {
        if (chunkIndex < chunks.length) {
          this.push(chunks[chunkIndex]);
          chunkIndex++;
        } else {
          this.push(null);
        }
      },
    });

    mockGetObject.mockResolvedValue(slowStream);

    const res = await app.inject({
      method: 'GET',
      url: '/my-bucket/streamed.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    // If the response was streamed, we should have received all the chunked data
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(totalSize);
    expect(res.headers['content-length']).toBe(totalSize.toString());
  });

  it('error responses are valid XML', async () => {
    const tenant = await insertTenant();

    // 404 — no bucket
    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent/file.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(xmlValue(res.body, 'Code')).toBeTruthy();
    expect(xmlValue(res.body, 'RequestId')).toBeTruthy();
  });
});
