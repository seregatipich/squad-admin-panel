import { players, roles } from '@squad/db/schema';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';

const STEAM_ID64_RE = /^\d{17}$/;
const IMPORT_MAX_ROWS = 5000;
const COMMENT_MAX_LEN = 512;
const BULK_MAX_IDS = 5000;

const roleIdParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const memberBody = z.object({
  player_id: z.string().uuid(),
  comment: z.string().trim().max(COMMENT_MAX_LEN).nullable().optional(),
});
const memberParam = z.object({
  id: z.string().uuid(),
  playerId: z.string().uuid(),
});
const importBody = z.object({ csv: z.string().trim().min(1).max(2_000_000) });
const bulkDeleteBody = z.object({
  player_ids: z.array(z.string().uuid()).min(1).max(BULK_MAX_IDS),
});
const moveBody = z.object({
  player_ids: z.array(z.string().uuid()).min(1).max(BULK_MAX_IDS),
  target_role_id: z.string().uuid(),
});

type ImportErrorReason =
  | 'invalid_steam_id64'
  | 'duplicate_steam_id64'
  | 'comment_too_long'
  | 'player_not_found'
  | 'owner_reassignment_forbidden';

interface ImportRowError {
  line: number;
  steam_id64: string;
  reason: ImportErrorReason;
}

/**
 * Split one import line into a SteamID64 candidate and an optional trailing
 * comment. The comment starts after the first `;`, so a comment may itself
 * contain semicolons. Returns the raw (untrimmed-of-meaning) SteamID token
 * and the trimmed comment (null when absent/empty).
 */
function parseImportRow(raw: string): { steamId64: string; comment: string | null } {
  const semi = raw.indexOf(';');
  if (semi === -1) return { steamId64: raw.trim(), comment: null };
  const steamId64 = raw.slice(0, semi).trim();
  const comment = raw.slice(semi + 1).trim();
  return { steamId64, comment: comment.length > 0 ? comment : null };
}

