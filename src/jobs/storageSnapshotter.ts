// src/jobs/storageSnapshotter.ts
/**
 * Hourly Storage Snapshotter Job
 * 
 * Iterates through active buckets and uses MinIO listObjects to compute true disk usage.
 * Updates physical bucket size records and recalibrates Redis counters.
 */
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Client } from 'minio';
import type { DrizzleDb } from '../db/index.js';
import { tenants, buckets, usageSnapshots } from '../drizzle/schema.js';

/**
 * Stream all objects in the bucket and sum their sizes.
 */
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
    stream.on('end',  () => resolve(total));
    stream.on('error', reject);
  });
}

/**
 * Fastify plugin for storage snapshotter.
 */
export default async function storageSnapshotterPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb; redis: Redis; minioClient: Client },
): Promise<void> {
  let timer: NodeJS.Timeout;

  fastify.ready(() => {
    // Run every hour
    timer = setInterval(async () => {
      try {
        fastify.log.info('Running storage snapshotter');
        const result = await runStorageSnapshot(opts.db, opts.redis, opts.minioClient);
        fastify.log.info(`Storage snapshotter complete: ${result.bucketsSnapped} snapped, ${result.bucketsErrored} errored`);
      } catch (err) {
        fastify.log.error(err, 'Storage snapshotter failed');
      }
    }, 60 * 60 * 1000);
  });

  fastify.addHook('onClose', (instance, done) => {
    clearInterval(timer);
    done();
  });
}

/**
 * Internal function exported for testing.
 */
export async function runStorageSnapshot(
  db: DrizzleDb,
  redis: Redis,
  minioClient: Client,
): Promise<{ bucketsSnapped: number; bucketsErrored: number }> {
  let bucketsSnapped = 0;
  let bucketsErrored = 0;

  // Active buckets: status = 'active' and deleted_at IS NULL
  const activeBuckets = await db.execute<{
    id: string;
    tenant_id: string;
    physical_name: string;
    tenant_slug: string;
  }>(sql`
    SELECT b.id, b.tenant_id, b.physical_name, t.slug as tenant_slug
    FROM buckets b
    JOIN tenants t ON b.tenant_id = t.id
    WHERE b.status = 'active' 
      AND b.deleted_at IS NULL
  `);

  const processedTenants = new Set<string>();

  for (const bucket of activeBuckets) {
    try {
      // 1. Get true size from MinIO
      const bytes = await getBucketSizeBytes(minioClient, bucket.physical_name);

      // 2. Insert into usage_snapshots
      await db.execute(sql`
        INSERT INTO usage_snapshots (tenant_id, bucket_id, bytes_stored)
        VALUES (${bucket.tenant_id}, ${bucket.id}, ${bytes})
      `);

      // 3. Update buckets table last_known_size_bytes
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
      console.error(`Error snapshotting bucket ${bucket.physical_name}:`, err);
      bucketsErrored++;
    }
  }

  // 4. Recalibrate Redis storage_bytes for each affected tenant
  for (const tenantSlug of processedTenants) {
    try {
      const sumResult = await db.execute<{ sum: string | null }>(sql`
        SELECT SUM(b.last_known_size_bytes)::bigint as sum
        FROM buckets b
        JOIN tenants t ON b.tenant_id = t.id
        WHERE t.slug = ${tenantSlug} 
          AND b.deleted_at IS NULL
      `);
      
      const total = sumResult[0]?.sum || '0';
      
      // Use SET not INCRBY — recalibration from ground truth
      await redis.set(`quota:${tenantSlug}:storage_bytes`, total);
    } catch (err) {
      console.error(`Error recalibrating Redis storage for tenant slug ${tenantSlug}:`, err);
    }
  }

  return { bucketsSnapped, bucketsErrored };
}
