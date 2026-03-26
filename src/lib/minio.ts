// src/lib/minio.ts

/**
 * MinIO S3-compatible client module.
 *
 * Creates a singleton minio.Client from environment variables.
 * Used by route handlers to provision and manage physical buckets.
 */

import * as Minio from 'minio';

/**
 * Singleton MinIO client.
 * Environment variables:
 *   MINIO_ENDPOINT  — hostname (default: 'localhost')
 *   MINIO_PORT      — port number (default: 9000)
 *   MINIO_USE_SSL   — 'true' | 'false' (default: false)
 *   MINIO_ACCESS_KEY — access key
 *   MINIO_SECRET_KEY — secret key
 */
export const minioClient = new Minio.Client({
  endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
  port: parseInt(process.env['MINIO_PORT'] ?? '9000', 10),
  useSSL: process.env['MINIO_USE_SSL'] === 'true',
  accessKey: process.env['MINIO_ACCESS_KEY'] ?? '',
  secretKey: process.env['MINIO_SECRET_KEY'] ?? '',
});
