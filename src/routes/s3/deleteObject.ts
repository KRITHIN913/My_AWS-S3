// src/routes/s3/deleteObject.ts

/**
 * S3 DeleteObject Route Plugin
 *
 * Handles `DELETE /:bucketName/*` — the S3-compatible DeleteObject operation.
 * Stats the object BEFORE deleting to capture freed bytes for billing.
 *
 * Execution sequence:
 *   ① Validate params (bucketName, objectKey)
 *   ② Load + validate bucket
 *   ③ Stat the object BEFORE deleting (capture size)
 *   ④ Delete from MinIO
 *   ⑤ Record deletion billing event
 *   ⑥ Return 204 with empty body
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { buckets } from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';
import type { Redis } from 'ioredis';
import type { Client as MinioClientType } from 'minio';
import { createAuthenticateHandler } from '../../plugins/authenticate.js';
import { recordDeletion } from '../../lib/meteringService.js';

// ─────────────────────────────────────────────────────────────
// S3 XML error helper
// ─────────────────────────────────────────────────────────────


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
// Validation helpers
// ─────────────────────────────────────────────────────────────


function validateObjectKey(key: string): string | null {
  if (key.length < 1) return 'Object key must be at least 1 character';
  if (key.length > 1024) return 'Object key must not exceed 1024 characters';
  if (key.startsWith('/')) return 'Object key must not start with a forward slash';
  if (key.includes('\x00')) return 'Object key must not contain null bytes';
  return null;
}


function validateBucketName(name: string): string | null {
  if (name.length < 3) return 'Bucket name must be at least 3 characters long';
  if (name.length > 63) return 'Bucket name must not exceed 63 characters';
  if (!/^[a-z0-9-]+$/.test(name)) return 'Bucket name can only contain lowercase letters, numbers, and hyphens';
  if (name.startsWith('-') || name.endsWith('-')) return 'Bucket name must not start or end with a hyphen';
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return 'Bucket name must not be formatted as an IP address';
  return null;
}


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

export interface DeleteObjectPluginOptions {
  db: DrizzleDb;
  redis: Redis;
  minioClient: MinioClientType;
}


export default async function deleteObjectRoute(
  fastify: FastifyInstance,
  opts: DeleteObjectPluginOptions,
): Promise<void> {
  const { db, redis, minioClient } = opts;
  const authenticate = createAuthenticateHandler(db);

  fastify.route({
    method: 'DELETE',
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

    handler: async (
      request: FastifyRequest, 
      reply: FastifyReply
    ): Promise<void> => {
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

      if (bucket.status === 'provisioning') {
        reply.code(409).type('application/xml').send(
          buildS3Error('BucketNotReady', 'Bucket is still being provisioned', `/${bucketName}`, requestId),
        );
        return;
      }

      // Note: suspended buckets ALLOW deletes (policy: let tenants free quota)

      // ③ Stat the object BEFORE deleting to capture freed bytes
      let freedBytes: bigint;
      try {
        const stat = await minioClient.statObject(bucket.physicalName, objectKey);
        freedBytes = BigInt(stat.size);
      } catch (err) {
        if (isNotFoundError(err)) {
          // S3 DeleteObject is idempotent — non-existent key returns 204
          reply.code(204).send('');
          return;
        }
        request.log.error({ err, tenantId, bucketName, objectKey }, 'MinIO statObject failed before delete');
        reply.code(500).type('application/xml').send(
          buildS3Error('InternalError', 'Failed to check object existence', `/${bucketName}/${objectKey}`, requestId),
        );
        return;
      }

      // ④ Delete from MinIO
      try {
        await minioClient.removeObject(bucket.physicalName, objectKey);
      } catch (err) {
        request.log.error({ err, tenantId, bucketName, objectKey }, 'MinIO removeObject failed');
        reply.code(500).type('application/xml').send(
          buildS3Error('InternalError', 'Failed to delete object', `/${bucketName}/${objectKey}`, requestId),
        );
        return;
      }

      // ⑤ Record deletion billing event
      try {
        await recordDeletion({
          tenantId,
          tenantSlug,
          bucketId: bucket.id,
          objectKey,
          freedBytes,
          idempotencyKey: `bucket_deleted:${tenantId}:${bucketName}:${objectKey}`,
        }, db, redis);
      } catch (err) {
        request.log.error({ err, tenantId, bucketName, objectKey }, 'Failed to record deletion billing event');
      }

      // ⑥ Return 204 — S3 DeleteObject always returns 204, no body
      reply.code(204).send('');
    },
  });
}
