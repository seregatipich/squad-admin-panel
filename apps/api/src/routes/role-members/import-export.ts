import { players, roles } from '@squad/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../../lib/admins-cfg-sync.js';
import { csvCell } from '../../lib/csv.js';
import { publishDiscordRoleSync } from '../../lib/discord-role-sync.js';
import { invalidatePermissionCache } from '../../lib/rbac.js';
import { roleCeilingError, roleGrantBeyondActor } from '../../lib/role-guards.js';
import { checkRoleAssignment } from '../../lib/role-hierarchy.js';
import { COMMENT_MAX_LEN, roleIdParam } from '../../lib/role-members/common.js';
import { revokeAllForPlayers } from '../../lib/sessions.js';

const STEAM_ID64_RE = /^\d{17}$/;
const IMPORT_MAX_ROWS = 5000;
const IMPORT_MAX_CHARS = 2_000_000;
/**
 * Request body cap for the CSV import. Fastify's 1 MiB default rejected
 * files well inside {@link IMPORT_MAX_ROWS} with a bare 413 before the schema
 * ran; this fits {@link IMPORT_MAX_CHARS} characters of 3-byte UTF-8 (e.g.
 * Cyrillic comments) plus JSON escaping, so the row/char limits decide.
 */
const IMPORT_BODY_LIMIT_BYTES = 6 * 1024 * 1024;

const importBody = z.object({ csv: z.string().trim().min(1).max(IMPORT_MAX_CHARS) });

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

/** Role member CSV import and export. */
const roleMemberImportExportRoutes: FastifyPluginAsync = async (app) => {
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

  // Bulk CSV import — ALL-OR-NOTHING. Every line is validated before any
  // write happens; if a single row is invalid the whole file is rejected
  // (422) and nothing is assigned. Each line is `SteamID64[;comment]`.
  fast.post(
    '/api/v1/roles/:id/members/import',
    {
      bodyLimit: IMPORT_BODY_LIMIT_BYTES,
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
      const beyond = await roleGrantBeyondActor(app.db, role.id, req.user?.permissions);
      if (beyond.length > 0) {
        reply.code(403);
        return roleCeilingError(beyond);
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
      const hierarchyRefusal = await checkRoleAssignment(app.db, req.user, {
        playerIds: assignments.map((a) => a.playerId),
        newRoleId: role.id,
      });
      if (hierarchyRefusal) {
        reply.code(403);
        return hierarchyRefusal;
      }
      await app.db.transaction(async (tx) => {
        // One UPDATE … FROM (VALUES …) for the whole file (at most
        // IMPORT_MAX_ROWS rows, 2 bind parameters each — far below
        // Postgres' 65 535-parameter limit) instead of one round trip per row.
        if (assignments.length > 0) {
          const values = sql.join(
            assignments.map((a) => sql`(${a.playerId}::uuid, ${a.comment}::text)`),
            sql`, `,
          );
          await tx.execute(sql`
            UPDATE players
               SET role_id = ${req.params.id}::uuid,
                   role_expires_at = NULL,
                   role_comment = v.comment
              FROM (VALUES ${values}) AS v(id, comment)
             WHERE players.id = v.id
          `);
        }
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'role.member.import',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      for (const a of assignments) invalidatePermissionCache(a.playerId);
      if (assignments.length > 0) {
        await publishDiscordRoleSync(app.redis, null, 'role.member.import', app.log);
      }
      if (!role.panelAccess) {
        await revokeAllForPlayers(
          app.db,
          app.redis,
          assignments.map((a) => a.playerId),
          app.liveBus,
        );
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
};

export default roleMemberImportExportRoutes;
