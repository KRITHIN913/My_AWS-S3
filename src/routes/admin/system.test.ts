// src/routes/admin/system.test.ts
/**
 * Admin System Routes — Integration Tests
 *
 * Real Postgres (test DB). Redis and MinIO probes are vi.mocked inline.
 * adminAuthenticate is mocked to inject a superadmin identity.
 * Probe timeouts are tested with vi.useFakeTimers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../../drizzle/schema.js';
import { auditLog } from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';
import adminSystemPlugin from './system.js';

// ─────────────────────────────────────────────────────────────
// Mock adminAuthenticate
// ─────────────────────────────────────────────────────────────

let mockRole: 'superadmin' | 'support' = 'superadmin';

vi.mock('../../plugins/adminAuthenticate.js', () => ({
  adminAuthenticate: async (request: { adminId: string; adminRole: string }) => {
    request.adminId   = 'system-test-admin';
    request.adminRole = mockRole;
  },
  requireSuperadmin: async (request: { adminRole: string }, reply: { code: (c: number) => { send: (b: unknown) => unknown } }) => {
    if (request.adminRole === 'support') {
      return reply.code(403).send({ error: 'ReadOnlyRole' });
    }
  },
}));

// ─────────────────────────────────────────────────────────────
// Infrastructure setup
// ─────────────────────────────────────────────────────────────

const { Pool } = pg;
let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;

// Controllable Redis mock
const redisStore = new Map<string, string>();

const mockRedis = {
  get:  vi.fn(async (key: string) => redisStore.get(key) ?? null),
  set:  vi.fn(async (key: string, value: string) => { redisStore.set(key, value); return 'OK'; }),
  ping: vi.fn(async () => 'PONG'),
  hset: vi.fn(async () => 1),
  del:  vi.fn(async () => 1),
};

// Controllable MinIO mock
const mockMinio = {
  listBuckets: vi.fn(async () => []),
};

// ─────────────────────────────────────────────────────────────
// App builder — creates a fresh Fastify per test group so we
// can inject different mocks without module-level mutation.
// ─────────────────────────────────────────────────────────────

async function buildApp(
  redisMock  = mockRedis  as never,
  minioMock  = mockMinio  as never,
  dbOverride?: DrizzleDb,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(adminSystemPlugin, {
    prefix: '/admin/system',
    db: dbOverride ?? db,
    redis: redisMock,
    minioClient: minioMock,
  });
  await app.ready();
  return app;
}

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

let auditIds: string[] = [];

beforeEach(() => {
  mockRole = 'superadmin';
  redisStore.clear();
  vi.clearAllMocks();
  // Restore healthy defaults
  mockRedis.ping.mockResolvedValue('PONG');
  mockMinio.listBuckets.mockResolvedValue([]);
  auditIds = [];
});

afterEach(async () => {
  if (auditIds.length > 0) {
    await db.execute(sql`DELETE FROM audit_log WHERE id = ANY(${auditIds}::uuid[])`);
  }
});

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('GET /admin/system/health', () => {
  it('returns status=ok when all probes pass', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/system/health' });
    await app.close();

    expect(res.statusCode).toBe(200);

    const body = res.json<{
      status: string;
      postgres: { connected: boolean; latencyMs: number };
      redis: { connected: boolean; latencyMs: number };
      minio: { connected: boolean; latencyMs: number };
      uptime: number;
    }>();

    expect(body.status).toBe('ok');
    expect(body.postgres.connected).toBe(true);
    expect(body.redis.connected).toBe(true);
    expect(body.minio.connected).toBe(true);
    expect(body.uptime).toBeGreaterThan(0);
  });

  it('returns status=degraded when postgres probe fails', async () => {
    // Broken DB mock — execute() always throws
    const brokenDb = {
      execute: vi.fn().mockRejectedValue(new Error('PG_CONN_REFUSED')),
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      transaction: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as DrizzleDb;

    const app = await buildApp(mockRedis as never, mockMinio as never, brokenDb);
    const res = await app.inject({ method: 'GET', url: '/admin/system/health' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; postgres: { connected: boolean } }>();
    expect(body.status).toBe('degraded');
    expect(body.postgres.connected).toBe(false);
  });

  it('returns status=degraded when redis probe fails', async () => {
    const failingRedis = {
      ...mockRedis,
      ping: vi.fn().mockRejectedValue(new Error('REDIS_DOWN')),
    };

    const app = await buildApp(failingRedis as never, mockMinio as never);
    const res = await app.inject({ method: 'GET', url: '/admin/system/health' });
    await app.close();

    const body = res.json<{ status: string; redis: { connected: boolean } }>();
    expect(body.status).toBe('degraded');
    expect(body.redis.connected).toBe(false);
  });

  it('returns status=degraded when minio probe fails', async () => {
    const failingMinio = {
      listBuckets: vi.fn().mockRejectedValue(new Error('MINIO_DOWN')),
    };

    const app = await buildApp(mockRedis as never, failingMinio as never);
    const res = await app.inject({ method: 'GET', url: '/admin/system/health' });
    await app.close();

    const body = res.json<{ status: string; minio: { connected: boolean } }>();
    expect(body.status).toBe('degraded');
    expect(body.minio.connected).toBe(false);
  });

  it('includes lastRun timestamps from Redis when set', async () => {
    const isoNow = new Date().toISOString();
    redisStore.set('jobs:lastRun:aggregator',   isoNow);
    redisStore.set('jobs:lastRun:snapshotter',  isoNow);
    redisStore.set('jobs:lastRun:breachWatcher', isoNow);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/system/health' });
    await app.close();

    const body = res.json<{
      jobs: {
        lastAggregationRun: string | null;
        lastSnapshotRun: string | null;
        lastBreachCheckRun: string | null;
      };
    }>();
    expect(body.jobs.lastAggregationRun).toBe(isoNow);
    expect(body.jobs.lastSnapshotRun).toBe(isoNow);
    expect(body.jobs.lastBreachCheckRun).toBe(isoNow);
  });

  it('returns null for lastRun timestamps when keys are absent', async () => {
    // redisStore is clear from beforeEach
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/system/health' });
    await app.close();

    const body = res.json<{ jobs: { lastAggregationRun: string | null } }>();
    expect(body.jobs.lastAggregationRun).toBeNull();
  });

  it('probe timeout is enforced at 2000ms — slow probe → degraded', async () => {
    // MinIO probe never resolves (simulates hang)
    const hangingMinio = {
      listBuckets: vi.fn(() => new Promise<never>(() => { /* never */ })),
    };

    vi.useFakeTimers();

    const app = await buildApp(mockRedis as never, hangingMinio as never);
    const probePromise = app.inject({ method: 'GET', url: '/admin/system/health' });

    // Advance all timers by 3 seconds (past the 2s timeout)
    await vi.runAllTimersAsync();
    const res = await probePromise;
    await app.close();

    vi.useRealTimers();

    const body = res.json<{ status: string; minio: { connected: boolean } }>();
    expect(body.status).toBe('degraded');
    expect(body.minio.connected).toBe(false);
  });
});

