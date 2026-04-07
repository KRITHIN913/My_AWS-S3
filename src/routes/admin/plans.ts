// src/routes/admin/plans.ts
/**
 * Admin Plan Management Routes
 *
 * Prefix: /admin/plans
 * Auth:   adminAuthenticate on all routes
 *         requireSuperadmin on POST/PATCH/DELETE
 *
 * Plan updates do NOT retroactively change tenant quotas.
 * Plans can only be soft-deleted (isActive=false) if no tenants
 * are currently assigned to them.
 */
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/index.js';
import { plans, tenants, auditLog, type AuditLogAction } from '../../drizzle/schema.js';
import { adminAuthenticate, requireSuperadmin } from '../../plugins/adminAuthenticate.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function toAuditJson(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

function serializePlan(plan: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(plan)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}

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

export default async function adminPlansPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb },
): Promise<void> {
  const { db } = opts;

  // ── GET / — list all plans ─────────────────────────────────
  fastify.get<{
    Querystring: { isActive?: string };
  }>('/', { preHandler: [adminAuthenticate] }, async (request, reply) => {
    const { isActive } = request.query;

    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT * FROM plans
      WHERE 1=1
        ${isActive !== undefined ? sql`AND is_active = ${isActive === 'true'}` : sql``}
      ORDER BY created_at ASC
    `);

    return reply.code(200).send({ plans: rows.rows.map(serializePlan) });
  });

  // ── GET /:planId — single plan + tenant count ──────────────
  fastify.get<{ Params: { planId: string } }>(
    '/:planId',
    { preHandler: [adminAuthenticate] },
    async (request, reply) => {
      const { planId } = request.params;

      const planRows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
      if (planRows.length === 0) return reply.code(404).send({ error: 'PlanNotFound' });

      const countResult = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::bigint AS count FROM tenants WHERE plan_id = ${planId}::uuid
      `);
      const tenantCount = parseInt(countResult.rows[0]?.count ?? '0', 10);

      return reply.code(200).send({
        plan: serializePlan(planRows[0] as unknown as Record<string, unknown>),
        tenantCount,
      });
    },
  );

  // ── POST / — create plan ───────────────────────────────────
  fastify.post<{
    Body: {
      name: string;
      maxBuckets: number;
      maxStorageBytes: string;
      maxMonthlyIngressBytes: string;
      maxMonthlyEgressBytes: string;
      priceUcentsPerMonth?: string;
      isActive?: boolean;
    };
  }>(
    '/',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const {
        name,
        maxBuckets,
        maxStorageBytes,
        maxMonthlyIngressBytes,
        maxMonthlyEgressBytes,
        priceUcentsPerMonth = '0',
        isActive = true,
      } = request.body;

      if (!name || !maxBuckets || !maxStorageBytes || !maxMonthlyIngressBytes || !maxMonthlyEgressBytes) {
        return reply.code(400).send({ error: 'ValidationError', detail: 'All plan fields are required' });
      }

      const created = await db.transaction(async (tx) => {
        const insertResult = await tx.execute<{ id: string }>(sql`
          INSERT INTO plans (
            name, max_buckets, max_storage_bytes,
            max_monthly_ingress_bytes, max_monthly_egress_bytes,
            price_ucents_per_month, is_active
          ) VALUES (
            ${name},
            ${maxBuckets},
            ${BigInt(maxStorageBytes)},
            ${BigInt(maxMonthlyIngressBytes)},
            ${BigInt(maxMonthlyEgressBytes)},
            ${BigInt(priceUcentsPerMonth)},
            ${isActive}
          )
          RETURNING id
        `);

        const newId = insertResult.rows[0]?.id;
        if (!newId) throw new Error('Insert returned no id');

        const newPlan = await tx.select().from(plans).where(eq(plans.id, newId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'plan.created',
          adminId: request.adminId,
          targetType: 'plan',
          targetId: newId,
          before: null,
          after: toAuditJson(newPlan[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });

        return newPlan[0];
      });

      return reply.code(201).send({
        plan: serializePlan(created as unknown as Record<string, unknown>),
      });
    },
  );

  // ── PATCH /:planId — update plan fields ───────────────────
  // IMPORTANT: does NOT retroactively update tenant quotas.
  fastify.patch<{
    Params: { planId: string };
    Body: {
      name?: string;
      maxBuckets?: number;
      maxStorageBytes?: string;
      maxMonthlyIngressBytes?: string;
      maxMonthlyEgressBytes?: string;
      priceUcentsPerMonth?: string;
      isActive?: boolean;
    };
  }>(
    '/:planId',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { planId } = request.params;
      const {
        name,
        maxBuckets,
        maxStorageBytes,
        maxMonthlyIngressBytes,
        maxMonthlyEgressBytes,
        priceUcentsPerMonth,
        isActive,
      } = request.body;

      const existing = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
      if (existing.length === 0) return reply.code(404).send({ error: 'PlanNotFound' });

      const beforeJson = toAuditJson(existing[0] as unknown as Record<string, unknown>);

      const newStorage = maxStorageBytes        != null ? BigInt(maxStorageBytes)        : null;
      const newIngress = maxMonthlyIngressBytes  != null ? BigInt(maxMonthlyIngressBytes)  : null;
      const newEgress  = maxMonthlyEgressBytes   != null ? BigInt(maxMonthlyEgressBytes)   : null;
      const newPrice   = priceUcentsPerMonth     != null ? BigInt(priceUcentsPerMonth)     : null;

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE plans SET
            name                       = COALESCE(${name ?? null},        name),
            max_buckets                = COALESCE(${maxBuckets ?? null},   max_buckets),
            max_storage_bytes          = COALESCE(${newStorage},           max_storage_bytes),
            max_monthly_ingress_bytes  = COALESCE(${newIngress},           max_monthly_ingress_bytes),
            max_monthly_egress_bytes   = COALESCE(${newEgress},            max_monthly_egress_bytes),
            price_ucents_per_month     = COALESCE(${newPrice},             price_ucents_per_month),
            is_active                  = COALESCE(${isActive ?? null},     is_active),
            updated_at                 = NOW()
          WHERE id = ${planId}::uuid
        `);

        const after = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'plan.updated',
          adminId: request.adminId,
          targetType: 'plan',
          targetId: planId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });

        return after[0];
      });

      return reply.code(200).send({
        plan: serializePlan(updated as unknown as Record<string, unknown>),
      });
    },
  );

  // ── DELETE /:planId — soft-delete (isActive=false) ────────
  // Blocked if any tenants are currently on this plan.
  fastify.delete<{ Params: { planId: string } }>(
    '/:planId',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { planId } = request.params;

      const existing = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
      if (existing.length === 0) return reply.code(404).send({ error: 'PlanNotFound' });

      // Block if tenants are still using this plan
      const countResult = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::bigint AS count
        FROM tenants
        WHERE plan_id = ${planId}::uuid AND status != 'deleted'
      `);
      const tenantCount = parseInt(countResult.rows[0]?.count ?? '0', 10);
      if (tenantCount > 0) {
        return reply.code(409).send({
          error: 'PlanInUse',
          detail: `${tenantCount} tenant(s) are still assigned to this plan`,
        });
      }

      const beforeJson = toAuditJson(existing[0] as unknown as Record<string, unknown>);

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE plans SET is_active = false, updated_at = NOW() WHERE id = ${planId}::uuid
        `);

        const after = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'plan.updated',
          adminId: request.adminId,
          targetType: 'plan',
          targetId: planId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });
      });

      return reply.code(200).send({ ok: true });
    },
  );
}
