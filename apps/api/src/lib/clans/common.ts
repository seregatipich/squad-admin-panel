/** Constants, schemas and mappers shared by the clan route modules. */

import type { ClanRow } from '@squad/db/schema';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestUser } from '../request-user.js';

/** Squad permission key that already grants a reserve slot through a role, which a clan priority slot must not duplicate. */
export const RESERVE_SQUAD_PERMISSION_KEY = 'reserve';

/** Route params of the clan routes keyed by clan id. */
export const clanIdParams = z.object({ id: z.string().uuid() });

/** Route params of the clan member routes keyed by clan id and member player id. */
export const memberParams = z.object({ id: z.string().uuid(), playerId: z.string().uuid() });

/** Audit snapshot of a clan row, used for the before/after payloads of clan audit entries. */
export function clanSnapshot(row: ClanRow) {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    description: row.description,
    max_priority_slots: row.maxPrioritySlots,
    priority_expires_at: row.priorityExpiresAt ? row.priorityExpiresAt.toISOString() : null,
    is_tag_protected: row.isTagProtected,
    is_public: row.isPublic,
    primary_server_id: row.primaryServerId,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/** Wire shape of a clan row in the clan API responses. */
export function toClanDto(row: ClanRow) {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    description: row.description,
    max_priority_slots: row.maxPrioritySlots,
    priority_expires_at: row.priorityExpiresAt ? row.priorityExpiresAt.toISOString() : null,
    is_tag_protected: row.isTagProtected,
    is_public: row.isPublic,
    primary_server_id: row.primaryServerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** SQLSTATE code and constraint name of a driver error, read from the error or its direct cause. */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  const wrapped = err as {
    code?: string;
    constraint_name?: string;
    cause?: { code?: string; constraint_name?: string };
  };
  return {
    code: wrapped.code ?? wrapped.cause?.code,
    constraint: wrapped.constraint_name ?? wrapped.cause?.constraint_name,
  };
}

/** Audit actor of a clan mutation: the signed-in player and, when one was used, the API token. */
export function auditActor(req: FastifyRequest) {
  return {
    kind: 'steam' as const,
    playerId: requestUser(req).playerId,
    tokenId: req.apiTokenId ?? null,
  };
}
