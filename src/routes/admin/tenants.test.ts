// src/routes/admin/tenants.test.ts
/**
 * Admin Tenant Routes — Integration Tests
 *
 * Real Postgres (test DB). Redis is mocked inline.
 * adminAuthenticate is vi.mocked to inject identity without JWT.
 * Each test inserts its own fixtures and cleans up in afterEach.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';

import * as schema from '../../drizzle/schema.js';
import { tenants, plans, auditLog } from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';
import adminTenantsPlugin from './tenants.js';

// ─────────────────────────────────────────────────────────────
// Mock adminAuthenticate — bypasses JWT validation in tests
// ─────────────────────────────────────────────────────────────

// We track the role we want for the current test
let mockRole: 'superadmin' | 'support' = 'superadmin';
let mockAdminId = 'admin-test-user';

vi.mock('../../plugins/adminAuthenticate.js', () => ({
  adminAuthenticate: async (request: { adminId: string; adminRole: string }) => {
    request.adminId   = mockAdminId;
    request.adminRole = mockRole;
  },
  requireSuperadmin: async (request: { adminRole: string }, reply: { code: (c: number) => { send: (b: unknown) => void } }) => {
    if (request.adminRole === 'support') {
      return reply.code(403).send({ error: 'ReadOnlyRole' });
    }
  },
}));

// ─────────────────────────────────────────────────────────────
// Mock Redis — simple in-memory store
// ─────────────────────────────────────────────────────────────

const redisStore = new Map<string, string>();
const redisHashStore = new Map<string, Map<string, string>>();

const mockRedis = {
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => { redisStore.set(key, value); return 'OK'; }),
  del: vi.fn(async (...keys: string[]) => { keys.forEach(k => { redisStore.delete(k); redisHashStore.delete(k); }); return keys.length; }),
  hset: vi.fn(async (key: string, field: string, value: string) => {
    if (!redisHashStore.has(key)) redisHashStore.set(key, new Map());
    redisHashStore.get(key)!.set(field, value);
    return 1;
  }),
  hget: vi.fn(async (key: string, field: string) => redisHashStore.get(key)?.get(field) ?? null),
  hgetall: vi.fn(async (key: string) => {
    const hash = redisHashStore.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash.entries());
  }),
  expire: vi.fn(async () => 1),
  ping: vi.fn(async () => 'PONG'),
};

// ─────────────────────────────────────────────────────────────
// DB + App setup
// ─────────────────────────────────────────────────────────────

const { Pool } = pg;
let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;
let app: FastifyInstance;

const ADMIN_JWT_SECRET = 'test-admin-secret-key-32-bytes!!';

/**
 * Helper: build a valid HS256 JWT for a given role.
 * Used for 401/403 tests where we need real tokens.
 */
