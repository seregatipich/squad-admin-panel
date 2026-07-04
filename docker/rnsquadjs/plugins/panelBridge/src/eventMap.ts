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

type RawEvent = Record<string, unknown>;
type Mapper = (raw: RawEvent) => { type: string; payload: Record<string, unknown> } | null;

const MAPPERS: Record<string, Mapper> = {
  PLAYER_CONNECTED: (r) => ({
    type: 'player.connected',
    payload: { steam_id64: r.steamID, eos_id: r.eosID, name: r.name, ip: null },
  }),
  PLAYER_DISCONNECTED: (r) => ({
    type: 'player.disconnected',
    payload: { steam_id64: r.steamID, eos_id: r.eosID, reason: null },
  }),
  PLAYER_DAMAGED: (r) => ({
    type: 'player.damaged',
    payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon, damage: r.damage },
  }),
  PLAYER_DIED: (r) => ({
    type: 'player.died',
    payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon },
  }),
  PLAYER_WOUNDED: (r) => ({
    type: 'player.wounded',
    payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon },
  }),
  PLAYER_REVIVED: (r) => ({
    type: 'player.revived',
    payload: { reviver: r.reviver, revived: r.revived },
  }),
  PLAYER_POSSESS: (r) => ({
    type: 'player.possess',
    payload: { player: r.player, vehicle: r.possessClassname },
  }),
  PLAYER_UNPOSSESS: (r) => ({
    type: 'player.unpossess',
    payload: { player: r.player, vehicle: r.possessClassname },
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
    payload: { player: r.player, squad_id: r.squadID, squad_name: r.squadName, team: r.team },
  }),
  DEPLOYABLE_DAMAGED: (r) => ({
    type: 'deployable.damaged',
    payload: { deployable: r.deployable, damage: r.damage, attacker: r.attacker },
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
    payload: { player: r.player },
  }),
  UNPOSSESSED_ADMIN_CAMERA: (r) => ({
    type: 'admin.camera_left',
    payload: { player: r.player },
  }),
};

function toIsoTimestamp(time: unknown): string {
  if (typeof time === 'string' || time instanceof Date) {
    const ms = new Date(time).getTime();
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

export function mapEvent(serverId: string, rnType: string, raw: RawEvent): EventEnvelope | null {
  const mapper = MAPPERS[rnType];
  if (!mapper) return null;
  const mapped = mapper(raw);
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
