import { v7 as uuidv7 } from 'uuid';

export interface EventEnvelope {
  event_id: string;
  version: number;
  type: string;
  server_id: string;
  ts: string;
  actor: { kind: 'system'; id: null };
  correlation_id: null;
  payload: Record<string, unknown>;
}

/** Identity of an online player, as RNSquadJS keeps it in `state.players`. */
export interface KnownPlayer {
  steamID: string;
  name: string;
}

/**
 * Resolves a player by lower-case EOS id. squad-logs' connect/disconnect
 * events carry only part of a player's identity (connect has no name,
 * disconnect has no steam id), so the mappers complete them from here.
 */
export type PlayerLookup = (eosId: string) => KnownPlayer | undefined;

type RawEvent = Record<string, unknown>;
type Mapper = (
  raw: RawEvent,
  findPlayer: PlayerLookup,
) => { type: string; payload: Record<string, unknown> } | null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

// RedpointEOS writes the disconnect's EOS id in upper case; the shared schema
// and every other event use lower case.
const eosIdOf = (value: unknown): string | null => stringOrNull(value)?.toLowerCase() ?? null;

const lookupByEosId = (findPlayer: PlayerLookup, value: unknown): KnownPlayer | undefined => {
  const eosId = eosIdOf(value);
  return eosId === null ? undefined : findPlayer(eosId);
};

// Field names follow the pinned upstream payloads: squad-logs
// (lACTEPUKCl/squad-logs@c0136352, `src/types.ts`) for log events and
// squad-rcon 1.1.8 for CHAT_MESSAGE and the admin-camera events.
const MAPPERS: Record<string, Mapper> = {
  // TPlayerConnected: steamID, eosID, ip, playerController — no name.
  // RNSquadJS refreshes `state.players` before forwarding the event.
  PLAYER_CONNECTED: (r, findPlayer) => ({
    type: 'player.connected',
    payload: {
      steam_id64: stringOrNull(r.steamID),
      eos_id: eosIdOf(r.eosID),
      name: stringOrNull(lookupByEosId(findPlayer, r.eosID)?.name),
      ip: null,
    },
  }),
  // TPlayerDisconnected: eosID, ip, playerController — no steam id.
  PLAYER_DISCONNECTED: (r, findPlayer) => ({
    type: 'player.disconnected',
    payload: {
      steam_id64: stringOrNull(lookupByEosId(findPlayer, r.eosID)?.steamID),
      eos_id: eosIdOf(r.eosID),
      reason: null,
    },
  }),
  PLAYER_DAMAGED: (r) => ({
    type: 'player.damaged',
    payload: {
      attacker: r.attackerName,
      victim: r.victimName,
      weapon: r.weapon,
      damage: r.damage,
    },
  }),
  // TPlayerDied/TPlayerWounded name the attacker only by its ids.
  PLAYER_DIED: (r, findPlayer) => ({
    type: 'player.died',
    payload: {
      attacker: lookupByEosId(findPlayer, r.attackerEOSID)?.name ?? null,
      victim: r.victimName,
      weapon: r.weapon,
    },
  }),
  PLAYER_WOUNDED: (r, findPlayer) => ({
    type: 'player.wounded',
    payload: {
      attacker: lookupByEosId(findPlayer, r.attackerEOSID)?.name ?? null,
      victim: r.victimName,
      weapon: r.weapon,
    },
  }),
  PLAYER_REVIVED: (r) => ({
    type: 'player.revived',
    payload: { reviver: r.reviverName, revived: r.victimName },
  }),
  PLAYER_POSSESS: (r) => ({
    type: 'player.possess',
    payload: { player: r.name, vehicle: r.possessClassname },
  }),
  PLAYER_UNPOSSESS: (r) => ({
    type: 'player.unpossess',
    payload: { player: r.name },
  }),
  // The legacy parser derives these from the match state machine and always
  // emits the same constant transition per event type, so the sidecar can
  // mirror it exactly even though RNSquadJS does not expose the states.
  NEW_GAME: () => ({
    type: 'match.started',
    payload: { from_state: 'WaitingToStart', to_state: 'InProgress' },
  }),
  ROUND_ENDED: () => ({
    type: 'match.ended',
    payload: { from_state: 'InProgress', to_state: 'WaitingPostMatch' },
  }),
  SQUAD_CREATED: (r) => ({
    type: 'squad.created',
    payload: { player: r.name, squad_id: r.squadID, squad_name: r.squadName, team: r.teamName },
  }),
  DEPLOYABLE_DAMAGED: (r) => ({
    type: 'deployable.damaged',
    payload: { deployable: r.deployable, damage: r.damage, attacker: r.name },
  }),
  TICK_RATE: (r) => ({
    type: 'server.tick_rate',
    payload: { tick_rate: r.tickRate },
  }),
  ADMIN_BROADCAST: (r) => ({
    type: 'admin.broadcast',
    payload: { message: r.message },
  }),
  CHAT_MESSAGE: (r) => ({
    type: 'chat.message',
    payload: { channel: r.chat, steam_id: r.steamID, name: r.name, message: r.message },
  }),
  POSSESSED_ADMIN_CAMERA: (r) => ({
    type: 'admin.camera_entered',
    payload: { player: r.name },
  }),
  UNPOSSESSED_ADMIN_CAMERA: (r) => ({
    type: 'admin.camera_left',
    payload: { player: r.name },
  }),
};

