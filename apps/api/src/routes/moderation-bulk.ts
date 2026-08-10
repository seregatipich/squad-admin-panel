import { players, servers } from '@squad/db/schema';
import type { PermissionKey } from '@squad/shared-config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { parseBanLengthToExpiry } from '../lib/banlist-publish.js';
import {
  type EnforceActionType,
  enforceModerationAction,
  type PlayerIdentity,
} from '../lib/moderation-enforce.js';
import { parseStoredRoster } from '../lib/roster.js';

/** Hard ceiling on targets per request — see the deadline note below. */
const BULK_MOD_MAX = 50;
/** Same reason ceiling as the single-target moderation and report routes. */
const REASON_MAX = 300;
/** Squad's `AdminBan` duration grammar; `0` (any unit) means permanent. */
const BAN_LENGTH_PATTERN = /^\d+[smhdwMy]?$/;
/**
 * Wall-clock budget for the whole loop. Each target costs one worker-rcon
 * round trip whose default timeout is 4 s (`rcon-worker-command.ts`), so
 * {@link BULK_MOD_MAX} unresponsive targets would otherwise hold one HTTP
 * request open for over three minutes. Once the budget is spent the
 * remaining targets are reported as `bulk_deadline_exceeded` without being
 * attempted, and the partial result is still returned.
 */
const BULK_DEADLINE_MS = 25_000;

const bulkBody = z.object({
  server_id: z.string().uuid(),
  action_type: z.enum(['warn', 'kick', 'ban']),
  player_ids: z.array(z.string().uuid()).min(1).max(BULK_MOD_MAX),
  reason: z.string().trim().min(1).max(REASON_MAX),
  ban_length: z.string().trim().regex(BAN_LENGTH_PATTERN, 'invalid ban_length').default('0'),
  /**
   * Server half of the UI's double confirmation. A literal `true` is the only
   * accepted value, so a bulk enforcement can never be triggered by a body
   * that merely omitted the flag.
   */
  confirm_bulk: z.literal(true),
});

/** Why one target was not enforced. Request-level failures never appear here. */
type BulkTargetError =
  | 'player_not_found'
  | 'target_identity_missing'
  | 'target_offline'
  | 'rcon_failed'
  | 'bulk_deadline_exceeded';

interface BulkTargetResult {
  player_id: string;
  status: 'applied' | 'failed';
  moderation_action_id?: string;
  error?: BulkTargetError;
  detail?: string;
}

function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

/**
 * The catalog key a bulk action requires. These four keys are themselves
 * gated on the role's live-Squad `kick`/`ban` permission by
 * `derivePanelPermissions` (`lib/rbac.ts`, MOD-2 #59), so checking them here
 * enforces exactly that model — one permission model, read at the catalog
 * level so the 403 can name the specific key the caller is missing.
 *
 * A ban's key depends on its duration, which lives in the request body;
 * `config.permissions` is evaluated in an `onRequest` hook before the body is
 * parsed (`plugins/auth.ts`), so the check has to happen in the handler.
 */
function requiredKeyFor(actionType: EnforceActionType, banLength: string): PermissionKey {
  if (actionType === 'warn') return 'mod:warn';
  if (actionType === 'kick') return 'mod:kick';
  const permanent = parseBanLengthToExpiry(banLength, new Date()) === null;
  return permanent ? 'mod:ban_perm' : 'mod:ban_temp';
}

function auditActor(req: FastifyRequest): AuditActor {
  return {
    kind: 'steam',
    // biome-ignore lint/style/noNonNullAssertion: panelGuard rejects unauthenticated callers first
    playerId: req.user!.playerId,
    tokenId: req.apiTokenId ?? null,
  };
}

/**
 * Bulk moderation (MOD-4, #61): applies one warn/kick/ban to a list of
 * players picked from the live roster in a single request.
 *
 * The operation is deliberately **not** transactional. Half of each target's
 * effect leaves the process (an RCON command executed on the game server)
 * and Squad has no inverse command, so a rollback could only ever undo the
 * ledger rows — leaving players banned in game with no record. Instead each
 * target is enforced through {@link enforceModerationAction}, which writes
 * the `moderation_actions` row only once the RCON command is confirmed and
 * before the loop moves on; a failure is recorded in `results[]` and the loop
 * continues. The response is `200` with a per-target breakdown, never a
 * whole-request `502`.
 */
const moderationBulkRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/moderation-actions/bulk',
    { schema: { body: bulkBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const {
        server_id: serverId,
        action_type: actionType,
        reason,
        ban_length: banLength,
      } = req.body;

      const required = requiredKeyFor(actionType, banLength);
      // biome-ignore lint/style/noNonNullAssertion: panelGuard rejects unauthenticated callers first
      const actor = req.user!;
      if (!actor.permissions.permissions.has(required)) {
        reply.code(403);
        return { error: 'forbidden', required };
      }

      const [server] = await app.db
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
        .limit(1);
      if (!server) {
        reply.code(404);
        return { error: 'server_not_found' };
      }

      // Repeated ids collapse: a player selected twice must be enforced once.
      const playerIds = [...new Set(req.body.player_ids)];

      const rows = await app.db
        .select({
          id: players.id,
          eosId: players.eosId,
          steamId64: players.steamId64,
          name: players.canonicalName,
        })
        .from(players)
        .where(inArray(players.id, playerIds));
      const byId = new Map(rows.map((row) => [row.id, row]));

      // Warn and kick only reach a player who is currently connected; ban does
      // not, since AdminBan accepts an offline SteamID64.
      const roster =
        actionType === 'ban'
          ? null
          : parseStoredRoster(await app.redis.get(`rcon:roster:${serverId}`));
      const onlineEos = new Set((roster?.players ?? []).map((entry) => entry.eos_id));
      const onlineSteam = new Set(
        (roster?.players ?? [])
          .map((entry) => entry.steam_id64)
          .filter((id): id is string => id !== null),
      );

      const bulkGroup = uuidv7();
      const bulkSize = playerIds.length;
      const deadline = Date.now() + BULK_DEADLINE_MS;
      const results: BulkTargetResult[] = [];

      for (const [index, playerId] of playerIds.entries()) {
        if (Date.now() > deadline) {
          results.push({ player_id: playerId, status: 'failed', error: 'bulk_deadline_exceeded' });
          continue;
        }

        const row = byId.get(playerId);
        if (!row) {
          results.push({ player_id: playerId, status: 'failed', error: 'player_not_found' });
          continue;
        }

        const steamId64 = row.steamId64 !== null ? row.steamId64.toString() : null;
        const identity: PlayerIdentity = { eosId: row.eosId, steamId64, name: row.name };
        if (!identity.eosId && !identity.steamId64) {
          results.push({ player_id: playerId, status: 'failed', error: 'target_identity_missing' });
          continue;
        }

        if (actionType !== 'ban') {
          const online =
            (identity.eosId !== null && onlineEos.has(identity.eosId)) ||
            (identity.steamId64 !== null && onlineSteam.has(identity.steamId64));
          if (!online) {
            results.push({ player_id: playerId, status: 'failed', error: 'target_offline' });
            continue;
          }
        }

        const outcome = await enforceModerationAction(app, {
          serverId: server.id,
          playerId,
          identity,
          actionType,
          reason,
          banLength,
          actorPlayerId: actor.playerId,
          actorName: actor.canonicalName,
          source: 'live_players',
          extraContext: { bulk_group: bulkGroup, bulk_size: bulkSize, bulk_index: index },
        });

        let result: BulkTargetResult;
        if (outcome.ok) {
          result = {
            player_id: playerId,
            status: 'applied',
            moderation_action_id: outcome.actionId,
          };
        } else {
          // `enforceModerationAction` only reports `ok: false` for an outcome
          // that was not attempted or not ok, but that invariant does not
          // survive the return-type boundary — re-narrow to read `reason`.
          const rcon = outcome.outcome;
          const detail = !rcon.attempted || !rcon.ok ? rcon.reason : undefined;
          result = { player_id: playerId, status: 'failed', error: 'rcon_failed', detail };
        }
        results.push(result);

        // Audit every target the route actually reached through RCON,
        // applied or not: a command the panel saw time out may still have
        // landed in game, and that is exactly when the trail matters. Targets
        // rejected before RCON (unknown player, offline, budget spent) are
        // covered by the summary row's results breakdown.
        await writeAuditEntry(app.db, {
          actor: auditActor(req),
          actorIp: req.ip ?? null,
          actionType: 'moderation.bulk_action',
          targetType: 'player',
          targetId: playerId,
          after: {
            action_type: actionType,
            reason,
            ban_length: banLength,
            status: result.status,
            moderation_action_id: result.moderation_action_id ?? null,
          },
          context: {
            requestId: req.id,
            method: req.method,
            url: req.url,
            bulk_group: bulkGroup,
            bulk_size: bulkSize,
          },
          statusCode: reply.statusCode,
        });
      }

      const applied = results.filter((row) => row.status === 'applied').length;

      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'moderation.bulk_action',
        targetType: 'server',
        targetId: server.id,
        after: {
          action_type: actionType,
          reason,
          ban_length: banLength,
          player_ids: playerIds,
          applied,
          failed: results.length - applied,
        },
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url,
          bulk_group: bulkGroup,
          bulk_size: bulkSize,
        },
        statusCode: reply.statusCode,
      });

      return {
        bulk_group: bulkGroup,
        action_type: actionType,
        server_id: server.id,
        requested: results.length,
        applied,
        failed: results.length - applied,
        results,
      };
    },
  );
};

export default moderationBulkRoutes;
