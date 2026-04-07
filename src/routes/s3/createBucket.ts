// src/routes/s3/createBucket.ts

/**
 * S3 CreateBucket Route Plugin
 *
 * Handles `PUT /:bucketName` — the S3-compatible CreateBucket operation.
 *
 * Execution sequence:
 *   ① Authenticate (via upstream preHandler)
 *   ② Validate bucket name (S3 naming rules)
 *   ③ Load tenant quota (Redis cache → Postgres fallback)
 *   ④ Check bucket count quota
 *   ⑤ Check for duplicate bucket (idempotency)
 *   ⑥ Acquire advisory lock (inside transaction)
 *   ⑦ Postgres transaction (insert bucket + usage_metric)
 *   ⑧ Provision physical bucket in MinIO
 *   ⑨ Flip bucket status to 'active'
 *   ⑩ Update Redis counters
 *   ⑪ Return 200 with Location header
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull, sql } from 'drizzle-orm';

import { buckets, usageMetrics } from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';
import type { Redis } from 'ioredis';
import type { Client as MinioClientType } from 'minio';
import { createAuthenticateHandler } from '../../plugins/authenticate.js';
import {
  getBucketCount,
  getTenantQuota,
  incrementBucketCount,
} from '../../lib/quotaService.js';

// ─────────────────────────────────────────────────────────────
// S3 XML error helper
// ─────────────────────────────────────────────────────────────

export function buildS3Error(
  code: string,
  message: string,
  bucketName: string,
  requestId: string,
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Error>` +
    `<Code>${code}</Code>` +
    `<Message>${message}</Message>` +
    `<BucketName>${bucketName}</BucketName>` +
    `<RequestId>${requestId}</RequestId>` +
    `</Error>`
  );
}

// ─────────────────────────────────────────────────────────────
// Bucket name validation
// ─────────────────────────────────────────────────────────────


const BUCKET_NAME_PATTERN = /^[a-z0-9-]+$/;


const IP_ADDRESS_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;


export function validateBucketName(name: string): string | null {
  if (name.length < 3) {
    return 'Bucket name must be at least 3 characters long';
  }
  if (name.length > 63) {
    return 'Bucket name must not exceed 63 characters';
  }
  if (!BUCKET_NAME_PATTERN.test(name)) {
    return 'Bucket name can only contain lowercase letters, numbers, and hyphens';
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    return 'Bucket name must not start or end with a hyphen';
  }
  if (IP_ADDRESS_PATTERN.test(name)) {
    return 'Bucket name must not be formatted as an IP address';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Current billing period helper
// ─────────────────────────────────────────────────────────────

function currentBillingPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;    
}

// ─────────────────────────────────────────────────────────────
// Route plugin
// ─────────────────────────────────────────────────────────────

/** Options injected into the plugin at registration time. */
export interface CreateBucketPluginOptions {
  db: DrizzleDb;
  redis: Redis;
  minioClient: MinioClientType;
}


