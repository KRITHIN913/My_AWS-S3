// src/plugins/cors.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type,Authorization,X-Webhook-Event,X-Delivery-Id';
const MAX_AGE = '86400';

/**
 * Fastify plugin that adds CORS headers to every response.
 *
 * Reads the allowed origin from process.env.CORS_ORIGIN
 * (defaults to 'http://localhost:3001' for the Next.js dev server).
 *
 * On OPTIONS preflight requests, responds 204 immediately.
 */
export default async function corsPlugin(
  fastify: FastifyInstance,
): Promise<void> {
  const origin = process.env['CORS_ORIGIN'] ?? 'http://localhost:3001';

  fastify.addHook(
    'onRequest',
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
      reply.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      reply.header('Access-Control-Max-Age', MAX_AGE);

      if (request.method === 'OPTIONS') {
        return reply.code(204).send();
      }
    },
  );
}
