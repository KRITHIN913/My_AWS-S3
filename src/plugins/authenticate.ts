// src/plugins/authenticate.ts

/**
 * Authentication stub plugin.
 *
 * In production, this would validate a bearer token (JWT, API key, etc.)
 * and resolve the tenant identity. For now, it reads the tenant ID and
 * slug from the Authorization header in the format:
 *   Authorization: Bearer <tenantId>:<tenantSlug>
 *
 * This is NOT production auth — it exists solely so the CreateBucket
 * route can read `request.tenantId` and `request.tenantSlug`.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/** Augment Fastify's request type with tenant identity fields. */
declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    tenantSlug: string;
  }
}

/**
 * Fastify preHandler hook that extracts tenant identity from the request.
 *
 * Expected header format: `Authorization: Bearer <tenantId>:<tenantSlug>`
 *
 * On missing or malformed header, responds with 401 and S3-compatible
 * XML error body.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply
      .code(401)
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Error><Code>AccessDenied</Code>` +
        `<Message>Missing or invalid Authorization header</Message>` +
        `<RequestId>${request.id}</RequestId></Error>`,
      );
    return;
  }

  const token = authHeader.slice('Bearer '.length);
  const separatorIndex = token.indexOf(':');

  if (separatorIndex === -1) {
    reply
      .code(401)
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Error><Code>AccessDenied</Code>` +
        `<Message>Malformed token</Message>` +
        `<RequestId>${request.id}</RequestId></Error>`,
      );
    return;
  }

  request.tenantId = token.slice(0, separatorIndex);
  request.tenantSlug = token.slice(separatorIndex + 1);
}

/**
 * Fastify plugin that registers the tenantId and tenantSlug decorators.
 * Must be registered before any route that uses `request.tenantId`.
 */
export default async function authenticatePlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorateRequest('tenantId', '');
  fastify.decorateRequest('tenantSlug', '');
}
