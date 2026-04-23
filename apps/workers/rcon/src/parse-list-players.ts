/**
 * Parse Squad's `ListPlayers` RCON response. Sample (with 0 players):
 *   ----- Active Players -----
 *   ----- Recently Disconnected Players [Max of 15] -----
 *
 * With players (the structure is the same; name can contain any characters):
 *   ----- Active Players -----
 *   ID: 0 | Online IDs: EOS: abcdef0123456789abcdef0123456789 Steam: 76561198012345678 | Name: Alpha | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01
 *   ----- Recently Disconnected Players [Max of 15] -----
 *   ID: 2 | Online IDs: EOS: .... Steam: ... | Since Disconnect: 05m.32s | Name: Gone
 */

export interface RconPlayer {
  rcon_id: number;
  eos_id: string;
  steam_id64: string;
  name: string;
  team_id: number | null;
  squad_id: number | null;
  is_leader: boolean | null;
  role: string | null;
}

const ACTIVE_HEADER = /^-----\s*Active Players\s*-----$/;
const DISCONNECTED_HEADER = /^-----\s*Recently Disconnected Players/;
const PLAYER_LINE =
  /^ID:\s*(\d+)\s*\|\s*Online IDs:\s*EOS:\s*([a-f0-9]{32})\s*Steam:\s*(\d{17})\s*\|\s*Name:\s*(.+?)\s*\|\s*Team ID:\s*(\d+)\s*\|\s*Squad ID:\s*(\d+|N\/A)\s*\|\s*Is Leader:\s*(True|False)\s*\|\s*Role:\s*(\S+)\s*$/;

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
    players.push({
      rcon_id: Number(m[1]),
      eos_id: m[2] as string,
      steam_id64: m[3] as string,
      name: m[4] as string,
      team_id: Number(m[5]),
      squad_id: m[6] === 'N/A' ? null : Number(m[6]),
      is_leader: m[7] === 'True',
      role: m[8] as string,
    });
  }
  return players;
}
