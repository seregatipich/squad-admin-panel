import type { FastifyRequest } from 'fastify';

/**
 * Whether the caller may see player IP addresses (ALT-8, #126). Read from the
 * effective permission set, so an API token only sees IPs when its scopes
 * include `player:view_ips`.
 */
export function canViewIps(req: FastifyRequest): boolean {
  return req.user?.permissions.permissions.has('player:view_ips') ?? false;
}

/**
 * Returns the payload with a top-level `ip` field nulled out (#10). The field
 * is carried by `player.connected` (`playerConnectedPayload.ip`); nulling it
 * rather than deleting it keeps the payload valid against that schema.
 */
export function redactPayloadIp(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!('ip' in payload)) return payload;
  return { ...payload, ip: null };
}
