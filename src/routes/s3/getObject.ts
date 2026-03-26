// src/routes/s3/getObject.ts

/**
 * S3 GetObject Route Plugin
 *
 * Handles `GET /:bucketName/*` — the S3-compatible GetObject operation.
 * Streams the object from MinIO directly to the client via
 * ByteCounterTransform. Never buffers the full object in memory.
 *
 * Execution sequence:
 *   ① Validate params (bucketName, objectKey)
 *   ② Load + validate bucket
 *   ③ Quota check — monthly egress (stat object first to get size)
 *   ④ Stream object from MinIO to client
 *   ⑤ Record egress billing event
 *   ⑥ Return (headers already set by streamGetFromMinio)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { buckets } from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';
import type { Redis } from 'ioredis';
import type { Client as MinioClientType } from 'minio';
import { authenticate } from '../../plugins/authenticate.js';
import { streamGetFromMinio } from '../../lib/s3ProxyStream.js';
import { checkEgressQuota, recordEgress } from '../../lib/meteringService.js';

// ─────────────────────────────────────────────────────────────
// S3 XML error helper
// ─────────────────────────────────────────────────────────────

/**
 * Builds an S3-compatible XML error response body.
 */
function buildS3Error(
  code: string,
  message: string,
  resource: string,
  requestId: string,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Error>',
    `<Code>${code}</Code>`,
    `<Message>${message}</Message>`,
    `<Resource>${resource}</Resource>`,
    `<RequestId>${requestId}</RequestId>`,
    '</Error>',
  ].join('');
}

// ─────────────────────────────────────────────────────────────
// Validation helpers (shared with putObject)
// ─────────────────────────────────────────────────────────────

/**
 * Validates an S3 object key.
 * @returns null if valid, or a validation error string.
 */
function validateObjectKey(key: string): string | null {
  if (key.length < 1) return 'Object key must be at least 1 character';
  if (key.length > 1024) return 'Object key must not exceed 1024 characters';
  if (key.startsWith('/')) return 'Object key must not start with a forward slash';
  if (key.includes('\x00')) return 'Object key must not contain null bytes';
  return null;
}

/**
 * Validates a bucket name using S3 naming rules.
 * @returns null if valid, or a validation error string.
 */
function validateBucketName(name: string): string | null {
  if (name.length < 3) return 'Bucket name must be at least 3 characters long';
  if (name.length > 63) return 'Bucket name must not exceed 63 characters';
  if (!/^[a-z0-9-]+$/.test(name)) return 'Bucket name can only contain lowercase letters, numbers, and hyphens';
  if (name.startsWith('-') || name.endsWith('-')) return 'Bucket name must not start or end with a hyphen';
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return 'Bucket name must not be formatted as an IP address';
  return null;
}

// ─────────────────────────────────────────────────────────────
// MinIO error classifier
// ─────────────────────────────────────────────────────────────

/**
 * Determines if a MinIO error is a NotFound-class error.
 * MinIO throws errors with a `code` property of 'NotFound' or
 * 'NoSuchKey' when the object does not exist.
 */
function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    return code === 'NotFound' || code === 'NoSuchKey';
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Route plugin
// ─────────────────────────────────────────────────────────────

/**
 * Fastify plugin that registers `GET /:bucketName/*` for GetObject.
 *
 * @param fastify - Fastify instance.
 * @param opts    - Injected dependencies.
 */
