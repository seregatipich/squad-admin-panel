import { describe, expect, it } from 'vitest';
import { parseRconChatLine } from '../src/chat.js';

const EOS = '0002aaaa000000000000000000000001';
const STEAM = '76561199000000001';

describe('parseRconChatLine', () => {
  it('parses the captured live broadcast line', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] PanelAlpha : hello panel`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed).toEqual({
      ts: '2026-09-09T10:00:00.000Z',
      channel: 'ChatAll',
      eosId: EOS,
      steamId64: STEAM,
      playerName: 'PanelAlpha',
      message: 'hello panel',
    });
  });

  it.each(['ChatAll', 'ChatTeam', 'ChatSquad', 'ChatAdmin'] as const)(
    'parses the %s channel',
    (channel) => {
      const parsed = parseRconChatLine(
        `[${channel}] [Online IDs:EOS: ${EOS} steam: ${STEAM}] PanelAlpha : hi`,
        '2026-09-09T10:00:00.000Z',
      );
      expect(parsed?.channel).toBe(channel);
    },
  );

  it('keeps colons and spaces inside the message body', () => {
    const parsed = parseRconChatLine(
      `[ChatSquad] [Online IDs:EOS: ${EOS} steam: ${STEAM}] Alpha : meet at 12:34 : now`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.playerName).toBe('Alpha');
    expect(parsed?.message).toBe('meet at 12:34 : now');
  });

  it('splits on the first separator when the name itself contains " : "', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] A : B : payload`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.playerName).toBe('A');
    expect(parsed?.message).toBe('B : payload');
  });

  it('tolerates the "Online Ids" casing Squad also emits', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online Ids:EOS: ${EOS.toUpperCase()} steam: ${STEAM}] Casing : yo`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.eosId).toBe(EOS);
  });

  it('parses a steam-only sender', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online IDs:steam: ${STEAM}] OnlySteam : hi`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.steamId64).toBe(STEAM);
    expect(parsed?.eosId).toBeNull();
    expect(parsed?.playerName).toBe('OnlySteam');
  });

  it('reads the ids as unordered pairs, not by position', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online IDs:steam: ${STEAM} EOS: ${EOS}] Reversed : hi`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.eosId).toBe(EOS);
    expect(parsed?.steamId64).toBe(STEAM);
  });

  it('ignores platforms it does not know while keeping the ones it does', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online IDs:xbox: ABC123 EOS: ${EOS} steam: ${STEAM}] Extra : hi`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.eosId).toBe(EOS);
    expect(parsed?.steamId64).toBe(STEAM);
  });

  it('drops a chat line carrying no id the panel can resolve', () => {
    expect(
      parseRconChatLine('[ChatAll] [Online IDs:] Nobody : hi', '2026-09-09T10:00:00.000Z'),
    ).toBeNull();
  });

  it('parses a sender without a steam id', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online IDs:EOS: ${EOS}] NoSteam : hi`,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.steamId64).toBeNull();
    expect(parsed?.playerName).toBe('NoSteam');
  });

  it('keeps an empty message rather than dropping the line', () => {
    const parsed = parseRconChatLine(
      `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] Alpha : `,
      '2026-09-09T10:00:00.000Z',
    );
    expect(parsed?.message).toBe('');
  });

  it.each([
    `[Online Ids:EOS: ${EOS} steam: ${STEAM}] PanelAlpha has possessed admin camera.`,
    `PanelAlpha (Online IDs: EOS: ${EOS} steam: ${STEAM}) has created Squad 1 (Squad Name: Panel Squad) on Western Private Military Contractors`,
    '',
    'Kicked player 3. Steam: 76561199000000001 PanelAlpha',
  ])('returns null for the non-chat broadcast %#', (line) => {
    expect(parseRconChatLine(line, '2026-09-09T10:00:00.000Z')).toBeNull();
  });
});
