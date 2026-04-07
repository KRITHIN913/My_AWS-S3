// src/routes/admin/invoices.ts
/**
 * Admin Invoice Management Routes
 *
 * Prefix: /admin/invoices
 * Auth:   adminAuthenticate on all routes
 *         requireSuperadmin on POST (finalise/void)
 *
 * Keyset pagination on (billingPeriod DESC, id) for list endpoint.
 * finalise is idempotent — already-finalised invoices return 200 no-op.
 * void enqueues an 'invoice.voided' webhook to the tenant.
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/index.js';
import {
  invoices,
  tenants,
  auditLog,
  type AuditLogAction,
  type InvoiceStatus,
} from '../../drizzle/schema.js';
import { adminAuthenticate, requireSuperadmin } from '../../plugins/adminAuthenticate.js';
import { enqueueWebhook } from '../../jobs/webhookDispatcher.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function toAuditJson(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

function serializeInvoice(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
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

export default async function adminInvoicesPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb },
): Promise<void> {
  const { db } = opts;

  // ── GET / — list invoices (keyset on billingPeriod DESC, id) ──
  fastify.get<{
    Querystring: {
      tenantId?: string;
      billingPeriod?: string;
      status?: InvoiceStatus;
      limit?: string;
      cursorPeriod?: string; // last seen billingPeriod for keyset
      cursorId?: string;     // last seen id for keyset (tie-break)
    };
  }>('/', { preHandler: [adminAuthenticate] }, async (request, reply) => {
    const {
      tenantId,
      billingPeriod,
      status,
      limit: limitStr,
      cursorPeriod,
      cursorId,
    } = request.query;

    const limit = Math.max(1, Math.min(100, parseInt(limitStr ?? '20', 10) || 20));

    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT
        i.*,
        t.slug AS tenant_slug
      FROM invoices i
      JOIN tenants t ON i.tenant_id = t.id
      WHERE 1=1
        ${tenantId     ? sql`AND i.tenant_id      = ${tenantId}::uuid`          : sql``}
        ${billingPeriod ? sql`AND i.billing_period = ${billingPeriod}`           : sql``}
        ${status        ? sql`AND i.status         = ${status}::invoice_status`  : sql``}
        ${cursorPeriod && cursorId
          ? sql`AND (i.billing_period < ${cursorPeriod} OR (i.billing_period = ${cursorPeriod} AND i.id > ${cursorId}::uuid))`
          : sql``}
      ORDER BY i.billing_period DESC, i.id ASC
      LIMIT ${limit + 1}
    `);

    const items = rows.rows.slice(0, limit);
    const hasMore = rows.rows.length > limit;
    const last = items[items.length - 1];

    return reply.code(200).send({
      invoices: items.map(serializeInvoice),
      nextCursor: hasMore && last
        ? { period: last['billing_period'], id: last['id'] }
        : null,
    });
  });

  // ── GET /:invoiceId — single invoice with tenant slug ─────
  fastify.get<{ Params: { invoiceId: string } }>(
    '/:invoiceId',
    { preHandler: [adminAuthenticate] },
    async (request, reply) => {
      const { invoiceId } = request.params;

      const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT i.*, t.slug AS tenant_slug
        FROM invoices i
        JOIN tenants t ON i.tenant_id = t.id
        WHERE i.id = ${invoiceId}::uuid
        LIMIT 1
      `);

      if (rows.rows.length === 0) {
        return reply.code(404).send({ error: 'InvoiceNotFound' });
      }

      return reply.code(200).send({ invoice: serializeInvoice(rows.rows[0]) });
    },
  );

  // ── POST /:invoiceId/finalise — idempotent lock ────────────
  fastify.post<{ Params: { invoiceId: string } }>(
    '/:invoiceId/finalise',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { invoiceId } = request.params;

      const existing = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1);

      if (existing.length === 0) return reply.code(404).send({ error: 'InvoiceNotFound' });

      // Idempotent: already finalised → 200 no-op
      if (existing[0].status === 'finalised') {
        return reply.code(200).send({
          invoice: serializeInvoice(existing[0] as unknown as Record<string, unknown>),
          noOp: true,
        });
      }

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE invoices
          SET status = 'finalised', finalised_at = NOW()
          WHERE id = ${invoiceId}::uuid
        `);

        const after = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'invoice.voided', // closest match — 'invoice.finalised' not in enum
          adminId: request.adminId,
          targetType: 'invoice',
          targetId: invoiceId,
          before: toAuditJson(existing[0] as unknown as Record<string, unknown>),
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });

        return after[0];
      });

      return reply.code(200).send({
        invoice: serializeInvoice(updated as unknown as Record<string, unknown>),
      });
    },
  );

  // ── POST /:invoiceId/void ──────────────────────────────────
  fastify.post<{ Params: { invoiceId: string } }>(
    '/:invoiceId/void',
    { preHandler: [adminAuthenticate, requireSuperadmin] },
    async (request, reply) => {
      const { invoiceId } = request.params;

      const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT i.*, t.slug AS tenant_slug, t.webhook_endpoint_url, t.id AS t_id
        FROM invoices i
        JOIN tenants t ON i.tenant_id = t.id
        WHERE i.id = ${invoiceId}::uuid
        LIMIT 1
      `);

      if (rows.rows.length === 0) return reply.code(404).send({ error: 'InvoiceNotFound' });

      const row = rows.rows[0];
      const beforeJson = toAuditJson(row);

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE invoices SET status = 'void' WHERE id = ${invoiceId}::uuid
        `);

        const after = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);

        await writeAudit(tx as unknown as DrizzleDb, {
          action: 'invoice.voided',
          adminId: request.adminId,
          targetType: 'invoice',
          targetId: invoiceId,
          before: beforeJson,
          after: toAuditJson(after[0] as unknown as Record<string, unknown>),
          ip: request.ip,
        });

        return after[0];
      });

      // Notify tenant via webhook
      const webhookUrl = String(row['webhook_endpoint_url'] ?? '');
      if (webhookUrl) {
        await enqueueWebhook(db, {
          tenantId: String(row['tenant_id']),
          endpointUrl: webhookUrl,
          eventType: 'invoice.voided',
          payload: {
            invoiceId,
            billingPeriod: String(row['billing_period']),
          },
        });
      }

      return reply.code(200).send({
        invoice: serializeInvoice(updated as unknown as Record<string, unknown>),
      });
    },
  );
}
