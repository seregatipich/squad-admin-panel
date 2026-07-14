import { describe, expect, it } from 'vitest';
import { parseSquadBansCfg } from '../src/adapters/squad-bans-cfg.js';

describe('parseSquadBansCfg', () => {
  it('parses a permanent ban (expiry 0) with expiresAt null', () => {
    const { records, skipped } = parseSquadBansCfg('Banned:76561198000000001:0');
    expect(skipped).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      steamId64: '76561198000000001',
      expiresAt: null,
      adminName: null,
      reason: null,
    });
  });

  it('parses a temporary ban with a correct expiry Date', () => {
    const { records } = parseSquadBansCfg('Banned:76561198000000002:1893456000');
    expect(records).toHaveLength(1);
    expect(records[0]?.expiresAt).toEqual(new Date(1893456000 * 1000));
  });

  it('extracts admin_name from a bracketed prefix and reason from a trailing comment', () => {
    const { records } = parseSquadBansCfg('[AdminX] Banned:76561198000000003:0 //cheating');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      steamId64: '76561198000000003',
      adminName: 'AdminX',
      reason: 'cheating',
      expiresAt: null,
    });
  });

  it('skips a malformed line and a non-17-digit SteamID64, counting them', () => {
    const text = ['not a ban line at all', 'Banned:12345:0', 'Banned:76561198000000004:0'].join(
      '\n',
    );
    const { records, skipped } = parseSquadBansCfg(text);
    expect(records).toHaveLength(1);
    expect(records[0]?.steamId64).toBe('76561198000000004');
    expect(skipped).toBe(2);
  });

  it('ignores blank lines and comment-only lines', () => {
    const text = [
      '',
      '   ',
      '// just a comment',
      'Banned:76561198000000005:0',
      '#hash comment',
    ].join('\n');
    const { records, skipped } = parseSquadBansCfg(text);
    expect(records).toHaveLength(1);
    expect(skipped).toBe(0);
  });
});
