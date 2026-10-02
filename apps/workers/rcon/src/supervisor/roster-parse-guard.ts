import type { ListPlayersParse, RconPlayer } from '../parse-list-players.js';
import type { ListSquadsParse, RconSquad } from '../parse-list-squads.js';
import type { SquadServerInfo } from '../parse-server-info.js';
import { redactRconSample } from '../redact.js';
import type { SupervisorOptions, Target } from './types.js';

/** At most one warning per problem per server in this window; polls run every 2 s. */
const WARN_INTERVAL_MS = 60_000;

/** A reply the parsers could not read although it carried rows. */
export type RosterParseProblem = 'players' | 'squads';

/**
 * What a roster refresh may trust. The `*Ok` flags are false when a reply
 * listed rows and none of them parsed: the parser no longer matches Squad's
 * format (it did not on build 25594911, issue #126), so an empty list says
 * nothing about the server.
 */
export interface RosterRead {
  players: RconPlayer[];
  squads: RconSquad[];
  playersOk: boolean;
  squadsOk: boolean;
  /** The problems as published in `rcon:status.roster_parse_error`; `null` when both replies parsed. */
  problems: RosterParseProblem[] | null;
}

/**
 * Detects the silent-zero failure of the roster parsers. A strict regex that
 * stops matching returns `[]`, which the poller used to publish as
 * "0 players, 0 squads" and which {@link SquadHistory.trackSquads} read as every
 * squad disbanding. The guard separates "the server is empty" (no rows) from
 * "the reply is unreadable" (rows, none parsed), logs a redacted sample of the
 * latter once a minute, and tells the poller to keep the last good data.
 */
export class RosterParseGuard {
  private readonly lastWarnAt = new Map<string, number>();

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {}

  /**
   * Judges one `ListPlayers` + `ListSquads` pair.
   *
   * @param players - the parsed `ListPlayers` reply
   * @param squads - the parsed `ListSquads` reply
   * @returns the lists plus whether each can be trusted
   */
  inspect(players: ListPlayersParse, squads: ListSquadsParse): RosterRead {
    const problems: RosterParseProblem[] = [];
    if (players.activeRows > 0 && players.players.length === 0) {
      problems.push('players');
      this.warn('players', 'ListPlayers reply has rows but none parsed', {
        rows: players.activeRows,
        sample: redactRconSample(players.unparsedRows),
      });
    }
    if (squads.squadRows > 0 && squads.squads.length === 0) {
      problems.push('squads');
      this.warn('squads', 'ListSquads reply has rows but none parsed', {
        rows: squads.squadRows,
        sample: redactRconSample(squads.unparsedRows),
      });
    }
    return {
      players: players.players,
      squads: squads.squads,
      playersOk: !problems.includes('players'),
      squadsOk: !problems.includes('squads'),
      problems: problems.length > 0 ? problems : null,
    };
  }

  /**
   * Notes a `ShowServerInfo` / `ShowNextMap` reply that carried text but yielded
   * no map. The stale map the panel kept showing after build 25594911 could be a
   * renamed field; the keys name it without logging any value.
   *
   * @param rawInfo - the raw `ShowServerInfo` reply
   * @param info - its parse, `null` when it was not a JSON object
   */
  inspectServerInfo(rawInfo: string, info: SquadServerInfo | null): void {
    if (!rawInfo.trim() || info?.map_name) return;
    this.warn('server_info', 'ShowServerInfo reply yielded no map name', {
      keys: topLevelKeys(rawInfo),
      sample: info === null ? redactRconSample([rawInfo.trim()], 1) : undefined,
    });
  }

  /**
   * @param rawNextMap - the raw `ShowNextMap` reply
   * @param parsed - whether it matched the known sentence
   */
  inspectNextMap(rawNextMap: string, parsed: boolean): void {
    if (!rawNextMap.trim() || parsed) return;
    this.warn('next_map', 'ShowNextMap reply did not match the known format', {
      sample: redactRconSample([rawNextMap.trim()], 1),
    });
  }

  private warn(key: string, message: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    const last = this.lastWarnAt.get(key);
    if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
    this.lastWarnAt.set(key, now);
    this.opts.log.warn({ serverId: this.target.serverId, problem: key, ...fields }, message);
  }
}

function topLevelKeys(raw: string): string[] | undefined {
  try {
    const doc: unknown = JSON.parse(raw);
    return doc && typeof doc === 'object' ? Object.keys(doc).slice(0, 60) : undefined;
  } catch {
    return undefined;
  }
}
