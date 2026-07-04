import { describe, expect, it } from 'vitest';
import { parseChatLine } from '../src/parser/chat.js';

const EOS = '0002a10186d9414496bf20d22d3860ba';
const STEAM = '76561198012345678';
const SENDER = `${STEAM} [Online IDs: EOS: ${EOS} steam: ${STEAM}] Alpha Player`;

describe('parseChatLine', () => {
  it('extracts channel, eos, steam, name and message from a modern ChatAll line', () => {
    const raw = `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : hello everyone`;
    const parsed = parseChatLine(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.channel).toBe('ChatAll');
    expect(parsed?.eosId).toBe(EOS);
    expect(parsed?.steamId64).toBe(STEAM);
    expect(parsed?.playerName).toBe('Alpha Player');
    expect(parsed?.message).toBe('hello everyone');
    expect(parsed?.ts).toBe('2026-04-23T11:30:20.485Z');
  });

  it('parses each chat channel', () => {
    for (const channel of ['ChatAll', 'ChatTeam', 'ChatSquad', 'ChatAdmin'] as const) {
      const raw = `[2026.04.23-11.30.20:485][10]LogSquad: ChatMessage: ${SENDER} : ${channel} : ping`;
      expect(parseChatLine(raw)?.channel).toBe(channel);
    }
  });

  it('supports an EOS-only sender with no steam id in the Online IDs block', () => {
    const raw = `[2026.04.23-11.31.00:000][10]LogSquad: ChatMessage: [Online IDs: EOS: ${EOS}] SoloEos : ChatTeam : need medic`;
    const parsed = parseChatLine(raw);
    expect(parsed?.eosId).toBe(EOS);
    expect(parsed?.steamId64).toBeNull();
    expect(parsed?.playerName).toBe('SoloEos');
    expect(parsed?.message).toBe('need medic');
    expect(parsed?.channel).toBe('ChatTeam');
  });

  it('parses a legacy name-only chat line without online ids under LogChat', () => {
    const raw =
      '[2026.04.23-11.32.00:000][10]LogChat: ChatMessage: PlainName : ChatSquad : move up';
    const parsed = parseChatLine(raw);
    expect(parsed?.eosId).toBeNull();
    expect(parsed?.steamId64).toBeNull();
    expect(parsed?.playerName).toBe('PlainName');
    expect(parsed?.channel).toBe('ChatSquad');
    expect(parsed?.message).toBe('move up');
  });

  it('preserves colons and punctuation inside the message body', () => {
    const raw = `[2026.04.23-11.33.00:000][10]LogSquad: ChatMessage: ${SENDER} : ChatAll : meet at grid 12:34 now!`;
    expect(parseChatLine(raw)?.message).toBe('meet at grid 12:34 now!');
  });

  it('surfaces admin command chat like !report as a normal chat message', () => {
    const raw = `[2026.04.23-11.34.00:000][10]LogSquad: ChatMessage: ${SENDER} : ChatAll : !report BadGuy team killing`;
    const parsed = parseChatLine(raw);
    expect(parsed?.channel).toBe('ChatAll');
    expect(parsed?.message).toBe('!report BadGuy team killing');
    expect(parsed?.playerName).toBe('Alpha Player');
  });

  it('lowercases an uppercase EOS id from the Online IDs block', () => {
    const upper = EOS.toUpperCase();
    const raw = `[2026.04.23-11.35.00:000][10]LogSquad: ChatMessage: [Online IDs: EOS: ${upper} steam: ${STEAM}] Casing : ChatAll : yo`;
    expect(parseChatLine(raw)?.eosId).toBe(EOS);
  });

  it('returns null for a non-chat LogSquad line', () => {
    const raw = '[2026.04.23-11.30.20:485][123]LogSquad: ADMIN COMMAND: Kick applied from RCON';
    expect(parseChatLine(raw)).toBeNull();
  });

  it('returns null for a chat line whose message body is empty', () => {
    const raw = `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : `;
    expect(parseChatLine(raw)).toBeNull();
  });

  it('returns null for a line that fails the timestamp prefix', () => {
    expect(parseChatLine('not a squad log line at all')).toBeNull();
  });

  it('ignores an unrecognised chat channel token', () => {
    const raw = `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatWhisper : secret`;
    expect(parseChatLine(raw)).toBeNull();
  });
});
