// src/routes/s3/deleteObject.test.ts

/**
 * Test suite for the S3 DeleteObject route (`DELETE /:bucketName/*`).
 *
 * Uses:
 *   - Vitest as the test runner
 *   - fastify.inject() for request simulation
 *   - Real PostgreSQL + Redis connections
 *   - Mocked MinIO client (statObject, removeObject)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Redis } from 'ioredis';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../../drizzle/schema.js';
import { tenants, buckets, usageMetrics } from '../../drizzle/schema.js';
import authenticatePlugin from '../../plugins/authenticate.js';
import deleteObjectRoute from './deleteObject.js';
import type { DrizzleDb } from '../../db/index.js';

// ─────────────────────────────────────────────────────────────
// Mock MinIO
// ─────────────────────────────────────────────────────────────

const mockStatObject = vi.fn();
const mockRemoveObject = vi.fn();
const mockPutObject = vi.fn();
const mockGetObject = vi.fn();
const mockMakeBucket = vi.fn();

const mockMinioClient = {
  statObject: mockStatObject,
  removeObject: mockRemoveObject,
  putObject: mockPutObject,
  getObject: mockGetObject,
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
  mockRemoveObject.mockReset();
  mockRemoveObject.mockResolvedValue(undefined);

  app = Fastify({ logger: false });
  await app.register(authenticatePlugin);
  await app.register(deleteObjectRoute, { db, redis, minioClient: mockMinioClient as never });
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

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('DELETE /:bucketName/* — S3 DeleteObject', () => {
  it('deletes existing object — returns 204 with no body', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    mockStatObject.mockResolvedValue({
      size: 1024,
      etag: 'etag-123',
      lastModified: new Date(),
      metaData: {},
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/my-bucket/file.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(mockRemoveObject).toHaveBeenCalled();
  });

  it('deleting non-existent object returns 204 (S3 idempotency)', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const notFoundError = new Error('object not found');
    (notFoundError as unknown as { code: string }).code = 'NotFound';
    mockStatObject.mockRejectedValue(notFoundError);

    const res = await app.inject({
      method: 'DELETE',
      url: '/my-bucket/nonexistent.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(204);
    // removeObject should NOT be called since stat returned NotFound
    expect(mockRemoveObject).not.toHaveBeenCalled();
  });

  it('inserts usage_metrics row with eventType = bucket_deleted, bytes = freed size', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const freedSize = 4096;
    mockStatObject.mockResolvedValue({
      size: freedSize,
      etag: 'etag',
      lastModified: new Date(),
      metaData: {},
    });

    await app.inject({
      method: 'DELETE',
      url: '/my-bucket/old-file.bin',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'bucket_deleted'),
        ),
      );

    expect(metrics.length).toBe(1);
    expect(metrics[0].eventType).toBe('bucket_deleted');
    expect(Number(metrics[0].bytes)).toBe(freedSize);
  });

  it('decrements Redis quota:{slug}:storage_bytes by the freed bytes', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const storageKey = `quota:${tenant.slug}:storage_bytes`;
    await redis.set(storageKey, '10000');

    const freedSize = 3000;
    mockStatObject.mockResolvedValue({
      size: freedSize,
      etag: 'etag',
      lastModified: new Date(),
      metaData: {},
    });

    await app.inject({
      method: 'DELETE',
      url: '/my-bucket/decr-file.bin',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const val = await redis.get(storageKey);
    expect(val).not.toBeNull();
    expect(parseInt(val!, 10)).toBe(7000); // 10000 - 3000
  });

  it('storage counter never goes below 0 (Lua clamp script works)', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    const storageKey = `quota:${tenant.slug}:storage_bytes`;
    await redis.set(storageKey, '100');

    // Freed bytes > current storage
    const freedSize = 500;
    mockStatObject.mockResolvedValue({
      size: freedSize,
      etag: 'etag',
      lastModified: new Date(),
      metaData: {},
    });

    await app.inject({
      method: 'DELETE',
      url: '/my-bucket/big-delete.bin',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    const val = await redis.get(storageKey);
    expect(val).not.toBeNull();
    expect(parseInt(val!, 10)).toBe(0); // Clamped, not -400
  });

  it('returns 404 NoSuchBucket when bucket does not exist', async () => {
    const tenant = await insertTenant();

    const res = await app.inject({
      method: 'DELETE',
      url: '/nonexistent/file.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(404);
    expect(xmlValue(res.body, 'Code')).toBe('NoSuchBucket');
  });

  it('returns 403 when bucket is suspended (deletion still allowed per policy)', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'susp-bucket', 'suspended');

    mockStatObject.mockResolvedValue({
      size: 1024,
      etag: 'etag',
      lastModified: new Date(),
      metaData: {},
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/susp-bucket/file.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    // The spec says suspended buckets ALLOW deletes — deletion succeeds
    expect(res.statusCode).toBe(204);
    expect(mockRemoveObject).toHaveBeenCalled();
  });

  it('does NOT insert usage_metrics if MinIO removeObject fails', async () => {
    const tenant = await insertTenant();
    await insertBucket(tenant.id!, tenant.slug!, 'my-bucket');

    mockStatObject.mockResolvedValue({
      size: 2048,
      etag: 'etag',
      lastModified: new Date(),
      metaData: {},
    });
    mockRemoveObject.mockRejectedValueOnce(new Error('MinIO removeObject failed'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/my-bucket/fail-delete.bin',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(500);

    const metrics = await db
      .select()
      .from(usageMetrics)
      .where(
        and(
          eq(usageMetrics.tenantId, tenant.id!),
          eq(usageMetrics.eventType, 'bucket_deleted'),
        ),
      );

    expect(metrics.length).toBe(0);
  });

  it('error responses are valid XML', async () => {
    const tenant = await insertTenant();

    // 404 — no bucket
    const res = await app.inject({
      method: 'DELETE',
      url: '/nonexistent/file.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(xmlValue(res.body, 'Code')).toBeTruthy();
    expect(xmlValue(res.body, 'RequestId')).toBeTruthy();

    // 500 — MinIO removeObject fails
    await insertBucket(tenant.id!, tenant.slug!, 'err-bucket');
    mockStatObject.mockResolvedValue({
      size: 100,
      etag: 'etag',
      lastModified: new Date(),
      metaData: {},
    });
    mockRemoveObject.mockRejectedValueOnce(new Error('boom'));

    const res500 = await app.inject({
      method: 'DELETE',
      url: '/err-bucket/file.txt',
      headers: { authorization: authHeader(tenant.id!, tenant.slug!) },
    });

    expect(res500.statusCode).toBe(500);
    expect(xmlValue(res500.body, 'Code')).toBeTruthy();
    expect(xmlValue(res500.body, 'RequestId')).toBeTruthy();
  });
});
