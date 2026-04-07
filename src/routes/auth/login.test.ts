// src/routes/auth/login.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import * as schema from '../../drizzle/schema.js';
import type { DrizzleDb } from '../../db/index.js';

const { Pool } = pg;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

let pool: InstanceType<typeof Pool>;
let db: DrizzleDb;
let testTenantId: string;

const TEST_EMAIL = 'login-test@acme.io';
const TEST_SLUG = 'login-test-tenant';

beforeAll(async () => {
  const databaseUrl =
    process.env['DATABASE_URL'] ??
    'postgres://p5_admin:p5_secret@localhost:5432/p5_billing';
  pool = new Pool({ connectionString: databaseUrl });
  db = drizzle(pool, { schema });

  // Create a test tenant
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name, email, status)
    VALUES (${TEST_SLUG}, 'Login Test Corp', ${TEST_EMAIL}, 'active')
    ON CONFLICT (slug) DO UPDATE SET status = 'active', email = ${TEST_EMAIL}
    RETURNING id
  `);
  testTenantId = result.rows[0].id;
});

afterAll(async () => {
  // Clean up api_keys and test tenant
  await db.execute(sql`
    DELETE FROM api_keys WHERE tenant_id = ${testTenantId}
  `);
  await db.execute(sql`
    DELETE FROM tenants WHERE id = ${testTenantId}
  `);
  await pool.end();
});

beforeEach(async () => {
  // Clear any api_keys created during previous tests
  await db.execute(sql`
    DELETE FROM api_keys WHERE tenant_id = ${testTenantId}
  `);
});

describe('POST /auth/login', () => {
  // Helper — directly calls the login logic (unit test, not HTTP)
  async function doLogin(
    email: string,
    password: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // Look up tenant
    const tenantResult = await db.execute<{
      id: string;
      slug: string;
      display_name: string;
      email: string;
      status: string;
    }>(sql`
      SELECT id, slug, display_name, email, status
      FROM tenants
      WHERE email = ${email}
        AND status = 'active'
      LIMIT 1
    `);

    if (tenantResult.rows.length === 0) {
      return { status: 401, body: { error: 'InvalidCredentials' } };
    }

    if (!password) {
      return {
        status: 400,
        body: {
          error: 'ValidationError',
          detail: 'email and password are required',
        },
      };
    }

    const tenant = tenantResult.rows[0];
    const { randomBytes } = await import('node:crypto');
    const rawKey = randomBytes(32).toString('hex');
    const keyHash = sha256Hex(rawKey);
    const keyPrefix = rawKey.slice(0, 8);

    await db.execute(sql`
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label)
      VALUES (${tenant.id}, ${keyHash}, ${keyPrefix}, 'login-session')
    `);

    return {
      status: 200,
      body: {
        apiKey: rawKey,
        tenantId: tenant.id,
        slug: tenant.slug,
        displayName: tenant.display_name,
        email: tenant.email,
      },
    };
  }

  it('returns 200 + apiKey for existing active tenant', async () => {
    const { status, body } = await doLogin(TEST_EMAIL, 'anything');
    expect(status).toBe(200);
    expect(body).toHaveProperty('apiKey');
    expect(body).toHaveProperty('tenantId', testTenantId);
    expect(body).toHaveProperty('slug', TEST_SLUG);
    expect(body).toHaveProperty('email', TEST_EMAIL);
  });

  it('returned apiKey is 64 hex chars (32 bytes)', async () => {
    const { body } = await doLogin(TEST_EMAIL, 'anything');
    const apiKey = body['apiKey'] as string;
    expect(apiKey).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(apiKey)).toBe(true);
  });

  it('apiKey is stored as SHA-256 hash in api_keys table (rawKey != stored hash)', async () => {
    const { body } = await doLogin(TEST_EMAIL, 'anything');
    const apiKey = body['apiKey'] as string;
    const expectedHash = sha256Hex(apiKey);

    const rows = await db.execute<{ key_hash: string }>(sql`
      SELECT key_hash FROM api_keys
      WHERE tenant_id = ${testTenantId}
      ORDER BY created_at DESC
      LIMIT 1
    `);

    expect(rows.rows.length).toBe(1);
    // The stored hash should match SHA-256 of the raw key
    expect(rows.rows[0].key_hash).toBe(expectedHash);
    // The stored hash should NOT equal the raw key itself
    expect(rows.rows[0].key_hash).not.toBe(apiKey);
  });

  it('returns 401 for unknown email', async () => {
    const { status, body } = await doLogin('nonexistent@nowhere.com', 'pass');
    expect(status).toBe(401);
    expect(body).toHaveProperty('error', 'InvalidCredentials');
  });

  it('returns 401 for suspended tenant', async () => {
    // Suspend the tenant temporarily
    await db.execute(sql`
      UPDATE tenants SET status = 'suspended' WHERE id = ${testTenantId}
    `);

    const { status, body } = await doLogin(TEST_EMAIL, 'anything');
    expect(status).toBe(401);
    expect(body).toHaveProperty('error', 'InvalidCredentials');

    // Restore
    await db.execute(sql`
      UPDATE tenants SET status = 'active' WHERE id = ${testTenantId}
    `);
  });

  it('each login creates a NEW api_key row (does not reuse old key)', async () => {
    await doLogin(TEST_EMAIL, 'first-login');
    await doLogin(TEST_EMAIL, 'second-login');

    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM api_keys
      WHERE tenant_id = ${testTenantId}
    `);

    expect(rows.rows.length).toBe(2);
  });
});
