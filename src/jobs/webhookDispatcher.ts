// src/jobs/webhookDispatcher.ts
/**
 * Webhook Dispatcher Job
 * 
 * Polls for pending webhook deliveries and attempts reliable HTTP delivery.
 * Implements exponential backoff, HMAC-SHA256 signatures, and timeout protection.
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent dispatchers from double-delivering.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { DrizzleDb } from '../db/index.js';
import { tenants } from '../drizzle/schema.js';

export default async function webhookDispatcherPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb },
): Promise<void> {
  let timer: NodeJS.Timeout;

  fastify.ready(() => {
    // Run every 30 seconds
    timer = setInterval(async () => {
      try {
        const result = await dispatchPendingWebhooks(opts.db);
        if (result.dispatched > 0 || result.failed > 0) {
          fastify.log.info(`Webhook dispatcher: ${result.dispatched} dispatched, ${result.failed} failed/retrying`);
        }
      } catch (err) {
        fastify.log.error(err, 'Webhook dispatcher failed');
      }
    }, 30 * 1000);
  });

  fastify.addHook('onClose', (instance, done) => {
    clearInterval(timer);
    done();
  });
}

/**
 * Iterates through pending webhooks and attempts delivery.
 * Exported for testing.
 */
export async function dispatchPendingWebhooks(db: DrizzleDb): Promise<{
  dispatched: number;
  failed: number;
}> {
  let dispatched = 0;
  let failed = 0;

  const backoffSchedule = [30, 120, 600, 3600, 86400];

  // We explicitly run inside a transaction to use FOR UPDATE SKIP LOCKED
  await db.transaction(async (tx) => {
    // 1. SELECT pending webhooks with strict ordering and row-level locking
    const pendingDeliveries = await tx.execute<{
      id: string;
      tenant_id: string;
      endpoint_url: string;
      event_type: string;
      payload: string;
      attempt_count: number;
      max_attempts: number;
      tenant_secret: string | null;
    }>(sql`
      SELECT w.id, w.tenant_id, w.endpoint_url, w.event_type, w.payload, w.attempt_count, w.max_attempts, t.webhook_secret as tenant_secret
      FROM webhook_deliveries w
      JOIN tenants t ON w.tenant_id = t.id
      WHERE w.status IN ('pending', 'retrying')
        AND w.next_retry_at <= NOW()
      ORDER BY w.next_retry_at ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    `);

    for (const delivery of pendingDeliveries) {
      if (!delivery.endpoint_url || !delivery.tenant_secret) {
        // Missing configuration, immediately fail it
        await tx.execute(sql`
          UPDATE webhook_deliveries
          SET status = 'failed', completed_at = NOW(), last_error = 'Missing webhook secret or URL'
          WHERE id = ${delivery.id}
        `);
        failed++;
        continue;
      }

      const sig = createHmac('sha256', delivery.tenant_secret)
        .update(delivery.payload)
        .digest('hex');

      const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': delivery.event_type,
        'X-Delivery-Id': delivery.id,
        'X-Signature-256': `sha256=${sig}`,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

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
          if (err.name === 'AbortError') {
            errorMsg = 'Delivery timed out after 10s';
          } else {
            errorMsg = err.message;
          }
        } else {
          errorMsg = String(err);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      console.info(`[INFO] Webhook delivery attempt (Tenant: ${delivery.tenant_id}, Event: ${delivery.event_type}, ID: ${delivery.id}, Status: ${statusCode}, Attempt: ${delivery.attempt_count + 1})`);

      if (statusCode && statusCode >= 200 && statusCode < 300) {
        // Success
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
        // Failure or timeout
        const nextAttemptCount = delivery.attempt_count + 1;
        
        if (nextAttemptCount >= delivery.max_attempts) {
          // Exhausted max attempts
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
          // Try again later (backoff)
          const backoffSecs = backoffSchedule[nextAttemptCount - 1] ?? 86400;
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

/** 
 * Called by other jobs to enqueue a webhook without sending immediately. 
 * Re-uses an active transaction db proxy if passed as `db`.
 */
export async function enqueueWebhook(
  db: DrizzleDb,
  params: {
    tenantId: string;
    endpointUrl: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const payloadString = JSON.stringify(params.payload, (key, value) => 
    typeof value === 'bigint' ? value.toString() : value
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
