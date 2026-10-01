/** Schemas, path helpers and the per-file write gate shared by the config route modules. */

import { createHash } from 'node:crypto';
import {
  ALLOWED_CONFIG_FILES,
  type AllowedConfigFile,
  PANEL_CONFIGS_ROOT,
  type PermissionKey,
} from '@squad/shared-config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DELETION_BACKUP_MARKER } from '../server-delete.js';

/** Route params keyed by server id. */
export const idParams = z.object({ id: z.string().uuid() });
/** Route params keyed by server id and config file name. */
export const nameParams = z.object({ id: z.string().uuid(), name: z.string().min(1).max(64) });

// #281: a user message must not pass for a deletion backup, which archive
// restore selects by its message prefix.
export const userMessage = z
  .string()
  .max(500)
  .refine((m) => !m.trim().toLowerCase().startsWith(DELETION_BACKUP_MARKER), {
    message: 'reserved_message_prefix',
  });

/** Optional body of the routes that record a new version: an optional version message. */
export const restoreBody = z
  .object({ message: userMessage.optional() })
  .default({ message: undefined });

/**
 * Wall-clock budget for one diff or blame computation (#283). Myers diffing is
 * synchronous and O((N+M)·D), so without a bound two large unrelated versions
 * block the event loop for minutes.
 */
export const DIFF_TIMEOUT_MS = 2_000;

/**
 * Files whose content grants what a separate permission guards (#1236): a
 * `Bans.cfg` line or a remote ban list bans a player, and an `Admins.cfg` line
 * or a remote admin list grants Squad admin rights. `config:edit` alone must
 * not bypass `mod:ban_perm` (squad `ban`) or `user:manage_roles`
 * (`can_assign_roles`).
 */
const FILE_WRITE_PERMISSION: Partial<Record<AllowedConfigFile, PermissionKey>> = {
  'Bans.cfg': 'mod:ban_perm',
  'RemoteBanListHosts.cfg': 'mod:ban_perm',
  'Admins.cfg': 'user:manage_roles',
  'RemoteAdminListHosts.cfg': 'user:manage_roles',
};

/**
 * Checks the per-file permission a write to `name` needs on top of the
 * route's own (#1236) and sets 403 on `reply` when the caller lacks it.
 *
 * @returns The 403 body to send, or null when the write may proceed.
 */
export function fileWriteForbidden(
  req: FastifyRequest,
  reply: FastifyReply,
  name: AllowedConfigFile,
): { error: 'forbidden'; required_permission: PermissionKey } | null {
  const required = FILE_WRITE_PERMISSION[name];
  if (!required || req.user?.permissions.permissions.has(required)) return null;
  reply.code(403);
  return { error: 'forbidden', required_permission: required };
}

/** Whether `name` is on the allowlist of editable config files. */
export function isAllowed(name: string): name is AllowedConfigFile {
  return (ALLOWED_CONFIG_FILES as readonly string[]).includes(name);
}

/** Host path of a server's config file under the panel configs root. */
export function configPath(serverId: string, file: AllowedConfigFile): string {
  return `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/${file}`;
}

/** SHA-256 digest of `content`. */
export function sha256(content: string): Buffer {
  return createHash('sha256').update(content).digest();
}

/** Hex rendering of a digest, or `null` when there is none. */
export function hex(b: Buffer | Uint8Array | null): string | null {
  return b ? Buffer.from(b).toString('hex') : null;
}
