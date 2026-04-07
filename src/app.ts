// src/app.ts
/**
 * Fastify Application Factory
 *
 * Wires all plugins and routes in dependency order.
 * Does NOT read process.env — all external resources arrive as opts.
 *
 * Registration order:
 *   0. CORS plugin (must be first — before any route)
 *   1. Request decorators (tenantId, tenantSlug, adminId, adminRole)
 *   1b. Auth routes (/auth/* — unauthenticated, must precede protected routes)
 *   2. S3 proxy routes  (PUT /:bucketName, PUT/:bucket/:key, GET/:bucket/:key, DELETE/:bucket/:key)
 *   3. Billing routes   (/billing/*)
 *   4. Portal routes    (/portal/*)
 *   5. Admin routes     (/admin/*)
 *   6. Background jobs  — started on 'ready' hook
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Client as MinioClient } from 'minio';
import type { DrizzleDb } from './db/index.js';

// ── Plugins ──────────────────────────────────────────────────
import corsPlugin                    from './plugins/cors.js';
import authenticatePlugin            from './plugins/authenticate.js';

// ── Auth Routes (unauthenticated) ────────────────────────────
import authPlugin                    from './routes/auth/login.js';

// ── S3 Routes ────────────────────────────────────────────────
import createBucketPlugin            from './routes/s3/createBucket.js';
import putObjectPlugin               from './routes/s3/putObject.js';
import getObjectPlugin               from './routes/s3/getObject.js';
import deleteObjectPlugin            from './routes/s3/deleteObject.js';

// ── Billing Routes ───────────────────────────────────────────
import billingInvoicesPlugin         from './routes/billing/invoices.js';

// ── Portal Routes ────────────────────────────────────────────
import portalPlugin                  from './routes/portal/index.js';

// ── Admin Routes ─────────────────────────────────────────────
import adminTenantsPlugin            from './routes/admin/tenants.js';
import adminPlansPlugin              from './routes/admin/plans.js';
import adminInvoicesPlugin           from './routes/admin/invoices.js';
import adminSystemPlugin             from './routes/admin/system.js';

// ── Background Jobs ──────────────────────────────────────────
import usageAggregatorPlugin         from './jobs/usageAggregator.js';
import quotaBreachWatcherPlugin      from './jobs/quotaBreachWatcher.js';
import storageSnapshotterPlugin      from './jobs/storageSnapshotter.js';
import webhookDispatcherPlugin       from './jobs/webhookDispatcher.js';

// ─────────────────────────────────────────────────────────────
// buildApp
// ─────────────────────────────────────────────────────────────

export interface AppOpts {
  db:          DrizzleDb;
  redis:       Redis;
  minioClient: MinioClient;
}

/**
 * Builds and returns a fully configured Fastify instance.
 * Call `.listen()` on the returned instance to start serving.
 *
 * @param opts - Drizzle DB, ioredis client, MinIO client
 */
export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  const { db, redis, minioClient } = opts;

  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
    // Generate unique request IDs so they propagate into S3 XML error bodies
    genReqId: () => crypto.randomUUID(),
  });

  // ── 0. CORS — must be registered BEFORE all routes ──────────
  await corsPlugin(fastify);

  // ── 0b. Content-type parsers (S3 compatibility) ──────────────
  // Fastify's built-in application/json parser rejects empty bodies.
  // S3 CreateBucket sends Content-Type: application/json but NO body.
  // We override the built-in JSON parser to handle empty bodies gracefully,
  // and add a wildcard parser for arbitrary media types (file uploads, etc).
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (!body || (body as string).trim() === '') {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  fastify.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // ── 1. Request decorators ───────────────────────────────────
  // authenticate plugin decorates tenantId, tenantSlug, and fastify.authenticate
  await fastify.register(authenticatePlugin, { db });

  // ── 1b. Auth Routes (unauthenticated — no Bearer key needed) ─
  await fastify.register(authPlugin, { prefix: '/auth', db });

  // ── 2. S3 Routes ────────────────────────────────────────────
  // Each route plugin receives the minimal dependencies it needs.
  await fastify.register(createBucketPlugin, { db, redis, minioClient });
  await fastify.register(putObjectPlugin,    { db, redis, minioClient });
  await fastify.register(getObjectPlugin,    { db, redis, minioClient });
  await fastify.register(deleteObjectPlugin, { db, redis, minioClient });

  // ── 3. Billing Routes ────────────────────────────────────────
  await fastify.register(billingInvoicesPlugin, { prefix: '/billing', db });

  // ── 4. Portal Routes ─────────────────────────────────────────
  await fastify.register(portalPlugin, { prefix: '/portal', db, redis, minioClient });

  // ── 5. Admin Routes ──────────────────────────────────────────
  await fastify.register(adminTenantsPlugin,  { prefix: '/admin/tenants',  db, redis });
  await fastify.register(adminPlansPlugin,    { prefix: '/admin/plans',    db });
  await fastify.register(adminInvoicesPlugin, { prefix: '/admin/invoices', db });
  await fastify.register(adminSystemPlugin,   { prefix: '/admin/system',   db, redis, minioClient });

  // ── 6. Background Jobs ───────────────────────────────────────
  // Registered last — jobs reference the ready Fastify logger.
  // They attach start/stop lifecycle hooks internally.
  await fastify.register(usageAggregatorPlugin,    { db, redis });
  await fastify.register(quotaBreachWatcherPlugin,  { db, redis });
  await fastify.register(storageSnapshotterPlugin,  { db, redis, minioClient });
  await fastify.register(webhookDispatcherPlugin,   { db });

  return fastify;
}