function buildJwt(payload: { sub: string; role: string; exp?: number }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig    = createHmac('sha256', ADMIN_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

beforeAll(async () => {
  pool = new Pool({
    connectionString:
      process.env['DATABASE_URL'] ??
      'postgres://p5_admin:p5_secret@localhost:5432/p5_billing',
  });
  db = drizzle(pool, { schema });

  app = Fastify({ logger: false });

  // The mock does NOT need the real plugin — we've mocked the module
  await app.register(adminTenantsPlugin, {
    prefix: '/admin/tenants',
    db,
    redis: mockRedis as never,
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

let insertedTenantIds: string[] = [];
let insertedPlanIds: string[]   = [];

beforeEach(() => {
  mockRole    = 'superadmin';
  mockAdminId = 'admin-test-user';
  redisStore.clear();
  redisHashStore.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  // Delete in FK-safe order
  if (insertedTenantIds.length > 0) {
    await db.execute(sql`DELETE FROM audit_log WHERE target_id = ANY(${insertedTenantIds}::uuid[])`);
    await db.execute(sql`DELETE FROM webhook_deliveries WHERE tenant_id = ANY(${insertedTenantIds}::uuid[])`);
    await db.execute(sql`DELETE FROM invoices WHERE tenant_id = ANY(${insertedTenantIds}::uuid[])`);
    await db.execute(sql`DELETE FROM quota_breach_events WHERE tenant_id = ANY(${insertedTenantIds}::uuid[])`);
    await db.execute(sql`DELETE FROM usage_snapshots WHERE tenant_id = ANY(${insertedTenantIds}::uuid[])`);
    await db.execute(sql`DELETE FROM usage_metrics WHERE tenant_id = ANY(${insertedTenantIds}::uuid[])`);
    await db.execute(sql`DELETE FROM buckets WHERE tenant_id = ANY(${insertedTenantIds}::uuid[])`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ANY(${insertedTenantIds}::uuid[])`);
  }
  if (insertedPlanIds.length > 0) {
    await db.execute(sql`DELETE FROM plans WHERE id = ANY(${insertedPlanIds}::uuid[])`);
  }
  insertedTenantIds = [];
  insertedPlanIds   = [];
});

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

async function insertTenant(
  overrides: Partial<schema.NewTenant> = {},
): Promise<string> {
  const id   = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await db.insert(tenants).values({
    id,
    slug,
    displayName: 'Test Tenant',
    email: `${slug}@example.com`,
    status: 'active',
    ...overrides,
  });
  insertedTenantIds.push(id);
  return id;
}

async function insertPlan(): Promise<string> {
  const id = randomUUID();
  await db.insert(plans).values({
    id,
    name: `plan-${id.slice(0, 6)}`,
    maxBuckets: 5,
    maxStorageBytes: 50_000_000_000n,
    maxMonthlyIngressBytes: 10_000_000_000n,
    maxMonthlyEgressBytes: 10_000_000_000n,
    priceUcentsPerMonth: 9_000_000n,
  });
  insertedPlanIds.push(id);
  return id;
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('GET /admin/tenants', () => {
  it('returns paginated list with correct structure', async () => {
    const id1 = await insertTenant();
    const id2 = await insertTenant();

    const res = await app.inject({ method: 'GET', url: '/admin/tenants?limit=50' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ tenants: { id: string }[]; nextCursor: string | null }>();
    const ids = body.tenants.map(t => t.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(body).toHaveProperty('nextCursor');
  });

  it('respects limit parameter', async () => {
    await insertTenant();
    await insertTenant();
    await insertTenant();

    const res = await app.inject({ method: 'GET', url: '/admin/tenants?limit=2' });
    const body = res.json<{ tenants: unknown[]; nextCursor: string | null }>();
    expect(body.tenants.length).toBeLessThanOrEqual(2);
  });

  it('filters by status=active correctly', async () => {
    const activeId    = await insertTenant({ status: 'active' });
    const suspendedId = await insertTenant({ status: 'suspended' });

    const res = await app.inject({ method: 'GET', url: '/admin/tenants?status=active&limit=100' });
    const body = res.json<{ tenants: { id: string; status: string }[] }>();

    const ids = body.tenants.map(t => t.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(suspendedId);
    body.tenants.forEach(t => expect(t.status).toBe('active'));
  });

  it('filters by search on slug and email', async () => {
    const id = await insertTenant();
    const row = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    const slug = row[0].slug;

    // Search by slug prefix
    const res = await app.inject({ method: 'GET', url: `/admin/tenants?search=${slug.slice(0, 4)}&limit=50` });
    const body = res.json<{ tenants: { id: string }[] }>();
    expect(body.tenants.some(t => t.id === id)).toBe(true);
  });
});

describe('GET /admin/tenants/:tenantId', () => {
  it('includes current Redis quota usage in response', async () => {
    const id = await insertTenant();
    const row = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    const slug = row[0].slug;

    // Seed Redis counters
    redisStore.set(`quota:${slug}:storage_bytes`, '12345678');
    redisStore.set(`quota:${slug}:bucket_count`, '3');

    const res = await app.inject({ method: 'GET', url: `/admin/tenants/${id}` });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ tenant: { id: string }; quotaUsage: { storageBytes: string; bucketCount: string } }>();
    expect(body.tenant.id).toBe(id);
    expect(body.quotaUsage.storageBytes).toBe('12345678');
    expect(body.quotaUsage.bucketCount).toBe('3');
  });

  it('returns 404 for unknown tenant', async () => {
    const res = await app.inject({ method: 'GET', url: `/admin/tenants/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('TenantNotFound');
  });
});

describe('POST /admin/tenants', () => {
  it('creates tenant and writes audit_log row', async () => {
    const slug  = `new-${randomUUID().slice(0, 6)}`;
    const email = `${slug}@example.com`;

    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { slug, displayName: 'New Tenant', email },
    });
    expect(res.statusCode).toBe(201);

    const body = res.json<{ tenant: { id: string; slug: string } }>();
    expect(body.tenant.slug).toBe(slug);
    insertedTenantIds.push(body.tenant.id);

    // Audit log should have one 'tenant.created' row
    const auditRows = await db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log WHERE target_id = ${body.tenant.id}::uuid LIMIT 1
    `);
    expect(auditRows.rows[0]?.action).toBe('tenant.created');
  });

  it('copies plan limits when planId is provided', async () => {
    const planId = await insertPlan();
    const plan = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);

    const slug  = `plan-${randomUUID().slice(0, 6)}`;
    const email = `${slug}@example.com`;

    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { slug, displayName: 'Plan Tenant', email, planId },
    });
    expect(res.statusCode).toBe(201);

    const body = res.json<{ tenant: { id: string; maxBuckets: number; maxStorageBytes: string } }>();
    insertedTenantIds.push(body.tenant.id);

    expect(body.tenant.maxBuckets).toBe(plan[0].maxBuckets);
    expect(body.tenant.maxStorageBytes).toBe(plan[0].maxStorageBytes.toString());
  });

  it('returns 409 on duplicate slug', async () => {
    const id = await insertTenant();
    const row = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { slug: row[0].slug, displayName: 'Dup', email: `dup-${randomUUID()}@example.com` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('DuplicateSlug');
  });
});

describe('PATCH /admin/tenants/:tenantId', () => {
  it('updates fields and writes audit with before+after snapshots', async () => {
    const id = await insertTenant();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${id}`,
      payload: { displayName: 'Renamed Tenant' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ tenant: { displayName: string } }>();
    expect(body.tenant.displayName).toBe('Renamed Tenant');

    // Audit row should have before (old name) and after (new name)
    const auditRow = await db.execute<{ before: string; after: string; action: string }>(sql`
      SELECT action, before, after FROM audit_log WHERE target_id = ${id}::uuid
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(auditRow.rows[0]?.action).toBe('tenant.updated');
    const before = JSON.parse(auditRow.rows[0]?.before ?? '{}') as { display_name?: string };
    const after  = JSON.parse(auditRow.rows[0]?.after  ?? '{}') as { display_name?: string };
    expect(before.display_name).not.toBe('Renamed Tenant');
    expect(after.display_name).toBe('Renamed Tenant');
  });
});

describe('POST /admin/tenants/:tenantId/suspend', () => {
  it('sets status=suspended and writes audit', async () => {
    const id = await insertTenant({ status: 'active' });

    const res = await app.inject({ method: 'POST', url: `/admin/tenants/${id}/suspend` });
    expect(res.statusCode).toBe(200);

    const row = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    expect(row[0].status).toBe('suspended');

    const auditRow = await db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log WHERE target_id = ${id}::uuid
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(auditRow.rows[0]?.action).toBe('tenant.suspended');
  });
});

describe('POST /admin/tenants/:tenantId/plan', () => {
  it('applies plan limits to tenant and writes audit', async () => {
    const id     = await insertTenant();
    const planId = await insertPlan();
    const plan   = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tenants/${id}/plan`,
      payload: { planId },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ tenant: { planId: string; maxBuckets: number } }>();
    expect(body.tenant.planId).toBe(planId);
    expect(body.tenant.maxBuckets).toBe(plan[0].maxBuckets);

    const auditRow = await db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log WHERE target_id = ${id}::uuid
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(auditRow.rows[0]?.action).toBe('tenant.plan_changed');
  });
});

describe('PATCH /admin/tenants/:tenantId/quota', () => {
  it('updates quota columns and invalidates Redis cache', async () => {
    const id  = await insertTenant();
    const row = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    const slug = row[0].slug;

    // Pre-seed Redis cache
    redisHashStore.set(`tenant:${slug}:meta`, new Map([['maxStorageBytes', '10000']]));

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${id}/quota`,
      payload: { maxStorageBytes: '999999999999', maxBuckets: 50 },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ tenant: { maxBuckets: number; maxStorageBytes: string } }>();
    expect(body.tenant.maxBuckets).toBe(50);
    expect(body.tenant.maxStorageBytes).toBe('999999999999');

    // Redis cache for this tenant should be deleted
    expect(mockRedis.del).toHaveBeenCalledWith(`tenant:${slug}:meta`);

    const auditRow = await db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log WHERE target_id = ${id}::uuid
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(auditRow.rows[0]?.action).toBe('quota.overridden');
  });
});

describe('DELETE /admin/tenants/:tenantId', () => {
  it('soft-deletes tenant: sets status=deleted and deletedAt', async () => {
    const id = await insertTenant();

    const res = await app.inject({ method: 'DELETE', url: `/admin/tenants/${id}` });
    expect(res.statusCode).toBe(200);

    const row = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    expect(row[0].status).toBe('deleted');
    expect(row[0].deletedAt).not.toBeNull();

    const auditRow = await db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log WHERE target_id = ${id}::uuid
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(auditRow.rows[0]?.action).toBe('tenant.deleted');
  });
});

describe('Role enforcement', () => {
  it('support role is blocked from POST with 403', async () => {
    mockRole = 'support';
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { slug: 'blocked', displayName: 'x', email: 'blocked@x.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('ReadOnlyRole');
  });

  it('support role is blocked from PATCH with 403', async () => {
    mockRole = 'support';
    const id = await insertTenant();
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${id}`,
      payload: { displayName: 'Blocked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('support role is blocked from DELETE with 403', async () => {
    mockRole = 'support';
    const id = await insertTenant();
    const res = await app.inject({ method: 'DELETE', url: `/admin/tenants/${id}` });
    expect(res.statusCode).toBe(403);
  });
});

describe('JWT authentication (real plugin wired)', () => {
  /**
   * These tests bypass the mock and wire a separate Fastify instance
   * with the real adminAuthenticate plugin to test JWT validation.
   */
  let jwtApp: FastifyInstance;

  beforeAll(async () => {
    // Restore module so we get the real plugin
    vi.unmock('../../plugins/adminAuthenticate.js');
    process.env['ADMIN_JWT_SECRET'] = ADMIN_JWT_SECRET;

    // Dynamically import the real plugin after unmocking
    const { default: realPlugin } = await import('./tenants.js');

    jwtApp = Fastify({ logger: false });
    await jwtApp.register(realPlugin, {
      prefix: '/admin/tenants',
      db,
      redis: mockRedis as never,
    });
    await jwtApp.ready();
  });

  afterAll(async () => {
    await jwtApp.close();
  });

  it('returns 401 for missing Authorization header', async () => {
    const res = await jwtApp.inject({ method: 'GET', url: '/admin/tenants' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an invalid/tampered JWT signature', async () => {
    const validJwt = buildJwt({ sub: 'admin1', role: 'superadmin', exp: Math.floor(Date.now() / 1000) + 3600 });
    const tampered = validJwt.slice(0, -4) + 'xxxx';
    const res = await jwtApp.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an expired JWT', async () => {
    const expiredJwt = buildJwt({
      sub: 'admin1',
      role: 'superadmin',
      exp: Math.floor(Date.now() / 1000) - 10, // 10 seconds in the past
    });
    const res = await jwtApp.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${expiredJwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ detail: string }>().detail).toMatch(/expired/i);
  });

  it('returns 200 for a valid superadmin JWT', async () => {
    const jwt = buildJwt({ sub: 'admin1', role: 'superadmin', exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await jwtApp.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
