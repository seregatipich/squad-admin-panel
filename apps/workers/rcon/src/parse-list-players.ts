/**
 * Parse Squad's `ListPlayers` RCON response. Sample (with 0 players):
 *   ----- Active Players -----
 *   ----- Recently Disconnected Players [Max of 15] -----
 *
 * With players (the structure is the same; name can contain any characters):
 *   ----- Active Players -----
 *   ID: 0 | Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198012345678 | Name: Alpha | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01
 *   ----- Recently Disconnected Players [Max of 15] -----
 *   ID: 2 | Online IDs: EOS: .... steam: ... | Since Disconnect: 05m.32s | Name: Gone
 *
 * A player may be present with an EOS ID but no linked Steam account (an Epic
 * account that has never linked Steam). Those rows carry only `EOS: <id>` in the
 * Online IDs segment; `steam_id64` is `null` for them but they still appear in
 * the roster.
 */

export interface RconPlayer {
  rcon_id: number;
  eos_id: string;
  steam_id64: string | null;
  name: string;
  team_id: number | null;
  squad_id: number | null;
  is_leader: boolean | null;
  role: string | null;
}

const ACTIVE_HEADER = /^-----\s*Active Players\s*-----$/;
const DISCONNECTED_HEADER = /^-----\s*Recently Disconnected Players/;
const PLAYER_LINE =
  /^ID:\s*(\d+)\s*\|\s*Online IDs:\s*(.+?)\s*\|\s*Name:\s*(.+?)\s*\|\s*Team ID:\s*(\d+|N\/A)\s*\|\s*Squad ID:\s*(\d+|N\/A)\s*\|\s*Is Leader:\s*(True|False)\s*\|\s*Role:\s*(.+?)\s*$/;
const EOS_ID = /EOS:\s*([0-9a-f]{32})/i;
const STEAM_ID = /steam:\s*(\d{17})/i;

function parseIdOrNull(raw: string): number | null {
  return raw === 'N/A' ? null : Number(raw);
}

export function parseListPlayers(raw: string): RconPlayer[] {
  const players: RconPlayer[] = [];
  let inActive = false;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (ACTIVE_HEADER.test(line)) {
      inActive = true;
      continue;
    }
    if (DISCONNECTED_HEADER.test(line)) {
      inActive = false;
      continue;
    }
    if (!inActive) continue;
    const m = PLAYER_LINE.exec(line);
    if (!m) continue;
    const idsSegment = m[2] as string;
    const eosMatch = EOS_ID.exec(idsSegment);
    if (!eosMatch) continue;
    const steamMatch = STEAM_ID.exec(idsSegment);
    players.push({
      rcon_id: Number(m[1]),
      eos_id: (eosMatch[1] as string).toLowerCase(),
      steam_id64: steamMatch ? (steamMatch[1] as string) : null,
      name: m[3] as string,
      team_id: parseIdOrNull(m[4] as string),
      squad_id: parseIdOrNull(m[5] as string),
      is_leader: m[6] === 'True',
      role: m[7] as string,
    });
  }
  return players;
}
