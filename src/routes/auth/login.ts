// src/routes/auth/login.ts
import type { FastifyInstance } from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/index.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

interface TenantRow extends Record<string, unknown> {
  id: string;
  slug: string;
  display_name: string;
  email: string;
  status: string;
}

export default async function authPlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb },
): Promise<void> {
  const { db } = opts;

  fastify.post<{
    Body: { email: string; password: string };
  }>('/login', async (request, reply) => {
    const { email, password } = request.body ?? {};

    if (!email || !password) {
      return reply.code(400).send({
        error: 'ValidationError',
        detail: 'email and password are required',
      });
    }

    // Step 1 — Look up tenant by email
    const tenantResult = await db.execute<TenantRow>(sql`
      SELECT id, slug, display_name, email, status
      FROM tenants
      WHERE email = ${email}
        AND status = 'active'
      LIMIT 1
    `);

    if (tenantResult.rows.length === 0) {
      return reply.code(401).send({ error: 'InvalidCredentials' });
    }

    const tenant = tenantResult.rows[0];

    // Step 2 — Generate a NEW api key for this login session
    // (We cannot recover previously generated raw keys — only hashes are stored)
    const rawKey = randomBytes(32).toString('hex');
    const keyHash = sha256Hex(rawKey);
    const keyPrefix = rawKey.slice(0, 8);

    // Step 3 — Insert the key
    await db.execute(sql`
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label)
      VALUES (${tenant.id}, ${keyHash}, ${keyPrefix}, 'login-session')
    `);

    // Step 4 — Return credentials (rawKey exposed only once)
    return reply.code(200).send({
      apiKey: rawKey,
      tenantId: tenant.id,
      slug: tenant.slug,
      displayName: tenant.display_name,
      email: tenant.email,
    });
  });
}
