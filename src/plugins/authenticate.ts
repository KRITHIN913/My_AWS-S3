// src/plugins/authenticate.ts


import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { DrizzleDb } from '../db/index.js';
import { sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────
// Fastify request type augmentation
// ─────────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    tenantId:   string;
    tenantSlug: string;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Returns an S3-compatible XML AccessDenied response body.
 */
function accessDeniedXml(requestId: string, message: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Error><Code>AccessDenied</Code>` +
    `<Message>${message}</Message>` +
    `<RequestId>${requestId}</RequestId></Error>`
  );
}

/**
 * Returns the SHA-256 hex digest of the given string.
 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────
// Row shape returned by the api_keys lookup query
// ─────────────────────────────────────────────────────────────

interface ApiKeyRow extends Record<string, unknown> {
  id:        string;
  tenant_id: string;
  slug:      string;
}

// ─────────────────────────────────────────────────────────────
// preHandler factory — closes over the db handle
// ─────────────────────────────────────────────────────────────

/**
 * Creates the `authenticate` Fastify preHandler.
 * Must be called once and the resulting function reused.
 *
 * @param db - Drizzle DB handle
 */
export function createAuthenticateHandler(db: DrizzleDb) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const authHeader = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      return reply
        .code(403)
        .type('application/xml')
        .send(accessDeniedXml(request.id, 'Missing or invalid Authorization header'));
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey) {
      return reply
        .code(403)
        .type('application/xml')
        .send(accessDeniedXml(request.id, 'Empty API key'));
    }

    const keyHash = sha256Hex(rawKey);

    // Single query — joins api_keys → tenants in one round-trip
    const result = await db.execute<ApiKeyRow>(sql`
      SELECT
        ak.id,
        ak.tenant_id,
        t.slug
      FROM api_keys ak
      JOIN tenants t ON ak.tenant_id = t.id
      WHERE ak.key_hash = ${keyHash}
        AND ak.status   = 'active'
        AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
        AND t.status    = 'active'
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return reply
        .code(403)
        .type('application/xml')
        .send(accessDeniedXml(request.id, 'Invalid, expired, or revoked API key'));
    }

    const row = result.rows[0];
    request.tenantId   = row.tenant_id;
    request.tenantSlug = row.slug;

    // Fire-and-forget: update last_used_at without blocking the request
    db.execute(sql`
      UPDATE api_keys SET last_used_at = NOW() WHERE id = ${row.id}
    `).catch(() => { /* non-fatal */ });
  };
}

/**
 * Standalone `authenticate` preHandler.
 *
 * ⚠️  This export is a compatibility shim for tests that vi.mock this module.
 * At runtime, use `createAuthenticateHandler(db)` to get a db-bound handler,
 * or register the `authenticatePlugin` which decorates the Fastify instance.
 *
 * Routes that need auth should use the handler provided by the plugin via
 * `fastify.authenticate`, or accept it as a constructor argument.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Placeholder — overridden at plugin registration time.
  // If this fires, the plugin was not registered.
  return reply
    .code(403)
    .type('application/xml')
    .send(accessDeniedXml(request.id, 'Authentication not configured'));
}

// ─────────────────────────────────────────────────────────────
// Fastify plugin — registers decorator + decorates request
// ─────────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Fastify plugin that:
 * 1. Decorates `request.tenantId` and `request.tenantSlug` with empty defaults.
 * 2. Decorates `fastify.authenticate` with a db-bound preHandler.
 *
 * Register once before any route that needs tenant identity.
 *
 * @param fastify - Fastify instance
 * @param opts    - Must include a DrizzleDb handle
 */
export default async function authenticatePlugin(
  fastify: FastifyInstance,
  opts: { db: DrizzleDb },
): Promise<void> {
  fastify.decorateRequest('tenantId',   '');
  fastify.decorateRequest('tenantSlug', '');

  const handler = createAuthenticateHandler(opts.db);
  fastify.decorate('authenticate', handler);
}
