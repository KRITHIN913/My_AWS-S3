// src/plugins/rateLimiter.ts
/**
 * Redis Sliding Window Rate Limiter
 *
 * Implements a pure-Lua atomic sliding window using a Redis sorted set.
 * No external packages — all logic is in the Lua script executed via
 * redis.eval(), which is atomic (single-threaded Redis execution).
 *
 * Redis key: ratelimit:{tenantSlug}:{route}
 * Structure:  Sorted set, score = timestamp in ms, member = unique request UUID
 */

import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

// ─────────────────────────────────────────────────────────────
// Lua script
// Atomically:
//   1. Remove members older than (now - windowMs)
//   2. Count remaining members
//   3. If count < limit: add new member + reset TTL, return 1 (allowed)
//   4. Else: return 0 (denied)
// ─────────────────────────────────────────────────────────────

const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local id     = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, id)
  redis.call('EXPIRE', key, math.ceil(window / 1000))
  return 1
end
return 0
`;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Sliding window size in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed within the window. */
  maxRequests: number;
}

// ─────────────────────────────────────────────────────────────
// Default limits (keyed by route name)
// ─────────────────────────────────────────────────────────────

/**
 * Default per-tenant sliding-window rate limit configuration per route.
 * Keys must match what callers pass as the `route` argument.
 */
export const RATE_LIMIT_DEFAULTS: Record<string, RateLimitConfig> = {
  create_bucket:  { windowMs: 60_000, maxRequests: 10  },
  put_object:     { windowMs: 60_000, maxRequests: 300 },
  get_object:     { windowMs: 60_000, maxRequests: 600 },
  delete_object:  { windowMs: 60_000, maxRequests: 100 },
  portal_write:   { windowMs: 60_000, maxRequests: 30  },
};

// ─────────────────────────────────────────────────────────────
// Core function
// ─────────────────────────────────────────────────────────────

/**
 * Checks whether a request from `tenantSlug` on `route` is within limits.
 *
 * Executes a single atomic Lua script — no TOCTOU race conditions.
 *
 * @param redis      - ioredis client
 * @param tenantSlug - Tenant slug (used in the Redis key)
 * @param route      - Route name, e.g. 'put_object', 'get_object'
 * @param limits     - Window size and max request count
 * @returns { allowed: boolean, retryAfterMs: number }
 *          retryAfterMs is the full window duration when denied (conservative estimate).
 */
export async function checkRateLimit(
  redis: Redis,
  tenantSlug: string,
  route: string,
  limits: RateLimitConfig,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const key    = `ratelimit:${tenantSlug}:${route}`;
  const now    = Date.now();
  const id     = randomUUID();

  const result = await redis.eval(
    SLIDING_WINDOW_LUA,
    1,           // number of KEYS
    key,         // KEYS[1]
    String(now),            // ARGV[1] — current timestamp ms
    String(limits.windowMs), // ARGV[2] — window size ms
    String(limits.maxRequests), // ARGV[3] — max count
    id,          // ARGV[4] — unique member
  ) as number;

  const allowed = result === 1;
  return {
    allowed,
    // When denied, the oldest entry plus one window gives the safe retry time.
    // We return the full window as a conservative upper bound.
    retryAfterMs: allowed ? 0 : limits.windowMs,
  };
}
