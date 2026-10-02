import { describe, expect, it, vi } from 'vitest';
import { parseListPlayersDetailed } from '../src/parse-list-players.js';
import { parseListSquadsDetailed } from '../src/parse-list-squads.js';
import { parseServerInfo } from '../src/parse-server-info.js';
import { RosterParseGuard } from '../src/supervisor/roster-parse-guard.js';
import type { SupervisorOptions, Target } from '../src/supervisor/types.js';

const EOS = 'abcdef0123456789abcdef0123456789';
const STEAM = '76561198012345678';

function makeGuard() {
  const warn = vi.fn();
  const target = { serverId: 'srv-1' } as Target;
  const opts = { log: { warn } } as unknown as SupervisorOptions;
  return { guard: new RosterParseGuard(target, opts), warn };
}

const playersReply = (...rows: string[]) =>
  [
    '----- Active Players -----',
    ...rows,
    '----- Recently Disconnected Players [Max of 15] -----',
  ].join('\n');

const unreadablePlayerRow = `ID: 1 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name: Secret | Squad: 3 | Role: X`;
const readablePlayerRow = `ID: 1 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name: A | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: R`;
const squadRow = `ID: 1 | Name: S | Size: 1 | Locked: False | Creator Name: Secret | Creator Online IDs: EOS: ${EOS} steam: ${STEAM}`;

describe('RosterParseGuard', () => {
  it('trusts an empty server: no rows is not a parse failure', () => {
    const { guard, warn } = makeGuard();
    const read = guard.inspect(
      parseListPlayersDetailed(playersReply()),
      parseListSquadsDetailed('Team ID: 1 (A) - Tickets: 5\nTeam ID: 2 (B) - Tickets: 5'),
    );
    expect(read).toMatchObject({ playersOk: true, squadsOk: true, problems: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('trusts replies whose rows parse', () => {
    const { guard, warn } = makeGuard();
    const read = guard.inspect(
      parseListPlayersDetailed(playersReply(readablePlayerRow)),
      parseListSquadsDetailed(['Team ID: 1 (A)', squadRow].join('\n')),
    );
    expect(read.playersOk).toBe(true);
    expect(read.squadsOk).toBe(true);
    expect(read.players).toHaveLength(1);
    expect(read.squads).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('flags a ListPlayers reply with rows and no parsed player, with a redacted sample', () => {
    const { guard, warn } = makeGuard();
    const read = guard.inspect(
      parseListPlayersDetailed(playersReply(unreadablePlayerRow)),
      parseListSquadsDetailed(''),
    );
    expect(read).toMatchObject({ playersOk: false, squadsOk: true, problems: ['players'] });
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/ListPlayers/);
    expect(fields).toMatchObject({ serverId: 'srv-1', problem: 'players', rows: 1 });
    const logged = JSON.stringify(fields);
    expect(logged).not.toContain(EOS);
    expect(logged).not.toContain(STEAM);
    expect(logged).not.toContain('Secret');
  });

  it('flags a ListSquads reply with rows and no parsed squad', () => {
    const { guard, warn } = makeGuard();
    const read = guard.inspect(
      parseListPlayersDetailed(playersReply(readablePlayerRow)),
      parseListSquadsDetailed(['Teams: 1 (A)', squadRow].join('\n')),
    );
    expect(read).toMatchObject({ playersOk: true, squadsOk: false, problems: ['squads'] });
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    const logged = JSON.stringify(fields);
    expect(logged).not.toContain('Secret');
    expect(logged).not.toContain(STEAM);
  });

  it('reports both problems and logs each once per minute', () => {
    vi.useFakeTimers();
    try {
      const { guard, warn } = makeGuard();
      const inspect = () =>
        guard.inspect(
          parseListPlayersDetailed(playersReply(unreadablePlayerRow)),
          parseListSquadsDetailed(['Teams: 1 (A)', squadRow].join('\n')),
        );
      expect(inspect().problems).toEqual(['players', 'squads']);
      expect(warn).toHaveBeenCalledTimes(2);
      inspect();
      expect(warn).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(61_000);
      inspect();
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns with the field names when ShowServerInfo yields no map', () => {
    const { guard, warn } = makeGuard();
    const raw = JSON.stringify({ ServerName_s: 'x', LayerName_s: 'Y' });
    guard.inspectServerInfo(raw, parseServerInfo(raw));
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ problem: 'server_info', keys: ['ServerName_s', 'LayerName_s'] });
  });

  it('stays quiet when ShowServerInfo has a map, or the reply is empty', () => {
    const { guard, warn } = makeGuard();
    const raw = JSON.stringify({ MapName_s: 'Gorodok_RAAS_v1' });
    guard.inspectServerInfo(raw, parseServerInfo(raw));
    guard.inspectServerInfo('', null);
    guard.inspectNextMap('', false);
    guard.inspectNextMap('Next level is Fallujah, layer is Fallujah_RAAS_v1', true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when ShowNextMap has an unknown sentence', () => {
    const { guard, warn } = makeGuard();
    guard.inspectNextMap('Upcoming layer: something', false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
