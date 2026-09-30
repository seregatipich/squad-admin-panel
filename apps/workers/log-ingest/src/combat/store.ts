import {
  applyCombatEventToDossier,
  type CombatEventType,
  combatEvents,
  type DatabaseClient,
  events,
  matches,
  playerNameHistory,
  players,
} from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import {
  buildTeamIndex,
  type CombatIdentity,
  type CombatKind,
  type CombatRecordCommand,
  detectTeamkill,
  type RosterTeamMember,
  type VehicleEventKind,
  type VehicleRecordCommand,
} from '../parser/combat.js';
import { createPlayerWithHistory, isUniqueViolation } from '../player-identity/create-player.js';

export const LIVE_BUS_CHANNEL = 'live-bus';
const COMBAT_EVENT_NAMESPACE = '2a7c1f6e-9b3d-4c8a-8e5f-1d6b0a4c9e73';

/**
 * DOSSIER-2 (#189): maps the log-ingest command kinds to the `combat_events`
 * `event_type` domain so the raw feed and the dossier aggregates share one
 * vocabulary. `vehicle_damage` folds into the generic `damage` type (weapon
 * damage dealt to a vehicle); `combat_revive`/`combat_wound` are recorded but
 * do not move any aggregate.
 */
const COMBAT_KIND_TO_EVENT_TYPE: Record<CombatKind, CombatEventType> = {
  combat_death: 'death',
  combat_damage: 'damage',
  combat_wound: 'wound',
  combat_revive: 'revive',
};
const VEHICLE_KIND_TO_EVENT_TYPE: Record<VehicleEventKind, CombatEventType> = {
  vehicle_destroyed: 'vehicle_destroyed',
  vehicle_damage: 'damage',
};

export interface CombatRedis {
  get(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<unknown>;
}

export interface HandleCombatResult {
  eventId: string;
  kind: CombatRecordCommand['kind'];
  inserted: boolean;
  attackerPlayerId: string | null;
  victimPlayerId: string | null;
  isTeamkill: boolean;
  matchId: string | null;
}

interface IdentityMatch {
  id: string;
  eosId: string | null;
  steamId64: bigint | null;
  /** The EOS id and SteamID belong to two different `players` rows. */
  conflicting: boolean;
}

/**
 * Finds the player row for an EOS id and/or SteamID. Each column is unique,
 * so at most two rows match; when they differ (an EOS-only row and a
 * Steam-only row for the same person), the EOS row wins and the match is
 * flagged `conflicting` so no backfill tries to merge them.
 */
async function resolveByIdentity(
  db: DatabaseClient,
  identity: { eosId: string | null; steamId64: string | null },
): Promise<IdentityMatch | null> {
  const filters = [];
  if (identity.eosId) filters.push(eq(players.eosId, identity.eosId));
  if (identity.steamId64) filters.push(eq(players.steamId64, BigInt(identity.steamId64)));
  if (filters.length === 0) return null;
  const rows = await db
    .select({ id: players.id, eosId: players.eosId, steamId64: players.steamId64 })
    .from(players)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(2);
  if (rows.length === 0) return null;
  const byEos = identity.eosId ? rows.find((row) => row.eosId === identity.eosId) : undefined;
  const chosen = byEos ?? rows[0];
  if (!chosen) return null;
  return { ...chosen, conflicting: rows.length > 1 };
}

/**
 * Resolves a player from a bare display name, which is how the log names a
 * victim. Returns `null` rather than guessing when the name is ambiguous: two
 * players currently carry it, or (with no current holder) more than one
 * player has used it before. A wrong guess would pin teamkills and deaths on
 * someone else.
 */
async function resolveByName(db: DatabaseClient, rawName: string): Promise<string | null> {
  const normalized = normalizePlayerName(rawName);
  if (!normalized) return null;
  const direct = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.canonicalNameNormalized, normalized))
    .limit(2);
  if (direct.length > 1) return null;
  if (direct[0]) return direct[0].id;
  const historical = await db
    .selectDistinct({ id: playerNameHistory.playerId })
    .from(playerNameHistory)
    .where(eq(playerNameHistory.nameNormalized, normalized))
    .limit(2);
  return historical.length === 1 ? (historical[0]?.id ?? null) : null;
}

