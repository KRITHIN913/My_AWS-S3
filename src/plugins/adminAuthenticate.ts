// src/plugins/adminAuthenticate.ts

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Valid admin roles. */
type AdminRole = 'superadmin' | 'support';

// ─────────────────────────────────────────────────────────────
// Fastify request augmentation
// ─────────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    adminId: string;
    adminRole: AdminRole;
  }
}

// ─────────────────────────────────────────────────────────────
// Minimal HS256 JWT implementation
// ─────────────────────────────────────────────────────────────

/**
 * Base64URL-decodes a string (no padding required).
 */
function base64urlDecode(input: string): Buffer {
  // Convert base64url → base64 by substituting chars and padding
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Raw JWT payload shape — only the fields we validate and use.
 */
interface JwtPayload {
  sub: string;
  role: string;
  exp?: number;
  iat?: number;
}


function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw 'malformed_token';

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Verify header declares HS256
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8')) as { alg?: string; typ?: string };
  } catch {
    throw 'malformed_token';
  }
  if (header.alg !== 'HS256') throw 'invalid_header';

  // Compute expected signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');

  // Timing-safe comparison
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf   = Buffer.from(sigB64,      'utf8');
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw 'invalid_sig';
  }

  // Decode payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as JwtPayload;
  } catch {
    throw 'malformed_token';
  }

  // Check expiry
  if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) {
    throw 'expired';
  }

  // Require sub and role
  if (!payload.sub || !payload.role) throw 'missing_claims';

  return payload;
}

function jwtErrorToResponse(err: string): { error: string; detail: string } {
  const map: Record<string, { error: string; detail: string }> = {
    missing_token:   { error: 'Unauthorized', detail: 'Missing Authorization header' },
    malformed_token: { error: 'Unauthorized', detail: 'Malformed JWT' },
    invalid_header:  { error: 'Unauthorized', detail: 'Only HS256 tokens are accepted' },
    invalid_sig:     { error: 'Unauthorized', detail: 'Invalid signature' },
    expired:         { error: 'Unauthorized', detail: 'Token has expired' },
    missing_claims:  { error: 'Unauthorized', detail: 'Token missing required claims (sub, role)' },
  };
  return map[err] ?? { error: 'Unauthorized', detail: 'Token validation failed' };
}

// ─────────────────────────────────────────────────────────────
// Exported preHandlers
// ─────────────────────────────────────────────────────────────


export async function adminAuthenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const secret = process.env['ADMIN_JWT_SECRET'];
  if (!secret) {
    request.log.error('ADMIN_JWT_SECRET is not configured');
    return reply.code(500).send({ error: 'Server misconfiguration' });
  }

  const authHeader = request.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send(jwtErrorToResponse('missing_token'));
  }

  const token = authHeader.slice('Bearer '.length).trim();

  let payload: JwtPayload;
  try {
    payload = verifyJwt(token, secret);
  } catch (err: unknown) {
    const errStr = typeof err === 'string' ? err : 'malformed_token';
    return reply.code(401).send(jwtErrorToResponse(errStr));
  }

  const role = payload.role as AdminRole;
  if (role !== 'superadmin' && role !== 'support') {
    return reply.code(401).send({ error: 'Unauthorized', detail: 'Unknown role' });
  }

  request.adminId   = payload.sub;
  request.adminRole = role;
}


export async function requireSuperadmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.adminRole === 'support') {
    return reply.code(403).send({ error: 'ReadOnlyRole' });
  }
}