/** Escape a CSV cell (quote when it contains a delimiter, quote, or newline). */
function csvCell(value: string): string {
  if (/[";,\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const roleMembersRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /** The id of the system `Owner` role, or null if it is absent. */
  async function ownerRoleId(): Promise<string | null> {
    const rows = await app.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  fast.get(
    '/api/v1/roles/:id/members',
    {
      schema: { params: roleIdParam, querystring: listQuery },
      config: { permissions: ['user:view'], audit: false },
    },
    async (req, reply) => {
      const role = await app.db
        .select({ id: roles.id, name: roles.name, color: roles.color })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (role.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      const q = req.query.q?.toLowerCase().trim();
      const where = q
        ? and(
            eq(players.roleId, req.params.id),
            or(
              ilike(players.canonicalNameNormalized, `%${q}%`),
              sql`${players.steamId64}::text = ${q}`,
            ),
          )
        : eq(players.roleId, req.params.id);
      const totalRows = await app.db
        .select({ c: sql<number>`count(*)::int` })
        .from(players)
        .where(where);
      const total = totalRows[0]?.c ?? 0;
      const items = await app.db
        .select({
          id: players.id,
          steamId64: players.steamId64,
          canonicalName: players.canonicalName,
          lastSeenAt: players.lastSeenAt,
          roleComment: players.roleComment,
        })
        .from(players)
        .where(where)
        .orderBy(asc(players.canonicalNameNormalized))
        .limit(req.query.limit)
        .offset(req.query.offset);
      return {
        // biome-ignore lint/style/noNonNullAssertion: length-check above
        role: role[0]!,
        items: items.map((r) => ({
          id: r.id,
          steam_id64: r.steamId64 ? r.steamId64.toString() : null,
          canonical_name: r.canonicalName,
          last_seen_at: r.lastSeenAt,
          role_comment: r.roleComment,
        })),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );

  fast.post(
    '/api/v1/roles/:id/members',
    {
      schema: { params: roleIdParam, body: memberBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.add', resource: 'role' },
      },
    },
    async (req, reply) => {
      const target = await app.db
        .select({
          id: roles.id,
          name: roles.name,
          isSystemRole: roles.isSystemRole,
          panelAccess: roles.panelAccess,
        })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const role = target[0]!;
      if (role.isSystemRole && role.name === 'Owner') {
        reply.code(403);
        return { error: 'owner_assignment_forbidden' };
      }
      const playerId = req.body.player_id;
      const rawComment = req.body.comment?.trim() ?? null;
      const comment = rawComment === '' ? null : rawComment;
      const player = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (player.length === 0) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      await app.db.transaction(async (tx) => {
        await tx
          .update(players)
          .set({ roleId: req.params.id, roleComment: comment })
          .where(eq(players.id, playerId));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'role.member.add',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      invalidatePermissionCache(playerId);
      if (!role.panelAccess) {
        await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
      }
      reply.code(201);
      return { ok: true };
    },
  );

  fast.delete(
    '/api/v1/roles/:id/members/:playerId',
    {
      schema: { params: memberParam },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.remove', resource: 'role' },
      },
    },
    async (req, reply) => {
      const role = await app.db
        .select({ id: roles.id, name: roles.name, isSystemRole: roles.isSystemRole })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (role.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const r = role[0]!;
      const playerId = req.params.playerId;
      if (r.isSystemRole && r.name === 'Owner') {
        const membership = await app.db
          .select({ id: players.id })
          .from(players)
          .where(and(eq(players.id, playerId), eq(players.roleId, r.id)))
          .limit(1);
        if (membership.length === 0) return { ok: true };
        const count = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, r.id));
        if ((count[0]?.c ?? 0) <= 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }
      const removed = await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(players)
          .set({ roleId: null, roleComment: null, roleExpiresAt: null })
          .where(and(eq(players.id, playerId), eq(players.roleId, r.id)))
          .returning({ id: players.id });
        if (updated.length === 0) return false;
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'role.member.remove',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
        return true;
      });
      if (!removed) return { ok: true };
      invalidatePermissionCache(playerId);
      await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
      return { ok: true };
    },
  );

  // Bulk CSV import — ALL-OR-NOTHING. Every line is validated before any
  // write happens; if a single row is invalid the whole file is rejected
  // (422) and nothing is assigned. Each line is `SteamID64[;comment]`.
  fast.post(
    '/api/v1/roles/:id/members/import',
    {
      schema: { params: roleIdParam, body: importBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.import', resource: 'role' },
      },
    },
    async (req, reply) => {
      const target = await app.db
        .select({
          id: roles.id,
          name: roles.name,
          isSystemRole: roles.isSystemRole,
          panelAccess: roles.panelAccess,
        })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const role = target[0]!;
      if (role.isSystemRole && role.name === 'Owner') {
        reply.code(403);
        return { error: 'owner_assignment_forbidden' };
      }

      const lines = req.body.csv.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
      if (lines.length > IMPORT_MAX_ROWS) {
        reply.code(413);
        return { error: 'too_many_rows', max_rows: IMPORT_MAX_ROWS };
      }

      const parsed = lines.map((raw, index) => ({ line: index + 1, ...parseImportRow(raw) }));
      const errors: ImportRowError[] = [];

      // First pass: shape validation + in-file duplicate detection. Only the
      // first well-formed occurrence of each SteamID64 survives into pass two.
      const seen = new Set<string>();
      const validRows: Array<{ line: number; steamId64: string; comment: string | null }> = [];
      for (const row of parsed) {
        if (!STEAM_ID64_RE.test(row.steamId64)) {
          errors.push({ line: row.line, steam_id64: row.steamId64, reason: 'invalid_steam_id64' });
          continue;
        }
        if (row.comment !== null && row.comment.length > COMMENT_MAX_LEN) {
          errors.push({ line: row.line, steam_id64: row.steamId64, reason: 'comment_too_long' });
          continue;
        }
        if (seen.has(row.steamId64)) {
          errors.push({
            line: row.line,
            steam_id64: row.steamId64,
            reason: 'duplicate_steam_id64',
          });
          continue;
        }
        seen.add(row.steamId64);
        validRows.push(row);
      }

      // Second pass: existence + Owner-strip guard, resolved in one lookup.
      const ownerId = await ownerRoleId();
      const existing =
        validRows.length > 0
          ? await app.db
              .select({ id: players.id, steamId64: players.steamId64, roleId: players.roleId })
              .from(players)
              .where(
                inArray(
                  players.steamId64,
                  validRows.map((r) => BigInt(r.steamId64)),
                ),
              )
          : [];
      const bySteamId = new Map(
        existing.map((p) => [
          // biome-ignore lint/style/noNonNullAssertion: query filtered on steamId64
          p.steamId64!.toString(),
          p,
        ]),
      );
      const assignments: Array<{ playerId: string; comment: string | null }> = [];
      for (const row of validRows) {
        const player = bySteamId.get(row.steamId64);
        if (!player) {
          errors.push({ line: row.line, steam_id64: row.steamId64, reason: 'player_not_found' });
          continue;
        }
        if (ownerId !== null && player.roleId === ownerId) {
          errors.push({
            line: row.line,
            steam_id64: row.steamId64,
            reason: 'owner_reassignment_forbidden',
          });
          continue;
        }
        assignments.push({ playerId: player.id, comment: row.comment });
      }

      if (errors.length > 0) {
        reply.code(422);
        return { error: 'validation_failed', errors, imported: 0 };
      }
      await app.db.transaction(async (tx) => {
        for (const a of assignments) {
          await tx
            .update(players)
            .set({ roleId: req.params.id, roleComment: a.comment })
            .where(eq(players.id, a.playerId));
        }
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'role.member.import',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      for (const a of assignments) {
        invalidatePermissionCache(a.playerId);
        if (!role.panelAccess) await revokeAllForPlayer(app.db, app.redis, a.playerId);
      }
      reply.code(201);
      return { ok: true, imported: assignments.length };
    },
  );

  // CSV export of the role's members: `steam_id64;canonical_name;comment`.
  fast.get(
    '/api/v1/roles/:id/members/export',
    {
      schema: { params: roleIdParam },
      config: { permissions: ['user:view'], audit: false },
    },
    async (req, reply) => {
      const role = await app.db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (role.length === 0) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(404);
        return { error: 'role_not_found' };
      }
      const rows = await app.db
        .select({
          steamId64: players.steamId64,
          canonicalName: players.canonicalName,
          roleComment: players.roleComment,
        })
        .from(players)
        .where(eq(players.roleId, req.params.id))
        .orderBy(asc(players.canonicalNameNormalized));
      const lines = [
        'steam_id64;canonical_name;comment',
        ...rows
          .filter((row) => row.steamId64 !== null)
          .map((row) =>
            [
              // biome-ignore lint/style/noNonNullAssertion: filtered above
              row.steamId64!.toString(),
              csvCell(row.canonicalName),
              csvCell(row.roleComment ?? ''),
            ].join(';'),
          ),
      ];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="role-members-${stamp}.csv"`);
      return reply.send(body);
    },
  );

  // Bulk-remove selected members from this role (scoped to `roleId = :id`).
  fast.post(
    '/api/v1/roles/:id/members/bulk-delete',
    {
      schema: { params: roleIdParam, body: bulkDeleteBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.bulk_remove', resource: 'role' },
      },
    },
    async (req, reply) => {
      const role = await app.db
        .select({ id: roles.id, name: roles.name, isSystemRole: roles.isSystemRole })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (role.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const r = role[0]!;
      const playerIds = [...new Set(req.body.player_ids)];

      if (r.isSystemRole && r.name === 'Owner') {
        const totalRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, r.id));
        const affectedRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(and(eq(players.roleId, r.id), inArray(players.id, playerIds)));
        const remaining = (totalRows[0]?.c ?? 0) - (affectedRows[0]?.c ?? 0);
        if (remaining < 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }

      let removedIds: string[] = [];
      await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(players)
          .set({ roleId: null, roleComment: null })
          .where(and(eq(players.roleId, r.id), inArray(players.id, playerIds)))
          .returning({ id: players.id });
        removedIds = updated.map((u) => u.id);
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'role.member.bulk_remove',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      for (const id of removedIds) {
        invalidatePermissionCache(id);
        await revokeAllForPlayer(app.db, app.redis, id);
      }
      return { ok: true, removed: removedIds.length };
    },
  );

  // Move selected members from this role to a target role.
  fast.post(
    '/api/v1/roles/:id/members/move',
    {
      schema: { params: roleIdParam, body: moveBody },
      config: {
        permissions: ['user:manage_roles'],
        audit: { action: 'role.member.move', resource: 'role' },
      },
    },
    async (req, reply) => {
      const source = await app.db
        .select({ id: roles.id, name: roles.name, isSystemRole: roles.isSystemRole })
        .from(roles)
        .where(eq(roles.id, req.params.id))
        .limit(1);
      if (source.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const src = source[0]!;

      if (req.body.target_role_id === req.params.id) {
        reply.code(400);
        return { error: 'target_role_same_as_source' };
      }
      const targetRows = await app.db
        .select({
          id: roles.id,
          name: roles.name,
          isSystemRole: roles.isSystemRole,
          panelAccess: roles.panelAccess,
        })
        .from(roles)
        .where(eq(roles.id, req.body.target_role_id))
        .limit(1);
      if (targetRows.length === 0) {
        reply.code(404);
        return { error: 'target_role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: length-checked above
      const targetRole = targetRows[0]!;
      if (targetRole.isSystemRole && targetRole.name === 'Owner') {
        reply.code(403);
        return { error: 'owner_assignment_forbidden' };
      }

      const playerIds = [...new Set(req.body.player_ids)];
      if (src.isSystemRole && src.name === 'Owner') {
        const totalRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(eq(players.roleId, src.id));
        const affectedRows = await app.db
          .select({ c: sql<number>`count(*)::int` })
          .from(players)
          .where(and(eq(players.roleId, src.id), inArray(players.id, playerIds)));
        const remaining = (totalRows[0]?.c ?? 0) - (affectedRows[0]?.c ?? 0);
        if (remaining < 1) {
          reply.code(409);
          return { error: 'cannot_remove_last_owner' };
        }
      }

      let movedIds: string[] = [];
      await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(players)
          .set({ roleId: targetRole.id, roleComment: null })
          .where(and(eq(players.roleId, src.id), inArray(players.id, playerIds)))
          .returning({ id: players.id });
        movedIds = updated.map((u) => u.id);
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'role.member.move',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      for (const id of movedIds) {
        invalidatePermissionCache(id);
        if (!targetRole.panelAccess) await revokeAllForPlayer(app.db, app.redis, id);
      }
      return { ok: true, moved: movedIds.length };
    },
  );
};

export default roleMembersRoutes;
