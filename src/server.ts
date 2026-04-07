// src/server.ts
/**
 * Server entry-point
 *
 * Reads infrastructure configuration from environment variables,
 * creates the external clients (Postgres pool, ioredis, MinIO),
 * calls buildApp(), then starts listening.
 *
 * Handles SIGTERM gracefully: closes the Fastify instance (which
 * calls all onClose hooks and stops background jobs) before exiting.
 */

import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import * as Minio from 'minio';
import * as schema from './drizzle/schema.js';
import { buildApp } from './app.js';

const { Pool } = pg;

// ─────────────────────────────────────────────────────────────
// Required environment variables
// ─────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const databaseUrl   = requireEnv('DATABASE_URL');
  const redisUrl      = requireEnv('REDIS_URL');
  const minioEndpoint = process.env['MINIO_ENDPOINT'] ?? 'localhost';
  const minioPort     = parseInt(process.env['MINIO_PORT'] ?? '9000', 10);
  const minioUseSSL   = process.env['MINIO_USE_SSL'] === 'true';
  const minioUser     = requireEnv('MINIO_ROOT_USER');
  const minioPass     = requireEnv('MINIO_ROOT_PASSWORD');
  const port          = parseInt(process.env['PORT'] ?? '3000', 10);

  // ── Postgres pool ─────────────────────────────────────────
  const pool = new Pool({ connectionString: databaseUrl });
  const db   = drizzle(pool, { schema });

  // ── Redis ─────────────────────────────────────────────────
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  redis.on('error', (err: unknown) => {
    console.error('[Redis] connection error:', err);
  });

  // ── MinIO ─────────────────────────────────────────────────
  const minioClient = new Minio.Client({
    endPoint:  minioEndpoint,
    port:      minioPort,
    useSSL:    minioUseSSL,
    accessKey: minioUser,
    secretKey: minioPass,
  });

  // ── Build Fastify app ─────────────────────────────────────
  const app = await buildApp({ db, redis, minioClient });

  // ── Graceful shutdown ─────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal} — shutting down gracefully`);
    try {
      await app.close();         // triggers onClose hooks, stops jobs
      await redis.quit();
      await pool.end();
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT',  () => shutdown('SIGINT'));

  // ── Start listening ───────────────────────────────────────
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
