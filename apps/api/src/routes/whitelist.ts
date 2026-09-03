import { panelMeta, players, roles } from '@squad/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { invalidatePermissionCache } from '../lib/rbac.js';
import { revokeAllForPlayer } from '../lib/sessions.js';

const PANEL_META_SINGLETON_ID = 1;
const STEAM_ID64_RE = /^\d{17}$/;
const IMPORT_MAX_ROWS = 5000;

const putSettingsBody = z.object({ whitelist_role_id: z.string().uuid().nullable() });
const memberBody = z.object({ player_id: z.string().uuid() });
const memberParam = z.object({ playerId: z.string().uuid() });
const importBody = z.object({ csv: z.string().trim().min(1).max(2_000_000) });

interface WhitelistSettingsView {
  whitelist_role_id: string | null;
  whitelist_role_name: string | null;
}

interface ImportSkippedRow {
  line: number;
  raw: string;
  reason: 'malformed_row' | 'invalid_steam_id64' | 'player_not_found';
}

interface ImportResult {
  total_rows: number;
  imported: number;
  skipped: ImportSkippedRow[];
}

class VipLifecycleOwnedError extends Error {
  constructor() {
    super('vip_lifecycle_owned');
  }
}

function actorFrom(req: FastifyRequest): AuditActor {
  return req.user
    ? { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null }
    : { kind: 'system', label: 'http-anonymous' };
}