async function createPlayer(db: DatabaseClient, identity: CombatIdentity): Promise<string | null> {
  const created = await createPlayerWithHistory(db, identity, 'log-ingest-combat');
  if (created) return created;
  const existing = await resolveByIdentity(db, {
    eosId: identity.eosId,
    steamId64: identity.steamId64,
  });
  return existing?.id ?? null;
}

/**
 * Fills a missing EOS id or SteamID on an existing player. Best-effort: when
 * the identity is split across two rows, or a concurrent writer claimed the
 * id first (unique violation), the row is left as is — the combat event is
 * still recorded against the resolved player instead of being dropped.
 */
async function backfillIdentity(
  db: DatabaseClient,
  existing: IdentityMatch,
  identity: CombatIdentity,
): Promise<void> {
  if (existing.conflicting) return;
  const updates: Record<string, unknown> = {};
  if (!existing.eosId && identity.eosId) updates.eosId = identity.eosId;
  if (!existing.steamId64 && identity.steamId64) updates.steamId64 = BigInt(identity.steamId64);
  if (Object.keys(updates).length === 0) return;
  updates.updatedAt = new Date();
  try {
    await db.update(players).set(updates).where(eq(players.id, existing.id));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/**
 * Supplies ids for a combatant the log names without any, from the live
 * roster: exactly one roster member with that name gives its EOS id/SteamID,
 * several make the name ambiguous (`null`), none leaves the name as is.
 */
function identityFromRoster(
  identity: CombatIdentity,
  roster: RosterTeamMember[],
): CombatIdentity | null {
  if (identity.eosId || identity.steamId64) return identity;
  const normalized = normalizePlayerName(identity.name);
  const onRoster = roster.filter(
    (member) => member.name && normalizePlayerName(member.name) === normalized,
  );
  if (onRoster.length > 1) return null;
  const member = onRoster[0];
  if (!member || (!member.eos_id && !member.steam_id64)) return identity;
  return {
    eosId: member.eos_id ?? null,
    steamId64: member.steam_id64 ? String(member.steam_id64) : null,
    name: identity.name,
  };
}

async function resolveOrCreatePlayer(
  db: DatabaseClient,
  combatant: CombatIdentity | null,
  roster: RosterTeamMember[] = [],
): Promise<string | null> {
  if (!combatant) return null;
  const identity = identityFromRoster(combatant, roster);
  if (!identity) return null;
  const hasIds = Boolean(identity.eosId || identity.steamId64);
  if (hasIds) {
    const existing = await resolveByIdentity(db, {
      eosId: identity.eosId,
      steamId64: identity.steamId64,
    });
    if (existing) {
      await backfillIdentity(db, existing, identity);
      return existing.id;
    }
    return createPlayer(db, identity);
  }
  return resolveByName(db, identity.name);
}

/** Reads the live roster snapshot worker-rcon caches; empty when absent or unreadable. */
async function loadRoster(
  redis: CombatRedis | null,
  serverId: string,
): Promise<RosterTeamMember[]> {
  if (!redis) return [];
  try {
    const raw = await redis.get(`rcon:roster:${serverId}`);
    if (!raw) return [];
    const snapshot = JSON.parse(raw) as { players?: RosterTeamMember[] };
    return Array.isArray(snapshot.players) ? snapshot.players : [];
  } catch {
    return [];
  }
}

async function resolveMatchId(
  db: DatabaseClient,
  serverId: string,
  occurredAt: Date,
): Promise<string | null> {
  const rows = await db
    .select({ id: matches.id })
    .from(matches)
    .where(
      and(
        eq(matches.serverId, serverId),
        lte(matches.startedAt, occurredAt),
        or(isNull(matches.endedAt), gte(matches.endedAt, occurredAt)),
      ),
    )
    .orderBy(desc(matches.startedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

function deterministicEventId(command: CombatRecordCommand): string {
  const key = [
    command.serverId,
    command.kind,
    command.ts,
    command.tick,
    command.attacker?.name ?? '',
    command.victim.name,
    command.weapon ?? '',
    command.damage ?? '',
  ].join('|');
  return uuidv5(key, COMBAT_EVENT_NAMESPACE);
}

function buildPayload(
  command: CombatRecordCommand,
  attackerPlayerId: string | null,
  victimPlayerId: string | null,
  isTeamkill: boolean,
  matchId: string | null,
): Record<string, unknown> {
  if (command.kind === 'combat_revive') {
    return {
      match_id: matchId,
      medic_player_id: attackerPlayerId,
      revived_player_id: victimPlayerId,
      medic_name: command.attacker?.name ?? null,
      revived_name: command.victim.name,
    };
  }
  return {
    match_id: matchId,
    attacker_player_id: attackerPlayerId,
    victim_player_id: victimPlayerId,
    attacker_name: command.attacker?.name ?? null,
    victim_name: command.victim.name,
    weapon: command.weapon,
    damage: command.damage,
    attacker_vehicle: command.attackerVehicle,
    is_teamkill: isTeamkill,
    is_suicide: command.isSuicide,
  };
}

export async function handleCombat(
  db: DatabaseClient,
  redis: CombatRedis | null,
  command: CombatRecordCommand,
): Promise<HandleCombatResult> {
  const occurredAt = new Date(command.ts);
  const roster = await loadRoster(redis, command.serverId);
  const attackerPlayerId = await resolveOrCreatePlayer(db, command.attacker, roster);
  const victimPlayerId = await resolveOrCreatePlayer(db, command.victim, roster);
  // The parser's isSuicide only has the two combatants' names/ids to compare
  // (Squad's Wound/Die lines never carry a victim id segment — see
  // parser/combat.ts), so it can miss a self-damage line whose attacker
  // segment is a controller name that differs from the victim's display
  // name. Once both sides resolve to the same DB player row, treat it as a
  // suicide regardless, so it is never counted as a teamkill (#63 finding 922).
  const isSuicide =
    command.isSuicide || (attackerPlayerId !== null && attackerPlayerId === victimPlayerId);

  const teamIndex = buildTeamIndex(roster);
  const isTeamkill = !isSuicide && detectTeamkill(command, teamIndex);
  const matchId = await resolveMatchId(db, command.serverId, occurredAt);

  const eventId = deterministicEventId(command);
  const payload = buildPayload(
    { ...command, isSuicide },
    attackerPlayerId,
    victimPlayerId,
    isTeamkill,
    matchId,
  );
  const eventType = COMBAT_KIND_TO_EVENT_TYPE[command.kind];

  // DOSSIER-2 (#189): the events envelope, the typed combat_events row and the
  // dossier aggregate fold commit atomically. The fold runs only when the events
  // insert actually inserted (onConflictDoNothing returns [] on replay), so a
  // redelivered line never double-counts. The resolved match goes to
  // combat_events.match_uuid; the legacy bigint match_id is never written.
  let wasInserted = false;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(events)
      .values({
        eventId,
        serverId: command.serverId,
        occurredAt,
        kind: command.kind,
        version: 1,
        actorKind: 'system',
        actorId: attackerPlayerId,
        correlationId: matchId,
        payload,
      })
      .onConflictDoNothing({ target: [events.eventId, events.occurredAt] })
      .returning({ eventId: events.eventId });

    wasInserted = inserted.length > 0;
    if (!wasInserted) return;

    await tx.insert(combatEvents).values({
      eventType,
      serverId: command.serverId,
      matchUuid: matchId,
      attackerPlayerId,
      victimPlayerId,
      victimVehicle: null,
      attackerVehicle: command.attackerVehicle,
      weapon: command.weapon,
      damage: command.damage != null ? String(command.damage) : null,
      attackerKit: null,
      isTeamkill,
      occurredAt,
    });

    await applyCombatEventToDossier(tx, {
      eventType,
      attackerPlayerId,
      weapon: command.weapon,
      attackerVehicle: command.attackerVehicle,
      victimVehicle: null,
      damage: command.damage,
      isTeamkill,
      occurredAt,
    });
  });

  if (wasInserted && redis) {
    const frame = JSON.stringify({
      type: 'combat.event',
      ts: new Date().toISOString(),
      data: {
        server_id: command.serverId,
        match_id: matchId,
        kind: command.kind,
        attacker_player_id: attackerPlayerId,
        victim_player_id: victimPlayerId,
        weapon: command.weapon,
        damage: command.damage,
        attacker_vehicle: command.attackerVehicle,
        is_teamkill: isTeamkill,
        is_suicide: isSuicide,
        occurred_at: occurredAt.toISOString(),
      },
    });
    await redis.publish(LIVE_BUS_CHANNEL, frame);
  }

  return {
    eventId,
    kind: command.kind,
    inserted: wasInserted,
    attackerPlayerId,
    victimPlayerId,
    isTeamkill,
    matchId,
  };
}

export interface HandleVehicleResult {
  eventId: string;
  kind: VehicleRecordCommand['kind'];
  inserted: boolean;
  attackerPlayerId: string | null;
  victimVehicle: string;
  attackerVehicle: string | null;
  matchId: string | null;
}

function deterministicVehicleEventId(command: VehicleRecordCommand): string {
  const key = [
    command.serverId,
    command.kind,
    command.ts,
    command.tick,
    command.attacker?.name ?? '',
    command.victimVehicle,
    command.weapon ?? '',
    command.damage ?? '',
  ].join('|');
  return uuidv5(key, COMBAT_EVENT_NAMESPACE);
}

export async function handleVehicle(
  db: DatabaseClient,
  redis: CombatRedis | null,
  command: VehicleRecordCommand,
): Promise<HandleVehicleResult> {
  const occurredAt = new Date(command.ts);
  const attackerPlayerId = await resolveOrCreatePlayer(db, command.attacker);
  const matchId = await resolveMatchId(db, command.serverId, occurredAt);
  const eventId = deterministicVehicleEventId(command);

  const payload = {
    match_id: matchId,
    attacker_player_id: attackerPlayerId,
    attacker_name: command.attacker?.name ?? null,
    victim_vehicle: command.victimVehicle,
    attacker_vehicle: command.attackerVehicle,
    weapon: command.weapon,
    damage: command.damage,
  };
  const eventType = VEHICLE_KIND_TO_EVENT_TYPE[command.kind];

  // DOSSIER-2 (#189): same atomic envelope + combat_events + aggregate fold as
  // handleCombat. Vehicle victims are not players, so victim_player_id is NULL.
  let wasInserted = false;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(events)
      .values({
        eventId,
        serverId: command.serverId,
        occurredAt,
        kind: command.kind,
        version: 1,
        actorKind: 'system',
        actorId: attackerPlayerId,
        correlationId: matchId,
        payload,
      })
      .onConflictDoNothing({ target: [events.eventId, events.occurredAt] })
      .returning({ eventId: events.eventId });

    wasInserted = inserted.length > 0;
    if (!wasInserted) return;

    await tx.insert(combatEvents).values({
      eventType,
      serverId: command.serverId,
      matchUuid: matchId,
      attackerPlayerId,
      victimPlayerId: null,
      victimVehicle: command.victimVehicle,
      attackerVehicle: command.attackerVehicle,
      weapon: command.weapon,
      damage: command.damage != null ? String(command.damage) : null,
      attackerKit: null,
      isTeamkill: false,
      occurredAt,
    });

    await applyCombatEventToDossier(tx, {
      eventType,
      attackerPlayerId,
      weapon: command.weapon,
      attackerVehicle: command.attackerVehicle,
      victimVehicle: command.victimVehicle,
      damage: command.damage,
      isTeamkill: false,
      occurredAt,
    });
  });

  if (wasInserted && redis) {
    const frame = JSON.stringify({
      type: 'combat.vehicle',
      ts: new Date().toISOString(),
      data: {
        server_id: command.serverId,
        match_id: matchId,
        kind: command.kind,
        attacker_player_id: attackerPlayerId,
        victim_vehicle: command.victimVehicle,
        attacker_vehicle: command.attackerVehicle,
        weapon: command.weapon,
        damage: command.damage,
        occurred_at: occurredAt.toISOString(),
      },
    });
    await redis.publish(LIVE_BUS_CHANNEL, frame);
  }

  return {
    eventId,
    kind: command.kind,
    inserted: wasInserted,
    attackerPlayerId,
    victimVehicle: command.victimVehicle,
    attackerVehicle: command.attackerVehicle,
    matchId,
  };
}
