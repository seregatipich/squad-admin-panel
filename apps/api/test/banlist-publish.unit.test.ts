import { describe, expect, it } from 'vitest';
import {
  buildBanlistEntries,
  formatSquadBansCfg,
  type ModerationBanRow,
  parseBanLengthToExpiry,
} from '../src/lib/banlist-publish.js';

const ISSUED_AT = new Date('2026-01-01T00:00:00.000Z');

function row(overrides: Partial<ModerationBanRow> & { playerId: string }): ModerationBanRow {
  return {
    steamId64: '76561198000000001',
    eosId: null,
    nickname: 'Cheater',
    reason: 'aimbot',
    banLength: '0',
    issuedAt: ISSUED_AT,
    revertedAt: null,
    admin: 'AdminX',
    ...overrides,
  };
}

describe('parseBanLengthToExpiry', () => {
  it("'0' is permanent", () => {
    expect(parseBanLengthToExpiry('0', ISSUED_AT)).toBeNull();
  });

  it('missing/empty ban_length is treated as permanent', () => {
    expect(parseBanLengthToExpiry(null, ISSUED_AT)).toBeNull();
    expect(parseBanLengthToExpiry(undefined, ISSUED_AT)).toBeNull();
    expect(parseBanLengthToExpiry('', ISSUED_AT)).toBeNull();
  });

  it('malformed ban_length is treated as permanent', () => {
    expect(parseBanLengthToExpiry('not-a-length', ISSUED_AT)).toBeNull();
  });

  it("'7d' resolves to 7 days after issuedAt", () => {
    const result = parseBanLengthToExpiry('7d', ISSUED_AT);
    expect(result).toEqual(new Date(ISSUED_AT.getTime() + 7 * 86_400_000));
  });

  it("'30m' resolves to 30 minutes after issuedAt", () => {
    const result = parseBanLengthToExpiry('30m', ISSUED_AT);
    expect(result).toEqual(new Date(ISSUED_AT.getTime() + 30 * 60_000));
  });

  it("'1M' resolves to ~1 month after issuedAt", () => {
    const result = parseBanLengthToExpiry('1M', ISSUED_AT);
    expect(result).toEqual(new Date(ISSUED_AT.getTime() + 2_592_000_000));
  });

  it("'2y' resolves to ~2 years after issuedAt", () => {
    const result = parseBanLengthToExpiry('2y', ISSUED_AT);
    expect(result).toEqual(new Date(ISSUED_AT.getTime() + 2 * 31_536_000_000));
  });

  it("bare '3' (no suffix) is treated as 3 days", () => {
    const result = parseBanLengthToExpiry('3', ISSUED_AT);
    expect(result).toEqual(new Date(ISSUED_AT.getTime() + 3 * 86_400_000));
  });

  it('a ban_length too large for a Date is permanent, not an Invalid Date (#66)', () => {
    expect(parseBanLengthToExpiry('300000y', ISSUED_AT)).toBeNull();
    expect(parseBanLengthToExpiry('9'.repeat(400), ISSUED_AT)).toBeNull();
  });

  it('keeps publishing a ban whose ban_length overflows the Date range (#66)', () => {
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', banLength: '300000y' })],
      'all_active',
      new Date('2026-06-01T00:00:00.000Z'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.expiresAt).toBeNull();
  });
});

describe('formatSquadBansCfg', () => {
  it('formats a permanent ban as expiry 0', () => {
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', banLength: '0' })],
      'all_active',
      ISSUED_AT,
    );
    expect(formatSquadBansCfg(entries)).toBe('Banned:76561198000000001:0 // aimbot\n');
  });

  it('formats a temporary ban with the unix expiry timestamp', () => {
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', banLength: '7d' })],
      'all_active',
      ISSUED_AT,
    );
    const expectedExpiry = Math.floor((ISSUED_AT.getTime() + 7 * 86_400_000) / 1000);
    expect(formatSquadBansCfg(entries)).toBe(
      `Banned:76561198000000001:${expectedExpiry} // aimbot\n`,
    );
  });

  it('strips newlines from the reason into a single line', () => {
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', reason: 'line one\nline two\r\nline three' })],
      'all_active',
      ISSUED_AT,
    );
    expect(formatSquadBansCfg(entries)).toBe(
      'Banned:76561198000000001:0 // line one line two line three\n',
    );
  });

  it('skips entries without a steam_id64', () => {
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', steamId64: null, eosId: 'eos-1' })],
      'all_active',
      ISSUED_AT,
    );
    expect(formatSquadBansCfg(entries)).toBe('');
  });

  it('omits the "// reason" trailer when there is no reason', () => {
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', reason: null })],
      'all_active',
      ISSUED_AT,
    );
    expect(formatSquadBansCfg(entries)).toBe('Banned:76561198000000001:0\n');
  });
});

