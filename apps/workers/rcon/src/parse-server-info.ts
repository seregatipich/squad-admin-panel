/**
 * Parse Squad's `ShowServerInfo` RCON response.
 *
 * The reply is a JSON document with `_s` / `_I` / `_f` / `_b` suffixed keys
 * (Squad's UE4 FName convention leaks through RCON). Unknown fields are
 * ignored so newer Squad builds don't break the parser.
 *
 * Sample (truncated):
 *   {"MaxPlayers":100,"PlayerCount_I":"42","ServerName_s":"...",
 *    "MapName_s":"CAF_Goose_Bay_AAS_v1","GameMode_s":"AAS",
 *    "NextLayer_s":"Fallujah_RAAS_v1","ServerTickRate":49.5}
 */

export interface SquadServerInfo {
  server_name: string | null;
  map_name: string | null;
  next_layer: string | null;
  game_mode: string | null;
  game_version: string | null;
  player_count: number | null;
  max_players: number | null;
  public_queue: number | null;
  reserved_queue: number | null;
  team_one: string | null;
  team_two: string | null;
  tickrate: number | null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseServerInfo(raw: string): SquadServerInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  return {
    server_name: asString(d.ServerName_s),
    map_name: asString(d.MapName_s) ?? asString(d.CurrentMap_s),
    next_layer: asString(d.NextLayer_s) ?? asString(d.NextMap_s),
    game_mode: asString(d.GameMode_s),
    game_version: asString(d.GameVersion_s),
    player_count: asNumber(d.PlayerCount_I) ?? asNumber(d.PlayerCount),
    max_players: asNumber(d.MaxPlayers) ?? asNumber(d.MaxPlayers_I),
    public_queue: asNumber(d.PublicQueue_I),
    reserved_queue: asNumber(d.ReservedQueue_I),
    team_one: asString(d.TeamOne_s),
    team_two: asString(d.TeamTwo_s),
    tickrate: asNumber(d.ServerTickRate) ?? asNumber(d.Tickrate),
  };
}