const SQUAD_LOG_TIME = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})$/;

/**
 * Parses squad-logs' `YYYY.MM.DD-HH.mm.ss:SSS` time (the SquadGame.log
 * prefix, written in UTC) into epoch milliseconds, or NaN when the string is
 * not in that format or names an impossible date.
 */
function parseSquadLogTime(time: string): number {
  const match = SQUAD_LOG_TIME.exec(time);
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second, millis] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? date.getTime() : Number.NaN;
}

/**
 * Returns the event's own time as an ISO string. squad-logs events carry the
 * Squad log time string, squad-rcon events a `Date`; anything unparseable
 * falls back to the publish time.
 */
function toIsoTimestamp(time: unknown): string {
  let ms = Number.NaN;
  if (time instanceof Date) ms = time.getTime();
  if (typeof time === 'string') {
    ms = SQUAD_LOG_TIME.test(time) ? parseSquadLogTime(time) : Date.parse(time);
  }
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/**
 * Maps one RNSquadJS listener event to the panel's `EventEnvelope`.
 *
 * @param serverId - Panel server UUID the sidecar serves.
 * @param rnType - RNSquadJS event name (`PLAYER_CONNECTED`, …).
 * @param raw - The upstream event object exactly as RNSquadJS emitted it.
 * @param findPlayer - Resolves an online player by lower-case EOS id; used to
 *   fill identity fields the upstream event lacks. Defaults to "unknown".
 * @returns The envelope, or null for event types the panel does not map.
 *   Identity fields that cannot be resolved are null — check
 *   {@link isPublishablePayload} before publishing to a strict consumer.
 */
export function mapEvent(
  serverId: string,
  rnType: string,
  raw: RawEvent,
  findPlayer: PlayerLookup = () => undefined,
): EventEnvelope | null {
  const mapper = MAPPERS[rnType];
  if (!mapper) return null;
  const mapped = mapper(raw, findPlayer);
  if (!mapped) return null;
  return {
    event_id: uuidv7(),
    version: 1,
    type: mapped.type,
    server_id: serverId,
    ts: toIsoTimestamp(raw.time),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: mapped.payload,
  };
}

const STEAM_ID64 = /^\d{17}$/;
const EOS_ID = /^[a-f0-9]{32}$/;

const isSteamId64 = (value: unknown): boolean =>
  typeof value === 'string' && STEAM_ID64.test(value);
const isNullableEosId = (value: unknown): boolean =>
  value === null || (typeof value === 'string' && EOS_ID.test(value));

/**
 * Whether the envelope's payload satisfies the strict schema its type has in
 * `@squad/shared-types` (`playerConnectedPayload`, `playerDisconnectedPayload`),
 * which production consumers enforce. The plugin is bundled into the RNSquadJS
 * image without the workspace packages, so the two schemas are mirrored here;
 * types without a strict schema are always publishable.
 */
export function isPublishablePayload(envelope: Pick<EventEnvelope, 'type' | 'payload'>): boolean {
  const { payload } = envelope;
  if (envelope.type === 'player.connected') {
    return (
      isSteamId64(payload.steam_id64) &&
      isNullableEosId(payload.eos_id) &&
      typeof payload.name === 'string' &&
      payload.name.length >= 1 &&
      payload.name.length <= 128 &&
      (payload.ip === null || typeof payload.ip === 'string')
    );
  }
  if (envelope.type === 'player.disconnected') {
    return (
      isSteamId64(payload.steam_id64) &&
      isNullableEosId(payload.eos_id) &&
      (payload.reason === null || typeof payload.reason === 'string')
    );
  }
  return true;
}