describe('buildBanlistEntries', () => {
  it('drops an expired temporary ban', () => {
    const now = new Date(ISSUED_AT.getTime() + 8 * 86_400_000);
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', banLength: '7d' })],
      'all_active',
      now,
    );
    expect(entries).toHaveLength(0);
  });

  it('keeps a still-active temporary ban', () => {
    const now = new Date(ISSUED_AT.getTime() + 3 * 86_400_000);
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', banLength: '7d' })],
      'all_active',
      now,
    );
    expect(entries).toHaveLength(1);
  });

  it('drops reverted bans', () => {
    const entries = buildBanlistEntries(
      [row({ playerId: 'p1', revertedAt: new Date() })],
      'all_active',
      ISSUED_AT,
    );
    expect(entries).toHaveLength(0);
  });

  it('permanent_only scope drops temporary bans', () => {
    const entries = buildBanlistEntries(
      [
        row({ playerId: 'p1', banLength: '7d' }),
        row({ playerId: 'p2', steamId64: '76561198000000002', banLength: '0' }),
      ],
      'permanent_only',
      ISSUED_AT,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.steamId64).toBe('76561198000000002');
  });

  it('dedups per player, keeping the permanent ban over a temporary one', () => {
    const entries = buildBanlistEntries(
      [
        row({ playerId: 'p1', banLength: '7d', reason: 'temp warning' }),
        row({ playerId: 'p1', banLength: '0', reason: 'escalated to permanent' }),
      ],
      'all_active',
      ISSUED_AT,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.expiresAt).toBeNull();
    expect(entries[0]?.reason).toBe('escalated to permanent');
  });

  it('dedups per player, keeping the ban with the latest expiry when both are temporary', () => {
    const entries = buildBanlistEntries(
      [
        row({ playerId: 'p1', banLength: '1d', reason: 'first' }),
        row({ playerId: 'p1', banLength: '30d', reason: 'second' }),
      ],
      'all_active',
      ISSUED_AT,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe('second');
  });

  it('output order is deterministic regardless of database row order (#235)', () => {
    const rows = [
      row({ playerId: 'p2', steamId64: '76561198000000002', reason: 'second player' }),
      row({ playerId: 'p1', steamId64: '76561198000000001', reason: 'first player' }),
      row({ playerId: 'p3', steamId64: '76561198000000003', reason: 'third player' }),
    ];
    const forward = buildBanlistEntries(rows, 'all_active', ISSUED_AT);
    const reversed = buildBanlistEntries([...rows].reverse(), 'all_active', ISSUED_AT);
    expect(reversed).toEqual(forward);
    expect(forward.map((entry) => entry.reason)).toEqual([
      'first player',
      'second player',
      'third player',
    ]);
  });

  it('picks the same permanent ban regardless of row order when a player has several (#235)', () => {
    const older = row({
      playerId: 'p1',
      reason: 'older',
      issuedAt: new Date('2025-06-01T00:00:00Z'),
    });
    const newer = row({
      playerId: 'p1',
      reason: 'newer',
      issuedAt: new Date('2025-07-01T00:00:00Z'),
    });
    const a = buildBanlistEntries([older, newer], 'all_active', ISSUED_AT);
    const b = buildBanlistEntries([newer, older], 'all_active', ISSUED_AT);
    expect(a).toEqual(b);
    expect(a[0]?.reason).toBe('newer');
  });
});