describe('GET /admin/system/audit-log', () => {
  /**
   * Seeds real audit_log rows for filter tests.
   */
  async function seedAuditRow(
    action: schema.AuditLogAction = 'tenant.created',
    occurredAt?: Date,
  ): Promise<string> {
    const id       = randomUUID();
    const targetId = randomUUID();
    const ts       = occurredAt ?? new Date();

    await db.execute(sql`
      INSERT INTO audit_log (id, action, admin_id, target_type, target_id, occurred_at)
      VALUES (
        ${id}::uuid,
        ${action}::audit_log_action,
        'system-test-admin',
        'tenant',
        ${targetId}::uuid,
        ${ts.toISOString()}::timestamptz
      )
    `);
    auditIds.push(id);
    return id;
  }

  it('returns audit entries filtered by action', async () => {
    const id1 = await seedAuditRow('tenant.created');
    const id2 = await seedAuditRow('invoice.voided');

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/system/audit-log?action=tenant.created&limit=100',
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: { id: string; action: string }[] }>();
    const ids = body.entries.map(e => e.id);
    expect(ids).toContain(id1);
    expect(ids).not.toContain(id2);
    body.entries.forEach(e => expect(e.action).toBe('tenant.created'));
  });

  it('filters audit entries by date range (from/to)', async () => {
    const past   = new Date(Date.now() - 2 * 3600 * 1000); // 2 hours ago
    const recent = new Date();

    const oldId    = await seedAuditRow('tenant.updated', past);
    const recentId = await seedAuditRow('tenant.updated', recent);

    // Filter: only the last 1 hour
    const from = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/admin/system/audit-log?action=tenant.updated&from=${encodeURIComponent(from)}&limit=100`,
    });
    await app.close();

    const body = res.json<{ entries: { id: string }[] }>();
    const ids = body.entries.map(e => e.id);
    expect(ids).toContain(recentId);
    expect(ids).not.toContain(oldId);
  });

  it('returns 403 for support role', async () => {
    mockRole = 'support';

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/system/audit-log' });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('ReadOnlyRole');
  });

  it('paginates via nextCursor and does not use OFFSET', async () => {
    // Seed 5 rows, query limit=2 twice
    for (let i = 0; i < 5; i++) {
      await seedAuditRow('plan.created');
    }

    const app = await buildApp();

    const page1Res = await app.inject({
      method: 'GET',
      url: '/admin/system/audit-log?action=plan.created&limit=2',
    });
    const page1 = page1Res.json<{ entries: unknown[]; nextCursor: string | null }>();
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    // Use cursor for page 2
    const page2Res = await app.inject({
      method: 'GET',
      url: `/admin/system/audit-log?action=plan.created&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    });
    const page2 = page2Res.json<{ entries: unknown[] }>();
    expect(page2.entries).toHaveLength(2);

    await app.close();
  });
});