/** Splits one CSV data row into a SteamID64 candidate and an optional trailing comment. */
function parseCsvRow(raw: string): { steamId64: string; comment: string | null } | null {
  const cells = raw.split(',').map((cell) => cell.trim());
  if (cells.length > 2) return null;
  const [steamId64, comment] = cells;
  if (!steamId64) return null;
  return { steamId64, comment: comment ? comment : null };
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const whitelistRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadWhitelistRoleId(): Promise<string | null> {
    const rows = await app.db
      .select({ whitelistRoleId: panelMeta.whitelistRoleId })
      .from(panelMeta)
      .where(eq(panelMeta.id, PANEL_META_SINGLETON_ID))
      .limit(1);
    return rows[0]?.whitelistRoleId ?? null;
  }

  async function settingsView(): Promise<WhitelistSettingsView> {
    const whitelistRoleId = await loadWhitelistRoleId();
    if (!whitelistRoleId) return { whitelist_role_id: null, whitelist_role_name: null };
    const roleRows = await app.db
      .select({ name: roles.name })
      .from(roles)
      .where(eq(roles.id, whitelistRoleId))
      .limit(1);
    return {
      whitelist_role_id: whitelistRoleId,
      whitelist_role_name: roleRows[0]?.name ?? null,
    };
  }

  /**
   * Idempotently assigns `whitelistRoleId` to a player, syncing Admins.cfg and
   * revoking panel sessions when the role loses panel access. Returns whether
   * the player's role actually changed (used to pick 201 vs. 200 no-op).
   */
  async function assignWhitelistRole(
    req: FastifyRequest,
    whitelistRoleId: string,
    playerId: string,
    comment: string | null,
  ): Promise<'assigned' | 'already_assigned' | 'player_not_found' | 'vip_lifecycle_owned'> {
    const playerRows = await app.db
      .select({
        id: players.id,
        roleId: players.roleId,
        roleLifecycleEventId: players.roleLifecycleEventId,
      })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    const player = playerRows[0];
    if (!player) return 'player_not_found';
    if (player.roleLifecycleEventId !== null) return 'vip_lifecycle_owned';
    if (player.roleId === whitelistRoleId && comment === null) return 'already_assigned';

    const roleRows = await app.db
      .select({ panelAccess: roles.panelAccess })
      .from(roles)
      .where(eq(roles.id, whitelistRoleId))
      .limit(1);
    const changed = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(players)
        .set({
          roleId: whitelistRoleId,
          roleExpiresAt: null,
          roleComment: comment,
          roleLifecycleEventId: null,
        })
        .where(and(eq(players.id, playerId), isNull(players.roleLifecycleEventId)))
        .returning({ id: players.id });
      if (!updated) return false;
      await publishAdminsCfgSyncForAllServers(tx, {
        reason: 'whitelist.member.add',
        actor_player_id: req.user?.playerId ?? null,
        enqueued_at: new Date().toISOString(),
        request_id: req.id,
      });
      return true;
    });
    if (!changed) return 'vip_lifecycle_owned';
    invalidatePermissionCache(playerId);
    if (!roleRows[0]?.panelAccess) {
      await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
    }
    return 'assigned';
  }

  fast.get(
    '/api/v1/whitelist/settings',
    { config: { permissions: ['whitelist:view'], audit: false } },
    async () => settingsView(),
  );

  fast.put(
    '/api/v1/whitelist/settings',
    {
      schema: { body: putSettingsBody },
      config: { permissions: ['whitelist:edit'], audit: false },
    },
    async (req, reply) => {
      const before = await settingsView();
      const roleId = req.body.whitelist_role_id;
      if (roleId) {
        const roleRows = await app.db
          .select({ id: roles.id, isSystemRole: roles.isSystemRole, name: roles.name })
          .from(roles)
          .where(eq(roles.id, roleId))
          .limit(1);
        const role = roleRows[0];
        if (!role) {
          reply.code(404);
          return { error: 'role_not_found' };
        }
        if (role.isSystemRole && role.name === 'Owner') {
          reply.code(403);
          return { error: 'owner_role_forbidden' };
        }
      }
      await app.db
        .update(panelMeta)
        .set({ whitelistRoleId: roleId })
        .where(eq(panelMeta.id, PANEL_META_SINGLETON_ID));
      const after = await settingsView();
      await writeAuditEntry(app.db, {
        actor: actorFrom(req),
        actorIp: req.ip ?? null,
        actionType: 'whitelist.settings.update',
        targetType: 'panel_meta',
        targetId: String(PANEL_META_SINGLETON_ID),
        before,
        after,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });
      return after;
    },
  );

  fast.post(
    '/api/v1/whitelist/members',
    {
      schema: { body: memberBody },
      config: { permissions: ['whitelist:edit'], audit: false },
    },
    async (req, reply) => {
      const whitelistRoleId = await loadWhitelistRoleId();
      if (!whitelistRoleId) {
        reply.code(409);
        return { error: 'whitelist_role_not_configured' };
      }
      const outcome = await assignWhitelistRole(req, whitelistRoleId, req.body.player_id, null);
      if (outcome === 'player_not_found') {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      if (outcome === 'vip_lifecycle_owned') {
        reply.code(409);
        return { error: 'vip_lifecycle_owned' };
      }
      if (outcome === 'already_assigned') {
        reply.code(200);
        return { ok: true, changed: false };
      }
      await writeAuditEntry(app.db, {
        actor: actorFrom(req),
        actorIp: req.ip ?? null,
        actionType: 'whitelist.member.add',
        targetType: 'player',
        targetId: req.body.player_id,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 201,
      });
      reply.code(201);
      return { ok: true, changed: true };
    },
  );

  fast.delete(
    '/api/v1/whitelist/members/:playerId',
    {
      schema: { params: memberParam },
      config: { permissions: ['whitelist:edit'], audit: false },
    },
    async (req, reply) => {
      const whitelistRoleId = await loadWhitelistRoleId();
      const playerRows = await app.db
        .select({
          id: players.id,
          roleId: players.roleId,
          roleLifecycleEventId: players.roleLifecycleEventId,
        })
        .from(players)
        .where(eq(players.id, req.params.playerId))
        .limit(1);
      const player = playerRows[0];
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      if (!whitelistRoleId || player.roleId !== whitelistRoleId) {
        return { ok: true, changed: false };
      }
      if (player.roleLifecycleEventId !== null) {
        reply.code(409);
        return { error: 'vip_lifecycle_owned' };
      }
      const changed = await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(players)
          .set({
            roleId: null,
            roleExpiresAt: null,
            roleComment: null,
            roleLifecycleEventId: null,
          })
          .where(and(eq(players.id, player.id), isNull(players.roleLifecycleEventId)))
          .returning({ id: players.id });
        if (!updated) return false;
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'whitelist.member.remove',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
        return true;
      });
      if (!changed) {
        reply.code(409);
        return { error: 'vip_lifecycle_owned' };
      }
      invalidatePermissionCache(player.id);
      await revokeAllForPlayer(app.db, app.redis, player.id, app.liveBus);
      await writeAuditEntry(app.db, {
        actor: actorFrom(req),
        actorIp: req.ip ?? null,
        actionType: 'whitelist.member.remove',
        targetType: 'player',
        targetId: player.id,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });
      return { ok: true, changed: true };
    },
  );

  fast.post(
    '/api/v1/whitelist/import',
    {
      schema: { body: importBody },
      config: { permissions: ['whitelist:edit'], audit: false },
    },
    async (req, reply) => {
      const whitelistRoleId = await loadWhitelistRoleId();
      if (!whitelistRoleId) {
        reply.code(409);
        return { error: 'whitelist_role_not_configured' };
      }
      const [whitelistRole] = await app.db
        .select({ panelAccess: roles.panelAccess })
        .from(roles)
        .where(eq(roles.id, whitelistRoleId))
        .limit(1);
      const lines = req.body.csv.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
      if (lines.length > IMPORT_MAX_ROWS) {
        reply.code(413);
        return { error: 'too_many_rows', max_rows: IMPORT_MAX_ROWS };
      }
      const result: ImportResult = { total_rows: lines.length, imported: 0, skipped: [] };
      const assignments: Array<{ playerId: string; comment: string | null }> = [];
      for (const [index, raw] of lines.entries()) {
        const lineNumber = index + 1;
        const parsed = parseCsvRow(raw);
        if (!parsed) {
          result.skipped.push({ line: lineNumber, raw, reason: 'malformed_row' });
          continue;
        }
        if (!STEAM_ID64_RE.test(parsed.steamId64)) {
          result.skipped.push({ line: lineNumber, raw, reason: 'invalid_steam_id64' });
          continue;
        }
        const playerRows = await app.db
          .select({ id: players.id })
          .from(players)
          .where(eq(players.steamId64, BigInt(parsed.steamId64)))
          .limit(1);
        const player = playerRows[0];
        if (!player) {
          result.skipped.push({ line: lineNumber, raw, reason: 'player_not_found' });
          continue;
        }
        assignments.push({ playerId: player.id, comment: parsed.comment });
      }
      const changedPlayerIds: string[] = [];
      try {
        await app.db.transaction(async (tx) => {
          const locked =
            assignments.length === 0
              ? []
              : await tx
                  .select({
                    id: players.id,
                    roleId: players.roleId,
                    marker: players.roleLifecycleEventId,
                  })
                  .from(players)
                  .where(
                    inArray(
                      players.id,
                      assignments.map((assignment) => assignment.playerId),
                    ),
                  )
                  .orderBy(players.id)
                  .for('update');
          if (locked.some((player) => player.marker !== null)) {
            throw new VipLifecycleOwnedError();
          }
          const lockedById = new Map(locked.map((player) => [player.id, player]));
          for (const assignment of assignments) {
            const current = lockedById.get(assignment.playerId);
            if (!current) continue;
            result.imported += 1;
            if (current.roleId === whitelistRoleId && assignment.comment === null) continue;
            const [updated] = await tx
              .update(players)
              .set({
                roleId: whitelistRoleId,
                roleExpiresAt: null,
                roleComment: assignment.comment,
                roleLifecycleEventId: null,
              })
              .where(and(eq(players.id, assignment.playerId), isNull(players.roleLifecycleEventId)))
              .returning({ id: players.id });
            if (!updated) throw new Error('whitelist import target changed after lock');
            changedPlayerIds.push(updated.id);
            await publishAdminsCfgSyncForAllServers(tx, {
              reason: 'whitelist.member.add',
              actor_player_id: req.user?.playerId ?? null,
              enqueued_at: new Date().toISOString(),
              request_id: req.id,
            });
          }
        });
      } catch (error) {
        if (error instanceof VipLifecycleOwnedError) {
          reply.code(409);
          return { error: 'vip_lifecycle_owned' };
        }
        throw error;
      }
      for (const playerId of changedPlayerIds) {
        invalidatePermissionCache(playerId);
        if (!whitelistRole?.panelAccess) {
          await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
        }
      }
      await writeAuditEntry(app.db, {
        actor: actorFrom(req),
        actorIp: req.ip ?? null,
        actionType: 'whitelist.import',
        targetType: 'panel_meta',
        targetId: String(PANEL_META_SINGLETON_ID),
        after: { imported: result.imported, skipped: result.skipped.length },
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });
      return result;
    },
  );

  fast.get(
    '/api/v1/whitelist/export',
    { config: { permissions: ['whitelist:view'], audit: false } },
    async (_req, reply) => {
      const whitelistRoleId = await loadWhitelistRoleId();
      const rows = whitelistRoleId
        ? await app.db
            .select({
              steamId64: players.steamId64,
              canonicalName: players.canonicalName,
              roleComment: players.roleComment,
            })
            .from(players)
            .where(eq(players.roleId, whitelistRoleId))
            .orderBy(players.canonicalNameNormalized)
        : [];
      const lines = [
        'steam_id64,canonical_name,comment',
        ...rows
          .filter((row) => row.steamId64 !== null)
          .map((row) =>
            [
              // biome-ignore lint/style/noNonNullAssertion: filtered above
              row.steamId64!.toString(),
              csvCell(row.canonicalName),
              csvCell(row.roleComment ?? ''),
            ].join(','),
          ),
      ];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="whitelist-${stamp}.csv"`);
      return reply.send(body);
    },
  );
};

export default whitelistRoutes;
