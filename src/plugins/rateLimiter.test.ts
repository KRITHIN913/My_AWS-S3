// src/plugins/rateLimiter.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import { checkRateLimit, RATE_LIMIT_DEFAULTS, type RateLimitConfig } from './rateLimiter.js';

let redis: Redis;

const TEST_CONFIG: RateLimitConfig = { windowMs: 5_000, maxRequests: 3 };

/** Generate a unique tenant slug for each test to avoid key collisions. */
function uniqueSlug(): string {
  return `rl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  // Wait for connection
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  // Keys are unique per test so no cleanup needed, but flush if running in
  // a shared environment to be safe.
});

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('checkRateLimit — basic behaviour', () => {
  it('allows requests under the limit', async () => {
    const slug = uniqueSlug();

    for (let i = 0; i < TEST_CONFIG.maxRequests; i++) {
      const result = await checkRateLimit(redis, slug, 'test_route', TEST_CONFIG);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
    }
  });

  it('blocks the (limit+1)th request in the same window', async () => {
    const slug = uniqueSlug();

    // Exhaust the limit
    for (let i = 0; i < TEST_CONFIG.maxRequests; i++) {
      await checkRateLimit(redis, slug, 'test_route', TEST_CONFIG);
    }

    // One more should be denied
    const denied = await checkRateLimit(redis, slug, 'test_route', TEST_CONFIG);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows requests again after the window expires', async () => {
    // Use a very short window (500ms) for this test
    const shortConfig: RateLimitConfig = { windowMs: 500, maxRequests: 1 };
    const slug = uniqueSlug();

    // Exhaust limit
    const first = await checkRateLimit(redis, slug, 'test_route', shortConfig);
    expect(first.allowed).toBe(true);

    const denied = await checkRateLimit(redis, slug, 'test_route', shortConfig);
    expect(denied.allowed).toBe(false);

    // Wait for the window to expire
    await new Promise(r => setTimeout(r, 600));

    // Should be allowed again
    const allowed = await checkRateLimit(redis, slug, 'test_route', shortConfig);
    expect(allowed.allowed).toBe(true);
  }, 10_000);

  it('returns correct retryAfterMs equal to windowMs when blocked', async () => {
    const slug = uniqueSlug();

    for (let i = 0; i < TEST_CONFIG.maxRequests; i++) {
      await checkRateLimit(redis, slug, 'test_route', TEST_CONFIG);
    }

    const denied = await checkRateLimit(redis, slug, 'test_route', TEST_CONFIG);
    expect(denied.retryAfterMs).toBe(TEST_CONFIG.windowMs);
  });
});

describe('checkRateLimit — isolation', () => {
  it('different tenants have independent counters', async () => {
    const slug1 = uniqueSlug();
    const slug2 = uniqueSlug();

    // Exhaust slug1
    for (let i = 0; i < TEST_CONFIG.maxRequests; i++) {
      await checkRateLimit(redis, slug1, 'test_route', TEST_CONFIG);
    }
    const slug1Denied = await checkRateLimit(redis, slug1, 'test_route', TEST_CONFIG);
    expect(slug1Denied.allowed).toBe(false);

    // slug2 should be unaffected
    const slug2Allowed = await checkRateLimit(redis, slug2, 'test_route', TEST_CONFIG);
    expect(slug2Allowed.allowed).toBe(true);
  });

  it('different routes have independent counters for the same tenant', async () => {
    const slug = uniqueSlug();

    // Exhaust 'route_a'
    for (let i = 0; i < TEST_CONFIG.maxRequests; i++) {
      await checkRateLimit(redis, slug, 'route_a', TEST_CONFIG);
    }
    const routeADenied = await checkRateLimit(redis, slug, 'route_a', TEST_CONFIG);
    expect(routeADenied.allowed).toBe(false);

    // 'route_b' should be unaffected
    const routeBAllowed = await checkRateLimit(redis, slug, 'route_b', TEST_CONFIG);
    expect(routeBAllowed.allowed).toBe(true);
  });
});

describe('checkRateLimit — atomicity', () => {
  it('concurrent calls do not exceed the limit', async () => {
    const slug       = uniqueSlug();
    const limit      = 5;
    const concurrent = 20;
    const cfg: RateLimitConfig = { windowMs: 10_000, maxRequests: limit };

    // Fire all requests simultaneously
    const results = await Promise.all(
      Array.from({ length: concurrent }, () =>
        checkRateLimit(redis, slug, 'concurrent_route', cfg),
      ),
    );

    const allowed = results.filter(r => r.allowed).length;
    const denied  = results.filter(r => !r.allowed).length;

    // Exactly `limit` requests should be allowed — no more, no less
    expect(allowed).toBe(limit);
    expect(denied).toBe(concurrent - limit);
  });
});

describe('RATE_LIMIT_DEFAULTS', () => {
  it('exports all expected route defaults', () => {
    const expectedRoutes = [
      'create_bucket',
      'put_object',
      'get_object',
      'delete_object',
      'portal_write',
    ];
    for (const route of expectedRoutes) {
      expect(RATE_LIMIT_DEFAULTS).toHaveProperty(route);
      expect(RATE_LIMIT_DEFAULTS[route]!.windowMs).toBeGreaterThan(0);
      expect(RATE_LIMIT_DEFAULTS[route]!.maxRequests).toBeGreaterThan(0);
    }
  });

  it('create_bucket has stricter limit than put_object', () => {
    expect(RATE_LIMIT_DEFAULTS['create_bucket']!.maxRequests)
      .toBeLessThan(RATE_LIMIT_DEFAULTS['put_object']!.maxRequests);
  });
});
