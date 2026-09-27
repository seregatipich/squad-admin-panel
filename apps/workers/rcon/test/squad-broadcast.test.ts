import { describe, expect, it } from 'vitest';
import { parseSquadCreatedBroadcast } from '../src/squad-broadcast.js';

const EOS = '0002aaaa000000000000000000000001';
const STEAM = '76561199000000001';
const AT = '2026-09-27T21:04:00.000Z';

describe('parseSquadCreatedBroadcast', () => {
  it('parses the notice Squad sends when a squad is created', () => {
    expect(
      parseSquadCreatedBroadcast(
        `PanelAlpha (Online IDs: EOS: ${EOS} steam: ${STEAM}) has created Squad 1 (Squad Name: Panel Squad) on Western Private Military Contractors`,
        AT,
      ),
    ).toEqual({
      creatorName: 'PanelAlpha',
      creatorEosId: EOS,
      creatorSteamId64: STEAM,
      squadId: 1,
      squadName: 'Panel Squad',
      teamName: 'Western Private Military Contractors',
      at: AT,
    });
  });

  it('keeps parentheses inside the player and squad names', () => {
    expect(
      parseSquadCreatedBroadcast(
        `Ivan (RU) (Online IDs: EOS: ${EOS} steam: ${STEAM}) has created Squad 12 (Squad Name: Alpha (2)) on Russian Ground Forces`,
        AT,
      ),
    ).toMatchObject({
      creatorName: 'Ivan (RU)',
      squadId: 12,
      squadName: 'Alpha (2)',
      teamName: 'Russian Ground Forces',
    });
  });

  it('accepts an Epic account without Steam and upper-case hex', () => {
    expect(
      parseSquadCreatedBroadcast(
        `NoSteam (Online IDs: EOS: ${EOS.toUpperCase()}) has created Squad 4 (Squad Name: INF) on United States Army`,
        AT,
      ),
    ).toMatchObject({ creatorEosId: EOS, creatorSteamId64: null });
  });

  it('strips the packet framing', () => {
    expect(
      parseSquadCreatedBroadcast(
        `A (Online IDs: EOS: ${EOS}) has created Squad 2 (Squad Name: B) on C\0\n`,
        AT,
      )?.teamName,
    ).toBe('C');
  });

  it.each([
    `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] PanelAlpha : has created Squad 1 (Squad Name: x) on y`,
    `[Online Ids:EOS: ${EOS} steam: ${STEAM}] PanelAlpha has possessed admin camera.`,
    `PanelAlpha (Online IDs: steam: ${STEAM}) has created Squad 1 (Squad Name: Panel Squad) on USA`,
    'Kicked player 3. Steam: 76561199000000001 PanelAlpha',
    '',
  ])('returns null for a line that is not a creation notice with an EOS id %#', (line) => {
    expect(parseSquadCreatedBroadcast(line, AT)).toBeNull();
  });
});