export default async function getObjectRoute(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis; minioClient: MinioClientType },
): Promise<void> {
  const { db, redis, minioClient } = opts;

  fastify.route({
    method: 'GET',
    url: '/:bucketName/*',
    preHandler: [authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          bucketName: { type: 'string' },
          '*': { type: 'string' },
        },
        required: ['bucketName', '*'],
      },
    },

    handler: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const requestId = randomUUID();
      const params = request.params as { bucketName: string; '*': string };
      const bucketName = params.bucketName;
      const objectKey = params['*'];
      const tenantId = request.tenantId;
      const tenantSlug = request.tenantSlug;

      reply.header('x-amz-request-id', requestId);

      // ① Validate bucket name
      const bucketError = validateBucketName(bucketName);
      if (bucketError) {
        reply.code(400).type('application/xml').send(
          buildS3Error('InvalidBucketName', bucketError, `/${bucketName}`, requestId),
        );
        return;
      }

      // ① Validate object key
      const keyError = validateObjectKey(objectKey);
      if (keyError) {
        reply.code(400).type('application/xml').send(
          buildS3Error('InvalidArgument', keyError, `/${bucketName}/${objectKey}`, requestId),
        );
        return;
      }

      // ② Load + validate bucket
      const bucketRows = await db
        .select({
          id: buckets.id,
          physicalName: buckets.physicalName,
          status: buckets.status,
        })
        .from(buckets)
        .where(
          and(
            eq(buckets.tenantId, tenantId),
            eq(buckets.name, bucketName),
            isNull(buckets.deletedAt),
          ),
        );

      if (bucketRows.length === 0) {
        reply.code(404).type('application/xml').send(
          buildS3Error('NoSuchBucket', 'The specified bucket does not exist', `/${bucketName}`, requestId),
        );
        return;
      }

      const bucket = bucketRows[0];

      if (bucket.status === 'deleted') {
        reply.code(404).type('application/xml').send(
          buildS3Error('NoSuchBucket', 'The specified bucket does not exist', `/${bucketName}`, requestId),
        );
        return;
      }

      if (bucket.status === 'suspended') {
        reply.code(403).type('application/xml').send(
          buildS3Error('BucketSuspended', 'Bucket is suspended', `/${bucketName}`, requestId),
        );
        return;
      }

      if (bucket.status === 'provisioning') {
        reply.code(409).type('application/xml').send(
          buildS3Error('BucketNotReady', 'Bucket is still being provisioned', `/${bucketName}`, requestId),
        );
        return;
      }

      // ③ Stat the object to get its size for egress quota check
      let objectSize: bigint;
      try {
        const stat = await minioClient.statObject(bucket.physicalName, objectKey);
        objectSize = BigInt(stat.size);
      } catch (err) {
        if (isNotFoundError(err)) {
          reply.code(404).type('application/xml').send(
            buildS3Error('NoSuchKey', 'The specified key does not exist', `/${bucketName}/${objectKey}`, requestId),
          );
          return;
        }
        request.log.error({ err, tenantId, bucketName, objectKey }, 'MinIO statObject failed');
        reply.code(500).type('application/xml').send(
          buildS3Error('InternalError', 'Failed to retrieve object metadata', `/${bucketName}/${objectKey}`, requestId),
        );
        return;
      }

      // ③ Check egress quota
      try {
        const egressCheck = await checkEgressQuota(tenantId, tenantSlug, objectSize, db, redis);
        if (!egressCheck.allowed) {
          reply.code(403).type('application/xml').send(
            buildS3Error('QuotaExceeded', 'Egress quota exceeded', `/${bucketName}/${objectKey}`, requestId),
          );
          return;
        }
      } catch (err) {
        request.log.error({ err, tenantId, bucketName }, 'Egress quota check failed');
        reply.code(500).type('application/xml').send(
          buildS3Error('InternalError', 'Quota check failed', `/${bucketName}/${objectKey}`, requestId),
        );
        return;
      }

      // ④ Stream object from MinIO to client
      let bytesDownloaded: bigint;
      try {
        bytesDownloaded = await streamGetFromMinio(
          minioClient,
          bucket.physicalName,
          objectKey,
          reply,
          requestId,
        );
      } catch (err) {
        if (isNotFoundError(err)) {
          if (!reply.sent) {
            reply.code(404).type('application/xml').send(
              buildS3Error('NoSuchKey', 'The specified key does not exist', `/${bucketName}/${objectKey}`, requestId),
            );
          }
          return;
        }
        request.log.error({ err, tenantId, bucketName, objectKey }, 'MinIO getObject stream failed');
        if (!reply.sent) {
          reply.code(500).type('application/xml').send(
            buildS3Error('InternalError', 'Failed to retrieve object', `/${bucketName}/${objectKey}`, requestId),
          );
        }
        return;
      }

      // ⑤ Record egress billing event
      try {
        await recordEgress({
          tenantId,
          tenantSlug,
          bucketId: bucket.id,
          bucketName,
          objectKey,
          bytes: bytesDownloaded,
          metadata: { physicalName: bucket.physicalName },
          idempotencyKey: `data_out:${tenantId}:${bucketName}:${objectKey}:${Date.now()}`,
        }, db, redis);
      } catch (err) {
        request.log.error({ err, tenantId, bucketName, objectKey }, 'Failed to record egress billing event');
      }

      // ⑥ Response already sent by streamGetFromMinio via reply.raw
    },
  });
}
