// src/routes/admin/tenants.ts

import type { FastifyInstance } from 'fastify';
import { eq, sql, and, or, ilike } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DrizzleDb } from '../../db/index.js';
import {
  tenants,
  plans,
  auditLog,
  type AuditLogAction,
  type TenantStatus,
} from '../../drizzle/schema.js';
import {
  adminAuthenticate,
  requireSuperadmin,
} from '../../plugins/adminAuthenticate.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Serialise a row to a JSON string suitable for the audit log.
 * Converts BigInt values to strings to avoid JSON.stringify throwing.
 */
function toAuditJson(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

/**
 * Serialise a row for the HTTP response body.
 * Converts BigInt values to strings so the wire format is JSON-safe.
 */
function serializeTenant(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}

/**
 * Writes an audit_log row inside the supplied transaction.
 */
async function writeAudit(
  tx: DrizzleDb,
  opts: {
    action: AuditLogAction;
    adminId: string;
    targetType: string;
    targetId: string;
    before: string | null;
    after: string | null;
    ip: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_log (action, admin_id, target_type, target_id, before, after, ip)
    VALUES (
      ${opts.action}::audit_log_action,
      ${opts.adminId},
      ${opts.targetType},
      ${opts.targetId},
      ${opts.before},
      ${opts.after},
      ${opts.ip}
    )
  `);
}

// ─────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────

/**
 * Fastify plugin providing all /admin/tenants routes.
 *
 * @param fastify - Fastify instance
 * @param opts    - Drizzle DB handle and ioredis client
 */
export default async function adminTenantsPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis },
): Promise<void> {
  const { db, redis } = opts;

  // ── GET / — list tenants (keyset pagination) ───────────────
  fastify.get<{
    Querystring: {
      status?: TenantStatus;
      planId?: string;
      search?: string;
      limit?: string;
      cursor?: string; // last seen id for keyset pagination
    };
  }>('/', { preHandler: [adminAuthenticate] }, async (request, reply) => {
    const { status, planId, search, limit: limitStr, cursor } = request.query;
    const limit = Math.max(1, Math.min(100, parseInt(limitStr ?? '20', 10) || 20));

    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT
        t.id, t.slug, t.display_name, t.email, t.status, t.plan_id,
        t.max_buckets, t.max_storage_bytes, t.max_monthly_ingress_bytes,
        t.max_monthly_egress_bytes, t.webhook_endpoint_url,
        t.created_at, t.updated_at, t.deleted_at
      FROM tenants t
      WHERE 1=1
        ${status        ? sql`AND t.status   = ${status}::tenant_status`  : sql``}
        ${planId        ? sql`AND t.plan_id  = ${planId}::uuid`           : sql``}
        ${search        ? sql`AND (t.slug ILIKE ${'%' + search + '%'} OR t.email ILIKE ${'%' + search + '%'})` : sql``}
        ${cursor        ? sql`AND t.id > ${cursor}::uuid`                 : sql``}
      ORDER BY t.id ASC
      LIMIT ${limit + 1}
    `);

    const items = rows.rows.slice(0, limit);
    const nextCursor = rows.rows.length > limit
      ? String(rows.rows[limit - 1]?.['id'] ?? '')
      : null;

    return reply.code(200).send({
      tenants: items.map(serializeTenant),
      nextCursor,
    });
  });

  // ── GET /:tenantId — single tenant + live Redis quota ─────
  fastify.get<{ Params: { tenantId: string } }>(
    '/:tenantId',
    { preHandler: [adminAuthenticate] },
    async (request, reply) => {
      const { tenantId } = request.params;

      const result = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (result.length === 0) {
        return reply.code(404).send({ error: 'TenantNotFound' });
      }

      const tenant = result[0];
      const slug   = tenant.slug;

      const now = new Date();
      const period = `${now.getUTCFullYear()}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}`;

      // Fetch live quota usage from Redis
      const [storageStr, ingressStr, egressStr, bucketCountStr] = await Promise.all([
        redis.get(`quota:${slug}:storage_bytes`),
        redis.get(`quota:${slug}:ingress:${period}`),
        redis.get(`quota:${slug}:egress:${period}`),
        redis.get(`quota:${slug}:bucket_count`),
      ]);

      return reply.code(200).send({
        tenant: serializeTenant(tenant as unknown as Record<string, unknown>),
        quotaUsage: {
          storageBytes:  storageStr  ?? '0',
          ingressBytes:  ingressStr  ?? '0',
          egressBytes:   egressStr   ?? '0',
          bucketCount:   bucketCountStr ?? '0',
          billingPeriod: period,
        },
      });
    },
  );

  // ── POST / — create tenant ─────────────────────────────────
  fastify.post<{
    Body: {
      slug: string;
      displayName: string;
      email: string;
      planId?: string;
    };
  }>(
    '/',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { slug, displayName, email, planId } = request.body;

      if (!slug || !displayName || !email) {
        return reply.code(400).send({ error: 'ValidationError', detail: 'slug, displayName, email are required' });
      }

      // Resolve plan limits if planId supplied
      let planLimits: {
        maxBuckets: number;
        maxStorageBytes: bigint;
        maxMonthlyIngressBytes: bigint;
        maxMonthlyEgressBytes: bigint;
      } | null = null;

      if (planId) {
        const planRows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
        if (planRows.length === 0) {
          return reply.code(400).send({ error: 'PlanNotFound', detail: `Plan ${planId} does not exist` });
        }
        const plan = planRows[0];
        planLimits = {
          maxBuckets:             plan.maxBuckets,
          maxStorageBytes:        plan.maxStorageBytes,
          maxMonthlyIngressBytes: plan.maxMonthlyIngressBytes,
          maxMonthlyEgressBytes:  plan.maxMonthlyEgressBytes,
        };
      }

      const ip = request.ip;

      try {
        const created = await db.transaction(async (tx) => {
          const insertResult = await tx.execute<{ id: string }>(sql`
            INSERT INTO tenants (slug, display_name, email, plan_id
              ${planLimits ? sql`, max_buckets, max_storage_bytes, max_monthly_ingress_bytes, max_monthly_egress_bytes` : sql``}
            ) VALUES (
              ${slug}, ${displayName}, ${email}, ${planId ?? null}
              ${planLimits ? sql`, ${planLimits.maxBuckets}, ${planLimits.maxStorageBytes}, ${planLimits.maxMonthlyIngressBytes}, ${planLimits.maxMonthlyEgressBytes}` : sql``}
            )
            RETURNING id
          `);

          const newId = insertResult.rows[0]?.id;
          if (!newId) throw new Error('Insert returned no id');

          const newTenant = await tx.select().from(tenants).where(eq(tenants.id, newId)).limit(1);

          await writeAudit(tx as unknown as DrizzleDb, {
            action: 'tenant.created',
            adminId: request.adminId,
            targetType: 'tenant',
            targetId: newId,
            before: null,
            after: toAuditJson(newTenant[0] as unknown as Record<string, unknown>),
            ip,
          });

          return newTenant[0];
        });

        return reply.code(201).send({ tenant: serializeTenant(created as unknown as Record<string, unknown>) });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unique') || msg.includes('duplicate')) {
          return reply.code(409).send({ error: 'DuplicateSlug', detail: 'A tenant with that slug or email already exists' });
        }
        throw err;
      }
    },
  );

  // ── PATCH /:tenantId — update fields ──────────────────────
  fastify.patch<{
    Params: { tenantId: string };
    Body: {
      displayName?: string;
      email?: string;
      webhookEndpointUrl?: string;
      webhookSecret?: string;
    };
  }>(
    '/:tenantId',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { tenantId } = request.params;
      const { displayName, email, webhookEndpointUrl, webhookSecret } = request.body;

      const existing = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (existing.length === 0) return reply.code(404).send({ error: 'TenantNotFound' });

      const beforeJson = toAuditJson(existing[0] as unknown as Record<string, unknown>);

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE tenants SET
            display_name        = COALESCE(${displayName ?? null}, display_name),
            email               = COALESCE(${email ?? null}, email),
            webhook_endpoint_url = COALESCE(${webhookEndpointUrl ?? null}, webhook_endpoint_url),
            webhook_secret      = COALESCE(${webhookSecret ?? null}, webhook_secret),
            updated_at          = NOW()
          WHERE id = ${tenantId}
        `);

        const after = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'tenant.updated',
          adminId: request.adminId,
          targetType: 'tenant',
          targetId: tenantId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });

        return after[0];
      });

      return reply.code(200).send({ tenant: serializeTenant(updated as unknown as Record<string, unknown>) });
    },
  );

  // ── POST /:tenantId/suspend ────────────────────────────────
  fastify.post<{ Params: { tenantId: string } }>(
    '/:tenantId/suspend',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { tenantId } = request.params;

      const existing = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (existing.length === 0) return reply.code(404).send({ error: 'TenantNotFound' });

      const beforeJson = toAuditJson(existing[0] as unknown as Record<string, unknown>);

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE tenants SET status = 'suspended', updated_at = NOW() WHERE id = ${tenantId}
        `);

        const after = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'tenant.suspended',
          adminId: request.adminId,
          targetType: 'tenant',
          targetId: tenantId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });
      });

      // Invalidate Redis cache
      await redis.hset(`tenant:${existing[0].slug}:meta`, 'status', 'suspended');

      return reply.code(200).send({ ok: true });
    },
  );

  // ── POST /:tenantId/unsuspend ──────────────────────────────
  fastify.post<{ Params: { tenantId: string } }>(
    '/:tenantId/unsuspend',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { tenantId } = request.params;

      const existing = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (existing.length === 0) return reply.code(404).send({ error: 'TenantNotFound' });

      const beforeJson = toAuditJson(existing[0] as unknown as Record<string, unknown>);

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE tenants SET status = 'active', updated_at = NOW() WHERE id = ${tenantId}
        `);

        const after = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'tenant.updated',
          adminId: request.adminId,
          targetType: 'tenant',
          targetId: tenantId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });
      });

      await redis.hset(`tenant:${existing[0].slug}:meta`, 'status', 'active');

      return reply.code(200).send({ ok: true });
    },
  );

  // ── DELETE /:tenantId — soft-delete ───────────────────────
  fastify.delete<{ Params: { tenantId: string } }>(
    '/:tenantId',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { tenantId } = request.params;

      const existing = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (existing.length === 0) return reply.code(404).send({ error: 'TenantNotFound' });

      const beforeJson = toAuditJson(existing[0] as unknown as Record<string, unknown>);

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE tenants
          SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
          WHERE id = ${tenantId}
        `);

        const after = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'tenant.deleted',
          adminId: request.adminId,
          targetType: 'tenant',
          targetId: tenantId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });
      });

      return reply.code(200).send({ ok: true });
    },
  );

  // ── POST /:tenantId/plan — apply plan limits ───────────────
  fastify.post<{
    Params: { tenantId: string };
    Body: { planId: string };
  }>(
    '/:tenantId/plan',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { tenantId } = request.params;
      const { planId }   = request.body;

      if (!planId) return reply.code(400).send({ error: 'ValidationError', detail: 'planId is required' });

      const [existingTenant, planRows] = await Promise.all([
        db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1),
        db.select().from(plans).where(eq(plans.id, planId)).limit(1),
      ]);

      if (existingTenant.length === 0) return reply.code(404).send({ error: 'TenantNotFound' });
      if (planRows.length === 0)       return reply.code(404).send({ error: 'PlanNotFound' });

      const plan = planRows[0];
      const beforeJson = toAuditJson(existingTenant[0] as unknown as Record<string, unknown>);

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE tenants SET
            plan_id                    = ${planId}::uuid,
            max_buckets                = ${plan.maxBuckets},
            max_storage_bytes          = ${plan.maxStorageBytes},
            max_monthly_ingress_bytes  = ${plan.maxMonthlyIngressBytes},
            max_monthly_egress_bytes   = ${plan.maxMonthlyEgressBytes},
            updated_at                 = NOW()
          WHERE id = ${tenantId}
        `);

        const after = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'tenant.plan_changed',
          adminId: request.adminId,
          targetType: 'tenant',
          targetId: tenantId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });

        return after[0];
      });

      // Invalidate Redis meta cache so breach watcher picks up new limits
      await redis.del(`tenant:${existingTenant[0].slug}:meta`);

      return reply.code(200).send({ tenant: serializeTenant(updated as unknown as Record<string, unknown>) });
    },
  );

  // ── PATCH /:tenantId/quota — override individual quotas ───
  fastify.patch<{
    Params: { tenantId: string };
    Body: {
      maxBuckets?: number;
      maxStorageBytes?: string;
      maxMonthlyIngressBytes?: string;
      maxMonthlyEgressBytes?: string;
    };
  }>(
    '/:tenantId/quota',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { tenantId } = request.params;
      const { maxBuckets, maxStorageBytes, maxMonthlyIngressBytes, maxMonthlyEgressBytes } = request.body;

      const existing = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (existing.length === 0) return reply.code(404).send({ error: 'TenantNotFound' });

      const beforeJson = toAuditJson(existing[0] as unknown as Record<string, unknown>);

      // Convert string inputs to BigInt, keeping null for unset fields
      const newStorage = maxStorageBytes        != null ? BigInt(maxStorageBytes)        : null;
      const newIngress = maxMonthlyIngressBytes  != null ? BigInt(maxMonthlyIngressBytes)  : null;
      const newEgress  = maxMonthlyEgressBytes   != null ? BigInt(maxMonthlyEgressBytes)   : null;

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE tenants SET
            max_buckets                = COALESCE(${maxBuckets ?? null}, max_buckets),
            max_storage_bytes          = COALESCE(${newStorage},         max_storage_bytes),
            max_monthly_ingress_bytes  = COALESCE(${newIngress},         max_monthly_ingress_bytes),
            max_monthly_egress_bytes   = COALESCE(${newEgress},          max_monthly_egress_bytes),
            updated_at                 = NOW()
          WHERE id = ${tenantId}
        `);

        const after = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'quota.overridden',
          adminId: request.adminId,
          targetType: 'tenant',
          targetId: tenantId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });

        return after[0];
      });

      // Invalidate Redis meta cache so limits are re-read on next breach check
      await redis.del(`tenant:${existing[0].slug}:meta`);

      return reply.code(200).send({ tenant: serializeTenant(updated as unknown as Record<string, unknown>) });
    },
  );
}
