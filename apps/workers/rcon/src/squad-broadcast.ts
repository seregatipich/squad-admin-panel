/**
 * Squad-creation notices from RCON.
 *
 * Squad pushes an unsolicited packet to every authenticated RCON client when a
 * player creates a squad:
 *
 *   <name> (Online IDs: EOS: <eos32> steam: <steam17>) has created Squad <n> (Squad Name: <name>) on <team faction>
 *
 * It is the only exact creation clock. The roster refresh that first lists the
 * squad can come up to one refresh interval later, so `PerServerSupervisor`
 * queues parsed notices for the next `diffSquads` call (see `squad-tracker.ts`).
 */
import { parseOnlineIds } from './chat.js';

export interface SquadCreatedBroadcast {
  creatorName: string;
  creatorEosId: string;
  creatorSteamId64: string | null;
  squadId: number;
  squadName: string;
  /** The faction as Squad names it (`on <team faction>`); the notice carries no team id. */
  teamName: string;
  /** ISO-8601 receive time; the notice carries no clock of its own. */
  at: string;
}

/**
 * The squad name is greedy so a name containing `)` backtracks to the last
 * `) on `; the player name is lazy so a name containing `(` stops at the
 * identity block.
 */
const SQUAD_CREATED =
  /^(?<name>.+?) \(Online IDs?:(?<ids>[^)]*)\) has created Squad (?<squadId>\d+) \(Squad Name: (?<squadName>.*)\) on (?<teamName>.+)$/i;

/**
 * Parse one RCON broadcast body as a squad-creation notice.
 *
 * @param body - Raw packet body as Squad sent it.
 * @param at - ISO-8601 receive timestamp.
 * @returns The notice, or `null` when the body is anything else or carries no
 *   EOS id (squad history is keyed by EOS id).
 */
export function parseSquadCreatedBroadcast(body: string, at: string): SquadCreatedBroadcast | null {
  const groups = SQUAD_CREATED.exec(body.replace(/[\0\r\n]+$/, ''))?.groups;
  if (!groups) return null;
  const { eosId, steamId64 } = parseOnlineIds(groups.ids ?? '');
  if (!eosId) return null;
  const creatorName = (groups.name ?? '').trim();
  if (creatorName === '') return null;
  return {
    creatorName,
    creatorEosId: eosId,
    creatorSteamId64: steamId64,
    squadId: Number(groups.squadId),
    squadName: (groups.squadName ?? '').trim(),
    teamName: (groups.teamName ?? '').trim(),
    at,
  };
}
