// src/routes/admin/system.ts

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Client as MinioClient } from 'minio';
import type { DrizzleDb } from '../../db/index.js';
import { adminAuthenticate, requireSuperadmin } from '../../plugins/adminAuthenticate.js';
import type { AuditLogAction } from '../../drizzle/schema.js';

/** Probe timeout in milliseconds. */
const PROBE_TIMEOUT_MS = 2_000;

/** Latency threshold above which status becomes 'degraded'. */
const LATENCY_THRESHOLD_MS = 1_000;

// ─────────────────────────────────────────────────────────────
// Probe helpers
// ─────────────────────────────────────────────────────────────

/**
 * Wraps a promise with a 2-second hard timeout.
 * Resolves with { ok: true, latencyMs } on success.
 * Resolves with { ok: false, latencyMs } on failure (never rejects).
 */
async function probe(
  fn: () => Promise<void>,
): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('probe_timeout')), PROBE_TIMEOUT_MS),
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────

export default async function adminSystemPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis; minioClient: MinioClient },
): Promise<void> {
  const { db, redis, minioClient } = opts;

  // ── GET /health ────────────────────────────────────────────
  fastify.get('/health', { preHandler: [adminAuthenticate] }, async (_request, reply) => {
    const [pgProbe, redisProbe, minioProbe] = await Promise.all([
      probe(async () => {
        await db.execute(sql`SELECT 1`);
      }),
      probe(async () => {
        const pong = await redis.ping();
        if (pong !== 'PONG') throw new Error('unexpected_pong');
      }),
      probe(async () => {
        await minioClient.listBuckets();
      }),
    ]);

    // Read last job run timestamps from Redis
    const [lastAgg, lastSnap, lastBreach] = await Promise.all([
      redis.get('jobs:lastRun:aggregator'),
      redis.get('jobs:lastRun:snapshotter'),
      redis.get('jobs:lastRun:breachWatcher'),
    ]);

    const isDegraded =
      !pgProbe.ok    || pgProbe.latencyMs    > LATENCY_THRESHOLD_MS ||
      !redisProbe.ok || redisProbe.latencyMs > LATENCY_THRESHOLD_MS ||
      !minioProbe.ok || minioProbe.latencyMs > LATENCY_THRESHOLD_MS;

    return reply.code(200).send({
      status: isDegraded ? 'degraded' : 'ok',
      postgres: {
        connected:  pgProbe.ok,
        latencyMs:  pgProbe.latencyMs,
      },
      redis: {
        connected:  redisProbe.ok,
        latencyMs:  redisProbe.latencyMs,
      },
      minio: {
        connected:  minioProbe.ok,
        latencyMs:  minioProbe.latencyMs,
      },
      jobs: {
        lastAggregationRun:  lastAgg  ?? null,
        lastSnapshotRun:     lastSnap ?? null,
        lastBreachCheckRun:  lastBreach ?? null,
      },
      uptime: process.uptime(),
    });
  });

  // ── GET /audit-log — paginated, filtered ──────────────────
  fastify.get<{
    Querystring: {
      action?: AuditLogAction;
      adminId?: string;
      targetType?: string;
      targetId?: string;
      from?: string;   // ISO date string
      to?: string;     // ISO date string
      limit?: string;
      cursor?: string; // last seen occurredAt ISO string (keyset on occurredAt DESC)
    };
  }>(
    '/audit-log',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const {
        action,
        adminId,
        targetType,
        targetId,
        from,
        to,
        limit: limitStr,
        cursor,
      } = request.query;

      const limit = Math.max(1, Math.min(100, parseInt(limitStr ?? '50', 10) || 50));

      const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT *
        FROM audit_log
        WHERE 1=1
          ${action     ? sql`AND action      = ${action}::audit_log_action` : sql``}
          ${adminId    ? sql`AND admin_id    = ${adminId}`                   : sql``}
          ${targetType ? sql`AND target_type = ${targetType}`                : sql``}
          ${targetId   ? sql`AND target_id   = ${targetId}::uuid`            : sql``}
          ${from       ? sql`AND occurred_at >= ${from}::timestamptz`        : sql``}
          ${to         ? sql`AND occurred_at <= ${to}::timestamptz`          : sql``}
          ${cursor     ? sql`AND occurred_at < ${cursor}::timestamptz`       : sql``}
        ORDER BY occurred_at DESC
        LIMIT ${limit + 1}
      `);

      const items = rows.rows.slice(0, limit);
      const hasMore = rows.rows.length > limit;
      const last = items[items.length - 1];

      return reply.code(200).send({
        entries: items,
        nextCursor: hasMore && last
          ? String(last['occurred_at'])
          : null,
      });
    },
  );
}
