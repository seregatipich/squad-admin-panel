import { describe, expect, it } from 'vitest';
import { CHAT_DEDUP_TTL_SECONDS, claimChatLine, claimReport } from '../src/chat/dedupe.js';
import type { ParsedChat } from '../src/parser/chat.js';
import type { ParsedReport } from '../src/parser/report.js';

/** A Redis whose `SET NX EX` behaves like the real one, keeping what it was asked to store. */
function fakeRedis() {
  const keys = new Map<string, number>();
  return {
    keys,
    async set(key: string, _value: string, _mode: 'EX', seconds: number, _flag: 'NX') {
      if (keys.has(key)) return null;
      keys.set(key, seconds);
      return 'OK';
    },
  };
}

const chat: ParsedChat = {
  ts: '2026-10-02T12:00:00.000Z',
  channel: 'ChatAll',
  eosId: 'abcdef0123456789abcdef0123456789',
  steamId64: '76561198012345678',
  playerName: 'Alpha',
  message: '!rules',
};

describe('claimChatLine', () => {
  it('lets the first delivery through and refuses the second', async () => {
    const redis = fakeRedis();
    expect(await claimChatLine(redis, 'srv', chat)).toBe(true);
    expect(await claimChatLine(redis, 'srv', chat)).toBe(false);
    expect([...redis.keys.values()]).toEqual([CHAT_DEDUP_TTL_SECONDS]);
  });

  it('treats the two producers dating the line differently as one line', async () => {
    const redis = fakeRedis();
    expect(await claimChatLine(redis, 'srv', chat)).toBe(true);
    expect(await claimChatLine(redis, 'srv', { ...chat, ts: '2026-10-02T12:00:01.700Z' })).toBe(
      false,
    );
  });

  it('keeps different text, senders, channels and servers apart', async () => {
    const redis = fakeRedis();
    expect(await claimChatLine(redis, 'srv', chat)).toBe(true);
    expect(await claimChatLine(redis, 'srv', { ...chat, message: '!stats' })).toBe(true);
    expect(await claimChatLine(redis, 'srv', { ...chat, eosId: 'f'.repeat(32) })).toBe(true);
    expect(await claimChatLine(redis, 'srv', { ...chat, channel: 'ChatTeam' })).toBe(true);
    expect(await claimChatLine(redis, 'other', chat)).toBe(true);
  });

  it('identifies a sender without ids by name', async () => {
    const redis = fakeRedis();
    const anonymous = { ...chat, eosId: null, steamId64: null };
    expect(await claimChatLine(redis, 'srv', anonymous)).toBe(true);
    expect(await claimChatLine(redis, 'srv', { ...anonymous, playerName: 'Bravo' })).toBe(true);
    expect(await claimChatLine(redis, 'srv', anonymous)).toBe(false);
  });

  it('handles every delivery when Redis is unavailable', async () => {
    expect(await claimChatLine(null, 'srv', chat)).toBe(true);
    expect(await claimChatLine(null, 'srv', chat)).toBe(true);
  });
});

describe('claimReport', () => {
  const report: ParsedReport = {
    ts: '2026-10-02T12:00:00.000Z',
    tick: 0,
    channel: 'ChatAll',
    reporterEos: chat.eosId,
    reporterSteam: chat.steamId64,
    reporterName: 'Alpha',
    targetRaw: 'BadGuy',
    body: 'hacking',
  };

  it('treats the log line and the RCON line of one report as one, whatever their ts and tick', async () => {
    const redis = fakeRedis();
    expect(await claimReport(redis, 'srv', report)).toBe(true);
    expect(
      await claimReport(redis, 'srv', { ...report, ts: '2026-10-02T12:00:01.000Z', tick: 123 }),
    ).toBe(false);
  });

  it('keeps a different target or text apart', async () => {
    const redis = fakeRedis();
    expect(await claimReport(redis, 'srv', report)).toBe(true);
    expect(await claimReport(redis, 'srv', { ...report, targetRaw: 'Other' })).toBe(true);
    expect(await claimReport(redis, 'srv', { ...report, body: 'teamkilling' })).toBe(true);
  });

  it('handles every delivery when Redis is unavailable', async () => {
    expect(await claimReport(null, 'srv', report)).toBe(true);
  });
});
