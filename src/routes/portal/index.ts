// src/routes/portal/index.ts


import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Client as MinioClient } from 'minio';
import type { DrizzleDb } from '../../db/index.js';
import {
  tenants,
  buckets,
  apiKeys,
  invoices,
  usageMetrics,
  quotaBreachEvents,
} from '../../drizzle/schema.js';
import { createAuthenticateHandler } from '../../plugins/authenticate.js';
import { checkRateLimit, RATE_LIMIT_DEFAULTS } from '../../plugins/rateLimiter.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Serialize any object — converts BigInt values to strings. */
function serialize<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}

/** SHA-256 hex of a string. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Current billing period as 'YYYY-MM'. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}`;
}

/** Cap a BigInt percentage at 100. Returns a plain Number for JSON. */
function pctCapped(used: bigint, limit: bigint): number {
  if (limit <= 0n) return 0;
  const pct = (used * 100n) / limit;
  return Number(pct > 100n ? 100n : pct);
}

// ─────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────

export default async function portalPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis; minioClient: MinioClient },
): Promise<void> {
  const { db, redis, minioClient } = opts;
  const authenticate = createAuthenticateHandler(db);

  // Rate limit helper — applied to all write routes
  async function enforceWriteRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    const { allowed, retryAfterMs } = await checkRateLimit(
      redis,
      request.tenantSlug,
      'portal_write',
      RATE_LIMIT_DEFAULTS['portal_write']!,
    );
    if (!allowed) {
      reply
        .code(429)
        .header('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
        .send({ error: 'RateLimitExceeded', detail: 'Too many requests. Try again later.' });
    }
    return allowed;
  }

  // ── GET /profile ─────────────────────────────────────────
  fastify.get('/profile', { preHandler: [authenticate] }, async (request, reply) => {
    const result = await db
      .select({
        id:                 tenants.id,
        slug:               tenants.slug,
        displayName:        tenants.displayName,
        email:              tenants.email,
        status:             tenants.status,
        planId:             tenants.planId,
        maxBuckets:         tenants.maxBuckets,
        maxStorageBytes:    tenants.maxStorageBytes,
        maxMonthlyIngressBytes: tenants.maxMonthlyIngressBytes,
        maxMonthlyEgressBytes:  tenants.maxMonthlyEgressBytes,
        webhookEndpointUrl: tenants.webhookEndpointUrl,
        createdAt:          tenants.createdAt,
        updatedAt:          tenants.updatedAt,
        // webhookSecret intentionally excluded
      })
      .from(tenants)
      .where(eq(tenants.id, request.tenantId))
      .limit(1);

    if (result.length === 0) return reply.code(404).send({ error: 'TenantNotFound' });

    return reply.code(200).send({ profile: serialize(result[0] as unknown as Record<string, unknown>) });
  });

  // ── PATCH /profile ───────────────────────────────────────
  fastify.patch<{
    Body: {
      displayName?: string;
      email?: string;
      webhookEndpointUrl?: string;
      webhookSecret?: string;
    };
  }>('/profile', { preHandler: [authenticate] }, async (request, reply) => {
    if (!await enforceWriteRateLimit(request, reply)) return;

    const { displayName, email, webhookEndpointUrl, webhookSecret } = request.body;

    await db.execute(sql`
      UPDATE tenants SET
        display_name         = COALESCE(${displayName        ?? null}, display_name),
        email                = COALESCE(${email              ?? null}, email),
        webhook_endpoint_url = COALESCE(${webhookEndpointUrl ?? null}, webhook_endpoint_url),
        webhook_secret       = COALESCE(${webhookSecret      ?? null}, webhook_secret),
        updated_at           = NOW()
      WHERE id = ${request.tenantId}
    `);

    // Invalidate Redis meta cache
    await redis.del(`tenant:${request.tenantSlug}:meta`);

    const updated = await db
      .select({
        id: tenants.id, slug: tenants.slug, displayName: tenants.displayName,
        email: tenants.email, webhookEndpointUrl: tenants.webhookEndpointUrl,
        updatedAt: tenants.updatedAt,
      })
      .from(tenants)
      .where(eq(tenants.id, request.tenantId))
      .limit(1);

    return reply.code(200).send({ profile: serialize(updated[0] as unknown as Record<string, unknown>) });
  });

  // ── GET /keys ─────────────────────────────────────────────
  fastify.get('/keys', { preHandler: [authenticate] }, async (request, reply) => {
    const rows = await db
      .select({
        id:         apiKeys.id,
        keyPrefix:  apiKeys.keyPrefix,
        label:      apiKeys.label,
        status:     apiKeys.status,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt:  apiKeys.expiresAt,
        createdAt:  apiKeys.createdAt,
        revokedAt:  apiKeys.revokedAt,
        // keyHash intentionally excluded
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, request.tenantId))
      .orderBy(desc(apiKeys.createdAt));

    return reply.code(200).send({ keys: rows });
  });

  // ── POST /keys ────────────────────────────────────────────
  fastify.post<{
    Body: { label?: string; expiresAt?: string };
  }>('/keys', { preHandler: [authenticate] }, async (request, reply) => {
    if (!await enforceWriteRateLimit(request, reply)) return;

    const { label, expiresAt } = request.body ?? {};

    // Generate a 32-byte cryptographically random raw key (64 hex chars)
    const rawKey   = randomBytes(32).toString('hex');
    const keyHash  = sha256Hex(rawKey);
    const keyPrefix = rawKey.slice(0, 8);

    const expiresAtDate = expiresAt ? new Date(expiresAt) : null;

    const insertResult = await db.execute<{ id: string }>(sql`
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label, expires_at)
      VALUES (
        ${request.tenantId},
        ${keyHash},
        ${keyPrefix},
        ${label ?? null},
        ${expiresAtDate}
      )
      RETURNING id
    `);

    const id = insertResult.rows[0]?.id;

    // rawKey is returned ONCE — never stored, never retrievable again
    return reply.code(201).send({
      id,
      keyPrefix,
      label:    label ?? null,
      expiresAt: expiresAtDate?.toISOString() ?? null,
      rawKey,   // ← only time this is exposed
    });
  });

  // ── DELETE /keys/:keyId ───────────────────────────────────
  fastify.delete<{ Params: { keyId: string } }>(
    '/keys/:keyId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!await enforceWriteRateLimit(request, reply)) return;

      const { keyId } = request.params;

      // Verify key belongs to requesting tenant before revoking
      const existing = await db
        .select({ id: apiKeys.id, tenantId: apiKeys.tenantId })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, request.tenantId)))
        .limit(1);

      if (existing.length === 0) return reply.code(404).send({ error: 'KeyNotFound' });

      await db.execute(sql`
        UPDATE api_keys
        SET status = 'revoked', revoked_at = NOW()
        WHERE id = ${keyId}
      `);

      return reply.code(200).send({ ok: true });
    },
  );

  // ── GET /buckets ──────────────────────────────────────────
  fastify.get('/buckets', { preHandler: [authenticate] }, async (request, reply) => {
    const rows = await db
      .select()
      .from(buckets)
      .where(
        and(
          eq(buckets.tenantId, request.tenantId),
          sql`${buckets.status} != 'deleted'`,
        ),
      )
      .orderBy(desc(buckets.createdAt));

    return reply.code(200).send({ buckets: rows.map(r => serialize(r as unknown as Record<string, unknown>)) });
  });

  // ── GET /buckets/:name ────────────────────────────────────
  fastify.get<{ Params: { name: string } }>(
    '/buckets/:name',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { name } = request.params;

      const result = await db
        .select()
        .from(buckets)
        .where(
          and(
            eq(buckets.tenantId, request.tenantId),
            eq(buckets.name, name),
            sql`${buckets.status} != 'deleted'`,
          ),
        )
        .limit(1);

      if (result.length === 0) return reply.code(404).send({ error: 'BucketNotFound' });

      const bucket = result[0];
      const liveSize = await redis.get(`quota:${request.tenantSlug}:storage_bytes`);

      return reply.code(200).send({
        bucket: serialize(bucket as unknown as Record<string, unknown>),
        liveSizeBytes: liveSize ?? '0',
      });
    },
  );

  // ── DELETE /buckets/:name — soft-delete + async MinIO removal ──
  fastify.delete<{ Params: { name: string } }>(
    '/buckets/:name',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!await enforceWriteRateLimit(request, reply)) return;

      const { name } = request.params;

      const result = await db
        .select()
        .from(buckets)
        .where(
          and(
            eq(buckets.tenantId, request.tenantId),
            eq(buckets.name, name),
            sql`${buckets.status} != 'deleted'`,
          ),
        )
        .limit(1);

      if (result.length === 0) return reply.code(404).send({ error: 'BucketNotFound' });

      const bucket = result[0];
      const period = currentPeriod();

      // Soft-delete in DB
      await db.execute(sql`
        UPDATE buckets
        SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
        WHERE id = ${bucket.id}
      `);

      // Record bucket_deleted usage event
      await db.execute(sql`
        INSERT INTO usage_metrics (tenant_id, bucket_id, event_type, billing_period, bytes, request_count)
        VALUES (${request.tenantId}, ${bucket.id}, 'bucket_deleted', ${period}, 0, 1)
      `);

      // Decrement Redis bucket counter
      await redis.decr(`quota:${request.tenantSlug}:bucket_count`);

      // Remove physical bucket from MinIO — async, after response
      setImmediate(() => {
        minioClient.removeBucket(bucket.physicalName).catch((err: unknown) => {
          console.error(`[WARN] Could not remove MinIO bucket ${bucket.physicalName}:`, err);
        });
      });

      return reply.code(200).send({ ok: true });
    },
  );

  // ── GET /usage/current ────────────────────────────────────
  fastify.get('/usage/current', { preHandler: [authenticate] }, async (request, reply) => {
    const slug   = request.tenantSlug;
    const period = currentPeriod();

    const [storageStr, ingressStr, egressStr, bucketCountStr] = await Promise.all([
      redis.get(`quota:${slug}:storage_bytes`),
      redis.get(`quota:${slug}:ingress:${period}`),
      redis.get(`quota:${slug}:egress:${period}`),
      redis.get(`quota:${slug}:bucket_count`),
    ]);

    // Load limits — try Redis meta cache first, fall back to DB
    let meta = await redis.hgetall(`tenant:${slug}:meta`);
    if (Object.keys(meta).length === 0) {
      const tenantRow = await db
        .select({
          maxStorageBytes:        tenants.maxStorageBytes,
          maxMonthlyIngressBytes: tenants.maxMonthlyIngressBytes,
          maxMonthlyEgressBytes:  tenants.maxMonthlyEgressBytes,
          maxBuckets:             tenants.maxBuckets,
          status:                 tenants.status,
        })
        .from(tenants)
        .where(eq(tenants.id, request.tenantId))
        .limit(1);

      if (tenantRow.length > 0) {
        const t = tenantRow[0];
        meta = {
          maxStorageBytes:        t.maxStorageBytes.toString(),
          maxMonthlyIngressBytes: t.maxMonthlyIngressBytes.toString(),
          maxMonthlyEgressBytes:  t.maxMonthlyEgressBytes.toString(),
          maxBuckets:             t.maxBuckets.toString(),
          status:                 t.status,
        };
        await redis.hset(`tenant:${slug}:meta`, meta);
        await redis.expire(`tenant:${slug}:meta`, 300);
      }
    }

    const maxStorage = BigInt(meta['maxStorageBytes']        ?? '107374182400');
    const maxIngress = BigInt(meta['maxMonthlyIngressBytes'] ?? '10737418240');
    const maxEgress  = BigInt(meta['maxMonthlyEgressBytes']  ?? '10737418240');
    const maxBuckets = BigInt(meta['maxBuckets']             ?? '10');

    const storage    = BigInt(storageStr    ?? '0');
    const ingress    = BigInt(ingressStr    ?? '0');
    const egress     = BigInt(egressStr     ?? '0');
    const bucketCnt  = BigInt(bucketCountStr ?? '0');

    return reply.code(200).send({
      period,
      storageBytes:  storage.toString(),
      ingressBytes:  ingress.toString(),
      egressBytes:   egress.toString(),
      bucketCount:   bucketCnt.toString(),
      limits: {
        maxStorageBytes:        maxStorage.toString(),
        maxMonthlyIngressBytes: maxIngress.toString(),
        maxMonthlyEgressBytes:  maxEgress.toString(),
        maxBuckets:             maxBuckets.toString(),
      },
      pctUsed: {
        storage: pctCapped(storage,   maxStorage),
        ingress: pctCapped(ingress,   maxIngress),
        egress:  pctCapped(egress,    maxEgress),
        buckets: pctCapped(bucketCnt, maxBuckets),
      },
    });
  });

  // ── GET /usage/history ────────────────────────────────────
  fastify.get<{ Querystring: { limit?: string } }>(
    '/usage/history',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const limit = Math.max(1, Math.min(24, parseInt(request.query.limit ?? '12', 10) || 12));

      const rows = await db
        .select({
          billingPeriod:    invoices.billingPeriod,
          storageByteAvg:   invoices.storageByteAvg,
          ingressBytes:     invoices.ingressBytes,
          egressBytes:      invoices.egressBytes,
          bucketCount:      invoices.bucketCount,
          totalChargeUcents: invoices.totalChargeUcents,
          status:           invoices.status,
        })
        .from(invoices)
        .where(eq(invoices.tenantId, request.tenantId))
        .orderBy(desc(invoices.billingPeriod))
        .limit(limit);

      return reply.code(200).send({
        history: rows.map(r => serialize(r as unknown as Record<string, unknown>)),
      });
    },
  );

  // ── GET /alerts ───────────────────────────────────────────
  fastify.get<{
    Querystring: { limit?: string; unread?: string };
  }>('/alerts', { preHandler: [authenticate] }, async (request, reply) => {
    const limit  = Math.max(1, Math.min(100, parseInt(request.query.limit ?? '20', 10) || 20));
    const unread = request.query.unread === 'true';

    const conditions = [eq(quotaBreachEvents.tenantId, request.tenantId)];
    if (unread) {
      conditions.push(eq(quotaBreachEvents.webhookDispatched, false));
    }

    const rows = await db
      .select()
      .from(quotaBreachEvents)
      .where(and(...conditions))
      .orderBy(desc(quotaBreachEvents.detectedAt))
      .limit(limit);

    return reply.code(200).send({
      alerts: rows.map(r => serialize(r as unknown as Record<string, unknown>)),
    });
  });
}
