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
  PLAYER_CONNECTED: (raw) => ({
    type: 'player.connected',
    payload: { steamId: raw.steamID, eosId: raw.eosID, name: raw.name },
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
