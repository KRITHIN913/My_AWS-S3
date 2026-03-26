// src/routes/s3/putObject.ts

/**
 * S3 PutObject Route Plugin
 *
 * Handles `PUT /:bucketName/*` — the S3-compatible PutObject operation.
 * Streams the request body directly to MinIO via ByteCounterTransform.
 * Never buffers the full object in memory.
 *
 * Execution sequence:
 *   ① Parse + validate (bucketName, objectKey, headers)
 *   ② Load bucket record
 *   ③ Quota check — storage bytes
 *   ④ Quota check — monthly ingress bytes
 *   ⑤ Stream upload to MinIO
 *   ⑥ Record billing event
 *   ⑦ Return 200 with ETag
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { buckets } from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';
import type { Redis } from 'ioredis';
import type { Client as MinioClientType } from 'minio';
import { authenticate } from '../../plugins/authenticate.js';
import { streamPutToMinio } from '../../lib/s3ProxyStream.js';
import {
  checkStorageQuota,
  checkIngressQuota,
  recordIngress,
} from '../../lib/meteringService.js';

// ─────────────────────────────────────────────────────────────
// S3 XML error helper
// ─────────────────────────────────────────────────────────────

/**
 * Builds an S3-compatible XML error response body.
 *
 * @param code      - S3 error code (e.g. 'NoSuchBucket', 'QuotaExceeded').
 * @param message   - Human-readable error message.
 * @param resource  - The resource that caused the error.
 * @param requestId - Unique request ID for traceability.
 * @returns XML error string.
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
// Validation
// ─────────────────────────────────────────────────────────────

/**
 * Validates an S3 object key.
 *
 * Rules:
 *   - 1 to 1024 characters
 *   - No leading slash
 *   - No null bytes
 *
 * @param key - The candidate object key.
 * @returns null if valid, or a string describing the validation error.
 */
function validateObjectKey(key: string): string | null {
  if (key.length < 1) {
    return 'Object key must be at least 1 character';
  }
  if (key.length > 1024) {
    return 'Object key must not exceed 1024 characters';
  }
  if (key.startsWith('/')) {
    return 'Object key must not start with a forward slash';
  }
  if (key.includes('\x00')) {
    return 'Object key must not contain null bytes';
  }
  return null;
}

/**
 * Validates a bucket name using S3 naming rules.
 *
 * @param name - The candidate bucket name.
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
// Route plugin
// ─────────────────────────────────────────────────────────────

/**
 * Fastify plugin that registers the `PUT /:bucketName/*` route for PutObject.
 *
 * Uses wildcard param to capture objectKey with slashes (e.g. photos/2025/img.jpg).
 *
 * @param fastify - Fastify instance.
 * @param opts    - Injected dependencies.
 */
export default async function putObjectRoute(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis; minioClient: MinioClientType },
): Promise<void> {
  const { db, redis, minioClient } = opts;

  fastify.route({
    method: 'PUT',
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

      // Read headers
      const contentLengthHeader = request.headers['content-length'];
      const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : -1;
      const contentType = (request.headers['content-type'] as string) ?? 'application/octet-stream';

      // ② Load bucket record
      const bucketRows = await db
        .select({
          id: buckets.id,
          tenantId: buckets.tenantId,
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

      // ③ Quota check — storage bytes (only if Content-Length is known)
      if (contentLength >= 0) {
        try {
          const storageCheck = await checkStorageQuota(
            tenantId, tenantSlug, BigInt(contentLength), db, redis,
          );
          if (!storageCheck.allowed) {
            reply.code(403).type('application/xml').send(
              buildS3Error('QuotaExceeded', 'Storage quota exceeded', `/${bucketName}/${objectKey}`, requestId),
            );
            return;
          }
        } catch (err) {
          request.log.error({ err, tenantId, bucketName }, 'Storage quota check failed');
          reply.code(500).type('application/xml').send(
            buildS3Error('InternalError', 'Quota check failed', `/${bucketName}/${objectKey}`, requestId),
          );
          return;
        }
      }

      // ④ Quota check — monthly ingress bytes (only if Content-Length is known)
      if (contentLength >= 0) {
        try {
          const ingressCheck = await checkIngressQuota(
            tenantId, tenantSlug, BigInt(contentLength), db, redis,
          );
          if (!ingressCheck.allowed) {
            reply.code(403).type('application/xml').send(
              buildS3Error('QuotaExceeded', 'Ingress quota exceeded', `/${bucketName}/${objectKey}`, requestId),
            );
            return;
          }
        } catch (err) {
          request.log.error({ err, tenantId, bucketName }, 'Ingress quota check failed');
          reply.code(500).type('application/xml').send(
            buildS3Error('InternalError', 'Quota check failed', `/${bucketName}/${objectKey}`, requestId),
          );
          return;
        }
      }

      // ⑤ Stream the upload to MinIO
      let bytesUploaded: bigint;
      try {
        bytesUploaded = await streamPutToMinio(
          minioClient,
          bucket.physicalName,
          objectKey,
          request.raw,
          contentLength,
          contentType,
        );
      } catch (err) {
        request.log.error({ err, tenantId, bucketName, objectKey }, 'MinIO putObject failed');
        if (!reply.sent) {
          reply.code(500).type('application/xml').send(
            buildS3Error('InternalError', 'Failed to store object', `/${bucketName}/${objectKey}`, requestId),
          );
        }
        return;
      }

      // ⑥ Record billing event (after successful MinIO upload)
      try {
        await recordIngress({
          tenantId,
          tenantSlug,
          bucketId: bucket.id,
          bucketName,
          objectKey,
          bytes: bytesUploaded,
          metadata: { contentType, contentLength, physicalName: bucket.physicalName },
          idempotencyKey: `data_in:${tenantId}:${bucketName}:${objectKey}:${Date.now()}`,
        }, db, redis);
      } catch (err) {
        // Billing failure is logged but not returned to client — the upload succeeded.
        request.log.error({ err, tenantId, bucketName, objectKey }, 'Failed to record ingress billing event');
      }

      // ⑦ Return success
      reply
        .code(200)
        .header('ETag', `"${requestId}"`)
        .header('x-amz-request-id', requestId)
        .type('application/xml')
        .send('');
    },
  });
}
