// src/jobs/storageSnapshotter.ts

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Client } from 'minio';
import type { DrizzleDb } from '../db/index.js';
import { buckets, usageSnapshots } from '../drizzle/schema.js';

/** Interval between snapshot runs (1 hour). */
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;


async function getBucketSizeBytes(
  minioClient: Client,
  physicalName: string,
): Promise<bigint> {
  return new Promise((resolve, reject) => {
    let total = BigInt(0);
    const stream = minioClient.listObjects(physicalName, '', true);
    stream.on('data', (obj) => {
      total += BigInt(obj.size ?? 0);
    });
    stream.on('end', () => resolve(total));
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────

/**
 * Fastify plugin that runs the hourly storage snapshotter.
 * Timer starts on `fastify.ready` and is cleared on `fastify.close`.
 *
 * @param fastify - Fastify instance
 * @param opts    - Must include Drizzle DB, ioredis client, and MinIO client
 */
export default async function storageSnapshotterPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis; minioClient: Client },
): Promise<void> {
  let timer: NodeJS.Timeout;

  fastify.ready(() => {
    timer = setInterval(async () => {
      try {
        fastify.log.info('Running storage snapshotter');
        const result = await runStorageSnapshot(
          opts.db,
          opts.redis,
          opts.minioClient,
        );
        fastify.log.info(
          `Storage snapshotter complete: ${result.bucketsSnapped} snapped, ${result.bucketsErrored} errored`,
        );
        // Record last successful run for /admin/system/health
        await opts.redis.set('jobs:lastRun:snapshotter', new Date().toISOString());
      } catch (err) {
        fastify.log.error(err, 'Storage snapshotter failed');
      }
    }, SNAPSHOT_INTERVAL_MS);
  });

  fastify.addHook('onClose', (_instance, done) => {
    clearInterval(timer);
    done();
  });
}

// ─────────────────────────────────────────────────────────────
// Core snapshot logic — exported for testing
// ─────────────────────────────────────────────────────────────



export async function runStorageSnapshot(
  db: DrizzleDb,
  redis: Redis,
  minioClient: Client,
): Promise<{ bucketsSnapped: number; bucketsErrored: number }> {
  let bucketsSnapped = 0;
  let bucketsErrored = 0;

  // Load all active buckets with their tenant slugs in a single query
  const activeBuckets = await db.execute<{
    id: string;
    tenant_id: string;
    physical_name: string;
    tenant_slug: string;
  }>(sql`
    SELECT b.id, b.tenant_id, b.physical_name, t.slug AS tenant_slug
    FROM buckets b
    JOIN tenants t ON b.tenant_id = t.id
    WHERE b.status = 'active'
      AND b.deleted_at IS NULL
  `);

  // Track which tenants were touched so we can recalibrate Redis
  const processedTenants = new Set<string>();

  for (const bucket of activeBuckets.rows) {
    try {
      // 1. Get true size from MinIO
      const bytes = await getBucketSizeBytes(minioClient, bucket.physical_name);

      // 2. Insert snapshot row
      await db.execute(sql`
        INSERT INTO usage_snapshots (tenant_id, bucket_id, bytes_stored)
        VALUES (${bucket.tenant_id}, ${bucket.id}, ${bytes})
      `);

      // 3. Update bucket record
      await db.execute(sql`
        UPDATE buckets
        SET
          last_known_size_bytes = ${bytes},
          last_size_snapshot_at = NOW(),
          updated_at = NOW()
        WHERE id = ${bucket.id}
      `);

      bucketsSnapped++;
      processedTenants.add(bucket.tenant_slug);
    } catch (err) {
      console.error(
        `Error snapshotting bucket ${bucket.physical_name}:`,
        err,
      );
      bucketsErrored++;
    }
  }

  // 4. Recalibrate Redis storage counters from ground truth
  for (const tenantSlug of processedTenants) {
    try {
      const sumResult = await db.execute<{ total: string | null }>(sql`
        SELECT COALESCE(SUM(b.last_known_size_bytes), 0)::bigint AS total
        FROM buckets b
        JOIN tenants t ON b.tenant_id = t.id
        WHERE t.slug = ${tenantSlug}
          AND b.deleted_at IS NULL
      `);

      const total = sumResult.rows[0]?.total || '0';

      // Use SET, not INCRBY — this is a recalibration from ground truth
      await redis.set(`quota:${tenantSlug}:storage_bytes`, total);
    } catch (err) {
      console.error(
        `Error recalibrating Redis storage for tenant slug ${tenantSlug}:`,
        err,
      );
    }
  }

  return { bucketsSnapped, bucketsErrored };
}
