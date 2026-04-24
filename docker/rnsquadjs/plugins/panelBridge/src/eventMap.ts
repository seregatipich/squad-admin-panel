import { v7 as uuidv7 } from 'uuid';

export interface EventEnvelope {
  id: string;
  serverId: string;
  type: string;
  version: number;
  ts: string;
  payload: Record<string, unknown>;
}

type RawEvent = Record<string, unknown>;
type Mapper = (raw: RawEvent) => { type: string; payload: Record<string, unknown> } | null;

const MAPPERS: Record<string, Mapper> = {
  PLAYER_CONNECTED: (r) => ({
    type: 'player.connected',
    payload: { steamId: r.steamID, eosId: r.eosID, name: r.name },
  }),
  PLAYER_DISCONNECTED: (r) => ({
    type: 'player.disconnected',
    payload: { steamId: r.steamID, eosId: r.eosID, name: r.name },
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
  NEW_GAME: (r) => ({
    type: 'match.started',
    payload: { layer: r.layer },
  }),
  ROUND_ENDED: (r) => ({
    type: 'match.ended',
    payload: { winner: r.winner, layer: r.layer },
  }),
  SQUAD_CREATED: (r) => ({
    type: 'squad.created',
    payload: { player: r.player, squadId: r.squadID, squadName: r.squadName, team: r.team },
  }),
  DEPLOYABLE_DAMAGED: (r) => ({
    type: 'deployable.damaged',
    payload: { deployable: r.deployable, damage: r.damage, attacker: r.attacker },
  }),
  TICK_RATE: (r) => ({
    type: 'server.tick_rate',
    payload: { tickRate: r.tickRate },
  }),
  ADMIN_BROADCAST: (r) => ({
    type: 'admin.broadcast',
    payload: { message: r.message },
  }),
  CHAT_MESSAGE: (r) => ({
    type: 'chat.message',
    payload: { channel: r.chat, steamId: r.steamID, name: r.name, message: r.message },
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

export function mapEvent(serverId: string, rnType: string, raw: RawEvent): EventEnvelope | null {
  const mapper = MAPPERS[rnType];
  if (!mapper) return null;
  const mapped = mapper(raw);
  if (!mapped) return null;
  return {
    id: uuidv7(),
    serverId,
    type: mapped.type,
    version: 1,
    ts: typeof raw.time === 'string' ? raw.time : new Date().toISOString(),
    payload: mapped.payload,
  };
}
