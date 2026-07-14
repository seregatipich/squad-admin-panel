import type { DatabaseClient } from '@squad/db';
import {
  auditLog,
  clanGuardSettings,
  clanMembers,
  clans,
  moderationActions,
  playerSessions,
  players,
  roles,
} from '@squad/db/schema';
import {
  type RconOperatorCommandName,
  rconCommandRequestSchema,
  rconCommandStream,
} from '@squad/shared-types';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type {
  ClanGuardSettings,
  ClanGuardTickDeps,
  LastWarn,
  OnlinePlayer,
  ProtectedClan,
  RecordModerationActionInput,
  SendRconCommandInput,
  WriteClanGuardAuditInput,
} from './tick.js';

const SINGLETON_ID = 1;
const RCON_STREAM_MAXLEN = 500;
const CLAN_TAG_PROTECTION_ACTION_TYPE = 'clan_tag_protection';
const CLAN_GUARD_AUDIT_ACTION_TYPES = {
  warn: 'clan.tag_protection.warn',
  kick: 'clan.tag_protection.kick',
} as const;
const CLAN_GUARD_SYSTEM_LABEL = 'clan-guard';

export async function loadSettings(db: DatabaseClient): Promise<ClanGuardSettings> {
  const rows = await db
    .select({
      enabled: clanGuardSettings.enabled,
      gracePeriodSeconds: clanGuardSettings.gracePeriodSeconds,
    })
    .from(clanGuardSettings)
    .where(eq(clanGuardSettings.id, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return { enabled: true, gracePeriodSeconds: 300 };
  return { enabled: row.enabled, gracePeriodSeconds: row.gracePeriodSeconds };
}

export async function loadProtectedClans(db: DatabaseClient): Promise<ProtectedClan[]> {
  const clanRows = await db
    .select({ id: clans.id, name: clans.name, tags: clans.tags })
    .from(clans)
    .where(and(eq(clans.isTagProtected, true), isNull(clans.deletedAt)));
  if (clanRows.length === 0) return [];

  const clanIds = clanRows.map((row) => row.id);
  const memberRows = await db
    .select({ clanId: clanMembers.clanId, playerId: clanMembers.playerId })
    .from(clanMembers)
    .where(inArray(clanMembers.clanId, clanIds));

  const membersByClan = new Map<string, Set<string>>();
  for (const row of memberRows) {
    const set = membersByClan.get(row.clanId) ?? new Set<string>();
    set.add(row.playerId);
    membersByClan.set(row.clanId, set);
  }

  return clanRows.map((row) => ({
    id: row.id,
    name: row.name,
    tags: row.tags,
    memberPlayerIds: membersByClan.get(row.id) ?? new Set<string>(),
  }));
}

export async function loadOnlinePlayers(db: DatabaseClient): Promise<OnlinePlayer[]> {
  const rows = await db
    .select({
      playerId: players.id,
      serverId: playerSessions.serverId,
      eosId: players.eosId,
      name: players.canonicalName,
      connectedAt: playerSessions.connectedAt,
      panelAccess: roles.panelAccess,
    })
    .from(playerSessions)
    .innerJoin(players, eq(playerSessions.playerId, players.id))
    .leftJoin(roles, eq(players.roleId, roles.id))
    .where(and(isNull(playerSessions.disconnectedAt), eq(playerSessions.mode, 'online')));

  return rows.map((row) => ({
    playerId: row.playerId,
    serverId: row.serverId,
    eosId: row.eosId,
    name: row.name,
    connectedAt: row.connectedAt,
    hasPanelAccess: row.panelAccess ?? false,
  }));
}

export async function findLastWarn(
  db: DatabaseClient,
  playerId: string,
  serverId: string,
  connectedAt: Date,
): Promise<LastWarn | null> {
  const rows = await db
    .select({ createdAt: moderationActions.createdAt })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.playerId, playerId),
        eq(moderationActions.serverId, serverId),
        eq(moderationActions.actionType, CLAN_TAG_PROTECTION_ACTION_TYPE),
        sql`${moderationActions.context}->>'phase' = 'warn'`,
        isNull(moderationActions.revertedAt),
        gte(moderationActions.createdAt, connectedAt),
      ),
    )
    .orderBy(desc(moderationActions.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? { createdAt: row.createdAt } : null;
}

export async function recordModerationAction(
  db: DatabaseClient,
  input: RecordModerationActionInput,
): Promise<void> {
  await db.insert(moderationActions).values({
    playerId: input.playerId,
    serverId: input.serverId,
    actionType: CLAN_TAG_PROTECTION_ACTION_TYPE,
    authorSystemLabel: CLAN_GUARD_SYSTEM_LABEL,
    reason: input.message,
    context: {
      phase: input.phase,
      clan_id: input.clanId,
      tag: input.tag,
      matched_name: input.matchedName,
    },
  });
}

export async function writeClanGuardAuditEntry(
  db: DatabaseClient,
  input: WriteClanGuardAuditInput,
): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: 'system',
    actorPlayerId: null,
    actorTokenId: null,
    actorSystemLabel: CLAN_GUARD_SYSTEM_LABEL,
    actorIp: null,
    actionType: CLAN_GUARD_AUDIT_ACTION_TYPES[input.phase],
    targetType: 'player',
    targetId: input.playerId,
    beforeSnapshot: null,
    afterSnapshot: null,
    context: { server_id: input.serverId, clan_id: input.clanId, message: input.message },
    statusCode: null,
    durationMs: null,
    rowHash: Buffer.from([]),
  });
}

/**
 * Enqueues an operator RCON command directly onto the worker-rcon Redis
 * stream, fire-and-forget (no result wait) — mirrors the payload shape of
 * `sendRconCommandViaWorker` (apps/api/src/lib/rcon-worker-command.ts), which
 * this worker cannot import from the API package.
 */
export async function sendRconCommand(
  redis: Pick<Redis, 'xadd'>,
  input: SendRconCommandInput,
): Promise<void> {
  const request = rconCommandRequestSchema.parse({
    request_id: uuidv7(),
    command: input.command as RconOperatorCommandName,
    args: input.args,
    actor_player_id: null,
    enqueued_at: new Date().toISOString(),
  });
  await redis.xadd(
    rconCommandStream(input.serverId),
    'MAXLEN',
    '~',
    String(RCON_STREAM_MAXLEN),
    '*',
    'request',
    JSON.stringify(request),
  );
}

export function createClanGuardDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'xadd'>,
): Omit<ClanGuardTickDeps, 'now' | 'diag'> {
  return {
    loadSettings: () => loadSettings(db),
    loadProtectedClans: () => loadProtectedClans(db),
    loadOnlinePlayers: () => loadOnlinePlayers(db),
    findLastWarn: (playerId, serverId, connectedAt) =>
      findLastWarn(db, playerId, serverId, connectedAt),
    sendRconCommand: (input) => sendRconCommand(redis, input),
    recordModerationAction: (input) => recordModerationAction(db, input),
    writeAuditEntry: (input) => writeClanGuardAuditEntry(db, input),
  };
}
