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
 * Squad build 25594911 (2026-10-01) added a `Party ID: <n|N/A|#n>` field between
 * `Team ID` and `Squad ID` and a trailing `Vehicle: <name|N/A>` field after `Role`:
 *   ID: 60 | Online IDs: EOS: ... steam: ... | Name:  -quic | Team ID: 2 | Party ID: N/A | Squad ID: 1 | Is Leader: False | Role: USA_Medic_02 | Vehicle: N/A
 * Both are optional here so the old format keeps parsing.
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
  /^ID:\s*(\d+)\s*\|\s*Online IDs:\s*(.+?)\s*\|\s*Name:\s*(.+?)\s*\|\s*Team ID:\s*(\d+|N\/A)\s*(?:\|\s*Party ID:\s*[^|]*?\s*)?\|\s*Squad ID:\s*(\d+|N\/A)\s*\|\s*Is Leader:\s*(True|False)\s*\|\s*Role:\s*(.+?)\s*(?:\|\s*Vehicle:\s*.*?)?\s*$/;
/** Any row of the active section; counts what the reply carried even when {@link PLAYER_LINE} reads none of it. */
const PLAYER_ROW = /^ID:\s*\d+\b/;
const EOS_ID = /EOS:\s*([0-9a-f]{32})/i;
const STEAM_ID = /steam:\s*(\d{17})/i;

function parseIdOrNull(raw: string): number | null {
  return raw === 'N/A' ? null : Number(raw);
}

/** What one `ListPlayers` reply held, including the rows the parser could not read. */
export interface ListPlayersParse {
  players: RconPlayer[];
  /** Rows (`ID: n ...`) listed under the active header. */
  activeRows: number;
  /** Active rows no known layout matched; raw, so redact before logging (`redactRconSample`). */
  unparsedRows: string[];
}

export function parseListPlayersDetailed(raw: string): ListPlayersParse {
  const players: RconPlayer[] = [];
  const unparsedRows: string[] = [];
  let activeRows = 0;
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
    const isRow = PLAYER_ROW.test(line);
    if (isRow) activeRows += 1;
    const m = PLAYER_LINE.exec(line);
    const eosMatch = m ? EOS_ID.exec(m[2] as string) : null;
    if (!m || !eosMatch) {
      if (isRow) unparsedRows.push(line);
      continue;
    }
    const steamMatch = STEAM_ID.exec(m[2] as string);
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
  return { players, activeRows, unparsedRows };
}

export function parseListPlayers(raw: string): RconPlayer[] {
  return parseListPlayersDetailed(raw).players;
}
