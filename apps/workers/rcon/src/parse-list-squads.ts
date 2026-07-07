/**
 * Parse Squad's `ListSquads` RCON response.
 *
 * Output is grouped by team headers. Squad rows do not repeat the team, so the
 * parser carries the latest `Team ID: n (name)` context into subsequent rows.
 */

export interface RconSquad {
  team_id: number;
  team_name: string;
  squad_id: number;
  name: string;
  size: number;
  locked: boolean;
  creator_name: string;
  creator_eos_id: string | null;
  creator_steam_id64: string | null;
  is_command_squad: boolean;
}

const TEAM_HEADER = /^Team ID:\s*(\d+)\s*\((.+)\)\s*$/;
const SQUAD_LINE =
  /^ID:\s*(\d+)\s*\|\s*Name:\s*(.+?)\s*\|\s*Size:\s*(\d+)\s*\|\s*Locked:\s*(True|False)\s*\|\s*Creator Name:\s*(.+?)\s*\|\s*Creator Online IDs:\s*(.+?)\s*$/;
const EOS_ID = /EOS:\s*([0-9a-f]{32})/i;
const STEAM_ID = /steam:\s*(\d{17})/i;

function isCommandSquad(name: string): boolean {
  return name === 'Command Squad' || name === 'Командирский отряд';
}

export function parseListSquads(raw: string): RconSquad[] {
  const squads: RconSquad[] = [];
  let currentTeamId: number | null = null;
  let currentTeamName: string | null = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const team = TEAM_HEADER.exec(line);
    if (team) {
      currentTeamId = Number(team[1]);
      currentTeamName = team[2] as string;
      continue;
    }

    if (currentTeamId === null || currentTeamName === null) continue;

    const squad = SQUAD_LINE.exec(line);
    if (!squad) continue;

    const idsSegment = squad[6] as string;
    const eosMatch = EOS_ID.exec(idsSegment);
    const steamMatch = STEAM_ID.exec(idsSegment);
    const name = (squad[2] as string).trim();

    squads.push({
      team_id: currentTeamId,
      team_name: currentTeamName,
      squad_id: Number(squad[1]),
      name,
      size: Number(squad[3]),
      locked: squad[4] === 'True',
      creator_name: (squad[5] as string).trim(),
      creator_eos_id: eosMatch ? (eosMatch[1] as string).toLowerCase() : null,
      creator_steam_id64: steamMatch ? (steamMatch[1] as string) : null,
      is_command_squad: isCommandSquad(name),
    });
  }

  return squads;
}
