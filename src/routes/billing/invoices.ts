// src/routes/billing/invoices.ts

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/index.js';
import { invoices, usageMetrics } from '../../drizzle/schema.js';
import { createAuthenticateHandler } from '../../plugins/authenticate.js';


export default async function billingRoutesPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb },
): Promise<void> {
  const db = opts.db;
  const authenticate = createAuthenticateHandler(db);

  // ─────────────────────────────────────────────────────────
  // GET /billing/invoices
  // Query params: period?, status?, limit? (1-100, default 12)
  // ─────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: {
      period?: string;
      status?: 'draft' | 'finalised' | 'void';
      limit?: string;
    };
  }>('/invoices', { preHandler: [authenticate] }, async (request, reply) => {
    const tenantId = request.tenantId;
    const { period, status, limit } = request.query;

    const parsedLimit = limit
      ? Math.max(1, Math.min(100, parseInt(limit, 10) || 12))
      : 12;

    const conditions = [eq(invoices.tenantId, tenantId)];
    if (period) conditions.push(eq(invoices.billingPeriod, period));
    if (status) conditions.push(eq(invoices.status, status));

    const results = await db
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.billingPeriod))
      .limit(parsedLimit);

    // Get total count for the filter (without limit) for pagination metadata
    const countResult = await db
      .select({ count: sql<number>`COUNT(*)::integer` })
      .from(invoices)
      .where(and(...conditions));

    return reply.code(200).send({
      invoices: results,
      total: countResult[0]?.count ?? results.length,
    });
  });

  // ─────────────────────────────────────────────────────────
  // GET /billing/invoices/:invoiceId
  // ─────────────────────────────────────────────────────────

  fastify.get<{
    Params: { invoiceId: string };
  }>(
    '/invoices/:invoiceId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const tenantId = request.tenantId;
      const { invoiceId } = request.params;

      const result = await db
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)),
        )
        .limit(1);

      if (result.length === 0) {
        return reply.code(404).send({ error: 'InvoiceNotFound' });
      }

      return reply.code(200).send({ invoice: result[0] });
    },
  );

  // ─────────────────────────────────────────────────────────
  // GET /billing/usage
  // Query params: period (required, YYYY-MM), granularity? ('daily'|'total')
  // ─────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: {
      period: string;
      granularity?: 'daily' | 'total';
    };
  }>('/usage', { preHandler: [authenticate] }, async (request, reply) => {
    const tenantId = request.tenantId;
    const { period, granularity = 'total' } = request.query;

    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return reply
        .code(400)
        .send({ error: 'Invalid period format. Expected YYYY-MM.' });
    }

    if (granularity === 'total') {
      // Aggregate usage_metrics for the period, return totals per eventType
      const metricsResult = await db.execute<{
        event_type: string;
        total_bytes: string;
        total_requests: string;
      }>(sql`
        SELECT
          event_type,
          COALESCE(SUM(bytes), 0)         AS total_bytes,
          COALESCE(SUM(request_count), 0) AS total_requests
        FROM usage_metrics
        WHERE tenant_id = ${tenantId}
          AND billing_period = ${period}
        GROUP BY event_type
      `);

      const usageTotals: Record<string, { bytes: string; requestCount: number }> = {};
      for (const row of metricsResult.rows) {
        usageTotals[row.event_type] = {
          bytes: row.total_bytes || '0',
          requestCount: parseInt(row.total_requests || '0', 10),
        };
      }

      return reply.code(200).send({
        period,
        usage: usageTotals,
      });
    }

    if (granularity === 'daily') {
      // GROUP BY day + event_type, return array of daily breakdowns
      const dailyResult = await db.execute<{
        date: string;
        event_type: string;
        bytes: string;
        request_count: string;
      }>(sql`
        SELECT
          TO_CHAR(DATE_TRUNC('day', occurred_at), 'YYYY-MM-DD') AS date,
          event_type,
          COALESCE(SUM(bytes), 0)         AS bytes,
          COALESCE(SUM(request_count), 0) AS request_count
        FROM usage_metrics
        WHERE tenant_id = ${tenantId}
          AND billing_period = ${period}
        GROUP BY DATE_TRUNC('day', occurred_at), event_type
        ORDER BY date ASC, event_type ASC
      `);

      const dailyUsage = dailyResult.rows.map((row) => ({
        date: row.date,
        eventType: row.event_type,
        bytes: row.bytes || '0',
        requestCount: parseInt(row.request_count || '0', 10),
      }));

      return reply.code(200).send({
        period,
        usage: dailyUsage,
      });
    }

    return reply
      .code(400)
      .send({ error: 'Invalid granularity. Expected daily or total.' });
  });
}
