// src/routes/portal/index.test.ts
/**
 * Portal API — Integration Tests
 *
 * Real Postgres test DB. MinIO and rateLimiter are vi.mocked.
 * Tests authenticate via real SHA-256 API key lookup.
 * Each test creates its own fixtures and cleans up in afterEach.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createHash, randomBytes } from 'node:crypto';

import * as schema from '../../drizzle/schema.js';
import { tenants, buckets, apiKeys, invoices, quotaBreachEvents } from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';
import portalPlugin from './index.js';

// ─────────────────────────────────────────────────────────────
// Mock rateLimiter — always allows
// ─────────────────────────────────────────────────────────────

vi.mock('../../plugins/rateLimiter.js', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
  RATE_LIMIT_DEFAULTS: {
    portal_write: { windowMs: 60_000, maxRequests: 30 },
  },
}));

// ─────────────────────────────────────────────────────────────
// Mock MinIO client
// ─────────────────────────────────────────────────────────────

const mockMinioRemoveBucket = vi.fn(async (_name: string) => undefined);
const mockMinio = { removeBucket: mockMinioRemoveBucket };

// ─────────────────────────────────────────────────────────────
// Mock Redis — in-memory store
// ─────────────────────────────────────────────────────────────

const redisStore  = new Map<string, string>();
const redisHashes = new Map<string, Map<string, string>>();

const mockRedis = {
  get:  vi.fn(async (k: string) => redisStore.get(k) ?? null),
  set:  vi.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
  del:  vi.fn(async (...keys: string[]) => { keys.forEach(k => { redisStore.delete(k); redisHashes.delete(k); }); return keys.length; }),
  decr: vi.fn(async (k: string) => {
    const v = BigInt(redisStore.get(k) ?? '0') - 1n;
    redisStore.set(k, v.toString());
    return Number(v);
  }),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    if (!redisHashes.has(k)) redisHashes.set(k, new Map());
    for (let i = 0; i < args.length; i += 2) {
      redisHashes.get(k)!.set(args[i]!, args[i + 1] ?? '');
    }
    return 1;
  }),
  hgetall: vi.fn(async (k: string) => {
    const h = redisHashes.get(k);
    if (!h || h.size === 0) return {};
    return Object.fromEntries(h.entries());
  }),
  expire: vi.fn(async () => 1),
};

// ─────────────────────────────────────────────────────────────
// DB setup
// ─────────────────────────────────────────────────────────────

const { Pool } = pg;
let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────
// App factory — fresh instance per describe block
// ─────────────────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalPlugin, {
    prefix: '/portal',
    db,
    redis: mockRedis as never,
    minioClient: mockMinio as never,
  });
  await app.ready();
  return app;
}

// ─────────────────────────────────────────────────────────────
// Fixture IDs collected for cleanup
// ─────────────────────────────────────────────────────────────

let tenantIds:  string[] = [];
let bucketIds:  string[] = [];
let keyIds:     string[] = [];
let invoiceIds: string[] = [];
let breachIds:  string[] = [];

async function cleanup() {
  if (breachIds.length)  await db.execute(sql`DELETE FROM quota_breach_events WHERE id = ANY(${breachIds}::uuid[])`);
  if (invoiceIds.length) await db.execute(sql`DELETE FROM invoices WHERE id = ANY(${invoiceIds}::uuid[])`);
  if (keyIds.length)     await db.execute(sql`DELETE FROM api_keys WHERE id = ANY(${keyIds}::uuid[])`);
  if (bucketIds.length)  await db.execute(sql`DELETE FROM usage_metrics WHERE bucket_id = ANY(${bucketIds}::uuid[])`);
  if (bucketIds.length)  await db.execute(sql`DELETE FROM buckets WHERE id = ANY(${bucketIds}::uuid[])`);
  if (tenantIds.length)  await db.execute(sql`DELETE FROM usage_metrics WHERE tenant_id = ANY(${tenantIds}::uuid[])`);
  if (tenantIds.length)  await db.execute(sql`DELETE FROM tenants WHERE id = ANY(${tenantIds}::uuid[])`);
  tenantIds = []; bucketIds = []; keyIds = []; invoiceIds = []; breachIds = [];
}

beforeAll(async () => {
  pool = new Pool({
    connectionString: process.env['DATABASE_URL'] ?? 'postgres://p5_admin:p5_secret@localhost:5432/p5_billing',
  });
  db = drizzle(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  redisStore.clear();
  redisHashes.clear();
  vi.clearAllMocks();
  mockMinioRemoveBucket.mockResolvedValue(undefined);
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────

interface TenantFixture {
  id:    string;
  slug:  string;
  rawKey: string;   // the raw API key — use in Authorization header
  keyId:  string;
}

async function insertTenant(): Promise<TenantFixture> {
  const id   = randomUUID();
  const slug = `pt-${id.slice(0, 8)}`;

  await db.insert(tenants).values({
    id, slug,
    displayName: 'Portal Tenant',
    email: `${slug}@example.com`,
    status: 'active',
    maxStorageBytes: 1_000_000_000n,
    maxMonthlyIngressBytes: 500_000_000n,
    maxMonthlyEgressBytes: 500_000_000n,
    maxBuckets: 5,
  });
  tenantIds.push(id);

  // Create an active API key
  const rawKey   = randomBytes(32).toString('hex');
  const keyHash  = sha256Hex(rawKey);
  const keyPrefix = rawKey.slice(0, 8);

  const keyResult = await db.execute<{ id: string }>(sql`
    INSERT INTO api_keys (tenant_id, key_hash, key_prefix)
    VALUES (${id}, ${keyHash}, ${keyPrefix})
    RETURNING id
  `);
  const keyId = keyResult.rows[0]!.id;
  keyIds.push(keyId);

  return { id, slug, rawKey, keyId };
}

async function insertBucket(tenantId: string, slug: string, overrides: Partial<schema.NewBucket> = {}): Promise<string> {
  const id   = randomUUID();
  const name = `bkt-${id.slice(0, 6)}`;
  await db.insert(buckets).values({
    id, tenantId, name,
    physicalName: `${slug}--${name}`,
    status: 'active',
    region: 'us-east-1',
    ...overrides,
  });
  bucketIds.push(id);
  return id;
}

function authHeader(rawKey: string): Record<string, string> {
  return { authorization: `Bearer ${rawKey}` };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('GET /portal/profile', () => {
  it('returns tenant row without webhookSecret', async () => {
    const { rawKey, id } = await insertTenant();

    // Set webhookSecret on tenant
    await db.execute(sql`UPDATE tenants SET webhook_secret = 'super-secret' WHERE id = ${id}`);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/profile', headers: authHeader(rawKey) });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ profile: Record<string, unknown> }>();
    expect(body.profile['id']).toBe(id);
    expect(body.profile).not.toHaveProperty('webhookSecret');
    expect(body.profile).not.toHaveProperty('webhook_secret');
  });
});

describe('PATCH /portal/profile', () => {
  it('updates displayName and invalidates Redis cache', async () => {
    const { rawKey, slug } = await insertTenant();

    // Pre-seed Redis meta cache
    redisHashes.set(`tenant:${slug}:meta`, new Map([['maxStorageBytes', '1000000000']]));

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH', url: '/portal/profile',
      headers: authHeader(rawKey),
      payload: { displayName: 'Updated Name' },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ profile: { displayName: string } }>();
    expect(body.profile.displayName).toBe('Updated Name');
    expect(mockRedis.del).toHaveBeenCalledWith(`tenant:${slug}:meta`);
  });
});

describe('POST /portal/keys', () => {
  it('returns rawKey exactly once in response body', async () => {
    const { rawKey } = await insertTenant();

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/portal/keys',
      headers: authHeader(rawKey),
      payload: { label: 'my-key' },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; keyPrefix: string; rawKey: string; label: string }>();
    expect(body.rawKey).toBeDefined();
    expect(body.rawKey).toHaveLength(64);          // 32 hex bytes
    expect(body.keyPrefix).toBe(body.rawKey.slice(0, 8));
    expect(body.label).toBe('my-key');
    keyIds.push(body.id);

    // Verify only the hash is stored — rawKey NOT in DB
    const stored = await db.execute<{ key_hash: string }>(sql`
      SELECT key_hash FROM api_keys WHERE id = ${body.id}
    `);
    const expectedHash = sha256Hex(body.rawKey);
    expect(stored.rows[0]?.key_hash).toBe(expectedHash);
    expect(stored.rows[0]?.key_hash).not.toBe(body.rawKey);
  });

  it('stores expiresAt when provided', async () => {
    const { rawKey } = await insertTenant();
    const expiresAt  = new Date(Date.now() + 86_400_000).toISOString(); // +1 day

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/portal/keys',
      headers: authHeader(rawKey),
      payload: { expiresAt },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; expiresAt: string }>();
    keyIds.push(body.id);
    expect(body.expiresAt).toBeDefined();

    const stored = await db.execute<{ expires_at: string }>(sql`
      SELECT expires_at FROM api_keys WHERE id = ${body.id}
    `);
    expect(stored.rows[0]?.expires_at).not.toBeNull();
  });
});

describe('GET /portal/keys', () => {
  it('does not expose keyHash in response', async () => {
    const { rawKey } = await insertTenant();

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/keys', headers: authHeader(rawKey) });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: Record<string, unknown>[] }>();
    for (const key of body.keys) {
      expect(key).not.toHaveProperty('keyHash');
      expect(key).not.toHaveProperty('key_hash');
    }
  });
});

describe('DELETE /portal/keys/:keyId', () => {
  it('revokes own key and sets revokedAt', async () => {
    const t = await insertTenant();

    // Create a second key to revoke
    const rawKey2 = randomBytes(32).toString('hex');
    const kRes = await db.execute<{ id: string }>(sql`
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix)
      VALUES (${t.id}, ${sha256Hex(rawKey2)}, ${rawKey2.slice(0, 8)})
      RETURNING id
    `);
    const k2Id = kRes.rows[0]!.id;
    keyIds.push(k2Id);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE', url: `/portal/keys/${k2Id}`,
      headers: authHeader(t.rawKey),
    });
    await app.close();

    expect(res.statusCode).toBe(200);

    const row = await db.execute<{ status: string; revoked_at: string | null }>(sql`
      SELECT status, revoked_at FROM api_keys WHERE id = ${k2Id}
    `);
    expect(row.rows[0]?.status).toBe('revoked');
    expect(row.rows[0]?.revoked_at).not.toBeNull();
  });

  it('cannot revoke another tenant\'s key — returns 404', async () => {
    const t1 = await insertTenant();
    const t2 = await insertTenant();

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE', url: `/portal/keys/${t2.keyId}`,
      headers: authHeader(t1.rawKey),  // tenant 1 tries to delete tenant 2's key
    });
    await app.close();

    expect(res.statusCode).toBe(404);
  });
});

describe('authenticate plugin — key validity', () => {
  it('rejects a revoked key with 403', async () => {
    const t = await insertTenant();
    // Revoke the key
    await db.execute(sql`UPDATE api_keys SET status = 'revoked' WHERE id = ${t.keyId}`);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/profile', headers: authHeader(t.rawKey) });
    await app.close();

    expect(res.statusCode).toBe(403);
  });

  it('rejects an expired key with 403', async () => {
    const t = await insertTenant();
    const past = new Date(Date.now() - 10_000); // 10 seconds ago
    await db.execute(sql`UPDATE api_keys SET expires_at = ${past} WHERE id = ${t.keyId}`);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/profile', headers: authHeader(t.rawKey) });
    await app.close();

    expect(res.statusCode).toBe(403);
  });
});

describe('GET /portal/buckets', () => {
  it('lists only own non-deleted buckets', async () => {
    const t1 = await insertTenant();
    const t2 = await insertTenant();

    const ownId     = await insertBucket(t1.id, t1.slug);
    const deletedId = await insertBucket(t1.id, t1.slug, { status: 'deleted' });
    const othersBkt = await insertBucket(t2.id, t2.slug);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/buckets', headers: authHeader(t1.rawKey) });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ buckets: { id: string }[] }>();
    const ids = body.buckets.map(b => b.id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(deletedId);
    expect(ids).not.toContain(othersBkt);
  });
});

describe('DELETE /portal/buckets/:name', () => {
  it('soft-deletes bucket and calls minioClient.removeBucket', async () => {
    const t  = await insertTenant();
    const id = await insertBucket(t.id, t.slug);
    const bkt = await db.select().from(buckets).where(eq(buckets.id, id)).limit(1);
    const name = bkt[0].name;

    redisStore.set(`quota:${t.slug}:bucket_count`, '3');

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE', url: `/portal/buckets/${name}`,
      headers: authHeader(t.rawKey),
    });
    await app.close();

    expect(res.statusCode).toBe(200);

    // DB: status should be 'deleted'
    const updated = await db.select().from(buckets).where(eq(buckets.id, id)).limit(1);
    expect(updated[0].status).toBe('deleted');

    // Wait for setImmediate to fire
    await new Promise(r => setTimeout(r, 20));
    expect(mockMinioRemoveBucket).toHaveBeenCalledWith(bkt[0].physicalName);

    // Redis bucket counter decremented
    expect(redisStore.get(`quota:${t.slug}:bucket_count`)).toBe('2');
  });

  it('records a bucket_deleted usage_metrics row', async () => {
    const t  = await insertTenant();
    const id = await insertBucket(t.id, t.slug);
    const bkt = await db.select().from(buckets).where(eq(buckets.id, id)).limit(1);

    const app = await buildApp();
    await app.inject({
      method: 'DELETE', url: `/portal/buckets/${bkt[0].name}`,
      headers: authHeader(t.rawKey),
    });
    await app.close();

    const metricRows = await db.execute<{ event_type: string }>(sql`
      SELECT event_type FROM usage_metrics
      WHERE bucket_id = ${id}::uuid AND event_type = 'bucket_deleted'
    `);
    expect(metricRows.rows).toHaveLength(1);
  });
});

describe('GET /portal/usage/current', () => {
  it('returns all Redis counters and pctUsed capped at 100', async () => {
    const t = await insertTenant();
    const period = `${new Date().getUTCFullYear()}-${(new Date().getUTCMonth() + 1).toString().padStart(2, '0')}`;

    // Set usage above the limit to test capping
    redisStore.set(`quota:${t.slug}:storage_bytes`,       '2000000000'); // 2x limit of 1GB
    redisStore.set(`quota:${t.slug}:ingress:${period}`,   '250000000');
    redisStore.set(`quota:${t.slug}:egress:${period}`,    '250000000');
    redisStore.set(`quota:${t.slug}:bucket_count`,        '3');

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/usage/current', headers: authHeader(t.rawKey) });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      storageBytes: string;
      pctUsed: { storage: number; ingress: number; egress: number; buckets: number };
    }>();
    expect(body.storageBytes).toBe('2000000000');
    // storage exceeds limit → capped at 100
    expect(body.pctUsed.storage).toBe(100);
    // ingress 250M / 500M = 50
    expect(body.pctUsed.ingress).toBe(50);
  });
});

describe('GET /portal/usage/history', () => {
  it('returns invoices newest-first, respects limit', async () => {
    const t = await insertTenant();

    // Seed 3 invoices
    for (const period of ['2025-01', '2025-02', '2025-03']) {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO invoices (tenant_id, billing_period)
        VALUES (${t.id}, ${period})
        RETURNING id
      `);
      invoiceIds.push(r.rows[0]!.id);
    }

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: '/portal/usage/history?limit=2',
      headers: authHeader(t.rawKey),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ history: { billingPeriod: string }[] }>();
    expect(body.history).toHaveLength(2);
    // Newest first
    expect(body.history[0]?.billingPeriod).toBe('2025-03');
    expect(body.history[1]?.billingPeriod).toBe('2025-02');
  });
});

describe('GET /portal/alerts', () => {
  it('filters by unread=true — only returns undispatched breaches', async () => {
    const t = await insertTenant();

    const r1 = await db.execute<{ id: string }>(sql`
      INSERT INTO quota_breach_events (tenant_id, breach_type, current_value, limit_value, webhook_dispatched)
      VALUES (${t.id}, 'storage_warning', 800, 1000, false)
      RETURNING id
    `);
    const r2 = await db.execute<{ id: string }>(sql`
      INSERT INTO quota_breach_events (tenant_id, breach_type, current_value, limit_value, webhook_dispatched)
      VALUES (${t.id}, 'ingress_exceeded', 1000, 1000, true)
      RETURNING id
    `);
    breachIds.push(r1.rows[0]!.id, r2.rows[0]!.id);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: '/portal/alerts?unread=true',
      headers: authHeader(t.rawKey),
    });
    await app.close();

    const body = res.json<{ alerts: { id: string }[] }>();
    const ids = body.alerts.map(a => a.id);
    expect(ids).toContain(r1.rows[0]!.id);
    expect(ids).not.toContain(r2.rows[0]!.id);
  });
});
