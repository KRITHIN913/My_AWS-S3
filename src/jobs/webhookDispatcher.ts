// src/jobs/webhookDispatcher.ts
/**

 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { DrizzleDb } from '../db/index.js';

/** Interval between dispatcher polls (30 seconds). */
const POLL_INTERVAL_MS = 30 * 1000;

/** Maximum number of deliveries to process per poll cycle. */
const BATCH_SIZE = 50;

/** Fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/** Exponential backoff schedule in seconds, indexed by attempt - 1. */
const BACKOFF_SCHEDULE_SECS = [30, 120, 600, 3600, 86400];


export default async function webhookDispatcherPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb },
): Promise<void> {
  let timer: NodeJS.Timeout;

  fastify.ready(() => {
    timer = setInterval(async () => {
      try {
        const result = await dispatchPendingWebhooks(opts.db);
        if (result.dispatched > 0 || result.failed > 0) {
          fastify.log.info(
            `Webhook dispatcher: ${result.dispatched} dispatched, ${result.failed} failed/retrying`,
          );
        }
      } catch (err) {
        fastify.log.error(err, 'Webhook dispatcher failed');
      }
    }, POLL_INTERVAL_MS);
  });

  fastify.addHook('onClose', (_instance, done) => {
    clearInterval(timer);
    done();
  });
}

// ─────────────────────────────────────────────────────────────
// Core dispatch logic — exported for testing
// ─────────────────────────────────────────────────────────────

export async function dispatchPendingWebhooks(db: DrizzleDb): Promise<{
  dispatched: number;
  failed: number;
}> {
  let dispatched = 0;
  let failed = 0;

  // Run inside a transaction to hold the row-level locks
  await db.transaction(async (tx) => {
    // 1. SELECT pending webhooks with row-level locking
    const pendingResult = await tx.execute<{
      id: string;
      tenant_id: string;
      endpoint_url: string;
      event_type: string;
      payload: string;
      attempt_count: number;
      max_attempts: number;
      tenant_secret: string | null;
    }>(sql`
      SELECT
        w.id,
        w.tenant_id,
        w.endpoint_url,
        w.event_type,
        w.payload,
        w.attempt_count,
        w.max_attempts,
        t.webhook_secret AS tenant_secret
      FROM webhook_deliveries w
      JOIN tenants t ON w.tenant_id = t.id
      WHERE w.status IN ('pending', 'retrying')
        AND w.next_retry_at <= NOW()
      ORDER BY w.next_retry_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE OF w SKIP LOCKED
    `);

    // 2. Attempt delivery for each row
    for (const delivery of pendingResult.rows) {
      if (!delivery.endpoint_url || !delivery.tenant_secret) {
        // Missing configuration — immediately fail
        await tx.execute(sql`
          UPDATE webhook_deliveries
          SET
            status = 'failed',
            completed_at = NOW(),
            last_attempt_at = NOW(),
            attempt_count = attempt_count + 1,
            last_error = 'Missing webhook secret or endpoint URL'
          WHERE id = ${delivery.id}
        `);
        failed++;
        continue;
      }

      // Compute HMAC-SHA256 signature
      const sig = createHmac('sha256', delivery.tenant_secret)
        .update(delivery.payload)
        .digest('hex');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': delivery.event_type,
        'X-Delivery-Id': delivery.id,
        'X-Signature-256': `sha256=${sig}`,
      };

      // 10-second timeout via AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let statusCode: number | null = null;
      let errorMsg: string | null = null;

      try {
        const response = await fetch(delivery.endpoint_url, {
          method: 'POST',
          headers,
          body: delivery.payload,
          signal: controller.signal,
        });

        statusCode = response.status;

        if (!response.ok) {
          errorMsg = `HTTP Error ${statusCode}: ${response.statusText}`;
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          errorMsg =
            err.name === 'AbortError'
              ? 'Delivery timed out after 10s'
              : err.message;
        } else {
          errorMsg = String(err);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      // Log every attempt at INFO level
      console.info(
        `[INFO] Webhook delivery attempt ` +
          `(Tenant: ${delivery.tenant_id}, Event: ${delivery.event_type}, ` +
          `ID: ${delivery.id}, Status: ${statusCode}, ` +
          `Attempt: ${delivery.attempt_count + 1})`,
      );

      // ── Handle result ─────────────────────────────────────
      if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
        // Success path
        await tx.execute(sql`
          UPDATE webhook_deliveries
          SET
            status = 'success',
            last_status_code = ${statusCode},
            attempt_count = attempt_count + 1,
            last_attempt_at = NOW(),
            completed_at = NOW()
          WHERE id = ${delivery.id}
        `);
        dispatched++;
      } else {
        // Failure path — advance attempt count and apply backoff
        const nextAttemptCount = delivery.attempt_count + 1;

        if (nextAttemptCount >= delivery.max_attempts) {
          // Exhausted all retries
          await tx.execute(sql`
            UPDATE webhook_deliveries
            SET
              status = 'failed',
              last_status_code = ${statusCode},
              last_error = ${errorMsg},
              attempt_count = attempt_count + 1,
              last_attempt_at = NOW(),
              completed_at = NOW()
            WHERE id = ${delivery.id}
          `);
        } else {
          // Schedule retry with exponential backoff
          const backoffSecs =
            BACKOFF_SCHEDULE_SECS[nextAttemptCount - 1] ?? 86400;
          await tx.execute(sql`
            UPDATE webhook_deliveries
            SET
              status = 'retrying',
              last_status_code = ${statusCode},
              last_error = ${errorMsg},
              attempt_count = attempt_count + 1,
              last_attempt_at = NOW(),
              next_retry_at = NOW() + INTERVAL '1 second' * ${backoffSecs}
            WHERE id = ${delivery.id}
          `);
        }
        failed++;
      }
    }
  });

  return { dispatched, failed };
}

// ─────────────────────────────────────────────────────────────
// Webhook enqueue utility — used by other jobs
// ─────────────────────────────────────────────────────────────


export async function enqueueWebhook(
  db: DrizzleDb,
  params: {
    tenantId: string;
    endpointUrl: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  // Serialise with BigInt-safe replacer to avoid TypeError
  const payloadString = JSON.stringify(params.payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

  await db.execute(sql`
    INSERT INTO webhook_deliveries (
      tenant_id,
      endpoint_url,
      event_type,
      payload
    ) VALUES (
      ${params.tenantId},
      ${params.endpointUrl},
      ${params.eventType},
      ${payloadString}
    )
  `);
}