export default async function createBucketPlugin(
  fastify: FastifyInstance,
  opts: CreateBucketPluginOptions,
): Promise<void> {
  const { db, redis, minioClient } = opts;
  const authenticate = createAuthenticateHandler(db);

  fastify.route<{
    Params: { bucketName: string };
  }>({
    method: 'PUT',
    url: '/:bucketName',
    preHandler: [authenticate],
    schema: {
      params: {
        type: 'object',
        properties: { bucketName: { type: 'string' } },
        required: ['bucketName'],
      },
    },

    handler: async (
      request: FastifyRequest<{ Params: { bucketName: string } }>,
      reply: FastifyReply,
    ): Promise<void> => {
      const { bucketName } = request.params;
      const tenantId = request.tenantId;
      const tenantSlug = request.tenantSlug;
      const requestId = request.id;

      // ② Validate bucket name
      const validationError = validateBucketName(bucketName);
      if (validationError) {
        reply
          .code(400)
          .type('application/xml')
          .send(buildS3Error('InvalidBucketName', validationError, bucketName, requestId));
        return;
      }

      // ③ Load tenant quota (Redis cache → Postgres fallback)
      let tenantQuota: Awaited<ReturnType<typeof getTenantQuota>>;
      try {
        tenantQuota = await getTenantQuota(tenantId, tenantSlug, db, redis);
      } catch (err) {
        request.log.error({ err, tenantId, bucketName }, 'Failed to load tenant quota');
        reply
          .code(500)
          .type('application/xml')
          .send(buildS3Error('InternalError', 'Unable to load tenant information', bucketName, requestId));
        return;
      }

      // Check tenant status
      if (tenantQuota.status !== 'active') {
        reply
          .code(403)
          .type('application/xml')
          .send(buildS3Error('AccountSuspended', 'Tenant account is not active', bucketName, requestId));
        return;
      }

      // ④ Quota check — bucket count
      let currentBucketCount: number;
      try {
        currentBucketCount = await getBucketCount(tenantId, tenantSlug, db, redis);
      } catch (err) {
        request.log.error({ err, tenantId, bucketName }, 'Failed to get bucket count');
        reply
          .code(500)
          .type('application/xml')
          .send(buildS3Error('InternalError', 'Unable to check bucket quota', bucketName, requestId));
        return;
      }

      if (currentBucketCount >= tenantQuota.maxBuckets) {
        reply
          .code(409)
          .type('application/xml')
          .send(buildS3Error('QuotaExceeded', 'Bucket quota reached', bucketName, requestId));
        return;
      }

      // ⑤ Check for duplicate bucket (idempotency)
      const existing = await db
        .select({ id: buckets.id, status: buckets.status })
        .from(buckets)
        .where(
          and(
            eq(buckets.tenantId, tenantId),
            eq(buckets.name, bucketName),
            isNull(buckets.deletedAt),
          ),
        );

      if (existing.length > 0) {
        const bucket = existing[0];
        const message =
          bucket.status === 'provisioning'
            ? 'Bucket is being provisioned'
            : 'Bucket already exists';
        reply
          .code(409)
          .type('application/xml')
          .send(buildS3Error('BucketAlreadyExists', message, bucketName, requestId));
        return;
      }

      // ⑥⑦ Advisory lock + Postgres transaction
      const physicalName = `${tenantSlug}--${bucketName}`;
      const region = 'us-east-1';
      const accessPolicy = 'private';
      const billingPeriod = currentBillingPeriod();
      const idempotencyKey = `bucket_created:${tenantId}:${bucketName}`;
      let insertedBucketId: string;

      try {
        insertedBucketId = await db.transaction(async (tx) => {
          // ⑥ Acquire advisory lock to prevent race conditions
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId + bucketName}))`,
          );

          // ⑥a Re-check for duplicate inside the lock
          const recheck = await tx
            .select({ id: buckets.id, status: buckets.status })
            .from(buckets)
            .where(
              and(
                eq(buckets.tenantId, tenantId),
                eq(buckets.name, bucketName),
                isNull(buckets.deletedAt),
              ),
            );

          if (recheck.length > 0) {
            const bucket = recheck[0];
            const message =
              bucket.status === 'provisioning'
                ? 'Bucket is being provisioned'
                : 'Bucket already exists';
            throw new DuplicateBucketError(message);
          }

          // ⑦b INSERT bucket row with status = 'provisioning'
          const insertedBuckets = await tx
            .insert(buckets)
            .values({
              tenantId,
              name: bucketName,
              physicalName,
              status: 'provisioning',
              accessPolicy,
              region,
            })
            .returning({ id: buckets.id });

          const bucketId = insertedBuckets[0].id;

          // ⑦c INSERT usage_metrics row
          await tx
            .insert(usageMetrics)
            .values({
              tenantId,
              bucketId,
              eventType: 'bucket_created',
              bytes: BigInt(0),
              billingPeriod,
              idempotencyKey,
              metadata: JSON.stringify({ physicalName, region, accessPolicy }),
            })
            .onConflictDoNothing({ target: usageMetrics.idempotencyKey });

          return bucketId;
        });
      } catch (err) {
        if (err instanceof DuplicateBucketError) {
          reply
            .code(409)
            .type('application/xml')
            .send(buildS3Error('BucketAlreadyExists', err.message, bucketName, requestId));
          return;
        }
        request.log.error({ err, tenantId, bucketName }, 'Transaction failed during bucket creation');
        reply
          .code(500)
          .type('application/xml')
          .send(buildS3Error('InternalError', 'Failed to create bucket record', bucketName, requestId));
        return;
      }

      // ⑧ Provision physical bucket in MinIO (OUTSIDE transaction)
      try {
        await minioClient.makeBucket(physicalName, region);
      } catch (err) {
        request.log.error({ err, tenantId, bucketName, physicalName }, 'MinIO makeBucket failed');

        // Mark the bucket as failed — do not hard-delete
        try {
          await db
            .update(buckets)
            .set({ status: 'deleted', deletedAt: new Date() })
            .where(eq(buckets.id, insertedBucketId));
        } catch (cleanupErr) {
          request.log.error(
            { err: cleanupErr, bucketId: insertedBucketId },
            'Failed to mark bucket as deleted after MinIO failure',
          );
        }

        reply
          .code(500)
          .type('application/xml')
          .send(buildS3Error('InternalError', 'Failed to provision storage', bucketName, requestId));
        return;
      }

      // ⑨ Flip bucket status to 'active'
      try {
        await db
          .update(buckets)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(buckets.id, insertedBucketId));
      } catch (err) {
        request.log.error({ err, bucketId: insertedBucketId }, 'Failed to activate bucket');
        reply
          .code(500)
          .type('application/xml')
          .send(buildS3Error('InternalError', 'Bucket provisioned but activation failed', bucketName, requestId));
        return;
      }

      // ⑩ Update Redis counters
      try {
        await incrementBucketCount(tenantSlug, redis);
      } catch (err) {
        // Non-fatal — Redis is a hot cache, Postgres is source of truth.
        // Log and continue.
        request.log.error({ err, tenantSlug }, 'Failed to increment Redis bucket count');
      }

      // ⑪ Return success — S3 CreateBucket returns 200 with no body
      reply
        .code(200)
        .header('Location', `/${bucketName}`)
        .send('');
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Internal error class for duplicate bucket detection inside TX
// ─────────────────────────────────────────────────────────────

/**
 * Thrown inside the transaction when a duplicate bucket is found
 * after acquiring the advisory lock. Caught by the route handler
 * to produce an appropriate 409 response.
 */
class DuplicateBucketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateBucketError';
  }
}
