// src/lib/redis.ts

/**
 * Redis client module.
 *
 * Creates a singleton ioredis instance from the REDIS_URL env var.
 * Used for hot quota counters and tenant metadata caching.
 */

import { Redis } from 'ioredis';

/**
 * Singleton Redis client.
 * Reads REDIS_URL from the process environment — set before import.
 */
export const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
