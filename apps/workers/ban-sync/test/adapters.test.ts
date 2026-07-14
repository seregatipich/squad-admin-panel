import { describe, expect, it } from 'vitest';
import { parseBattlemetrics } from '../src/adapters/battlemetrics-json.js';
import { parseCsv } from '../src/adapters/csv.js';
import { parseBanList } from '../src/adapters/index.js';
import { parseJsonGeneric } from '../src/adapters/json-generic.js';

describe('parseBattlemetrics', () => {
  const fixture = JSON.stringify({
    data: [
      {
        attributes: {
          identifiers: [{ type: 'steamID', identifier: '76561198000000010' }],
          reason: 'teamkilling',
          note: 'AdminY',
          timestamp: '2026-01-01T00:00:00.000Z',
          expires: null,
        },
      },
      {
        attributes: {
          identifiers: [{ type: 'steamID', identifier: '76561198000000011' }],
          reason: 'aimbot',
          note: 'AdminZ',
          timestamp: '2026-01-02T00:00:00.000Z',
          expires: '2026-02-01T00:00:00.000Z',
        },
      },
      {
        attributes: {
          identifiers: [{ type: 'ip', identifier: '1.2.3.4' }],
          reason: 'no steam id',
        },
      },
    ],
  });

  it('maps the default BattleMetrics shape, with null expires meaning permanent', () => {
    const { records, skipped } = parseBattlemetrics(fixture);
    expect(records).toHaveLength(2);
    expect(skipped).toBe(1);
    expect(records[0]).toMatchObject({
      steamId64: '76561198000000010',
      reason: 'teamkilling',
      adminName: 'AdminY',
      expiresAt: null,
    });
    expect(records[1]?.expiresAt).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('supports overriding the field mapping via parser_config', () => {
    const custom = JSON.stringify({
      results: [
        { attributes: { identifiers: [{ type: 'steamID', identifier: '76561198000000012' }] } },
      ],
    });
    const { records } = parseBattlemetrics(custom, { list_path: 'results' });
    expect(records).toHaveLength(1);
    expect(records[0]?.steamId64).toBe('76561198000000012');
  });
});

describe('parseJsonGeneric', () => {
  it('maps records via dot-path parser_config fields, honoring list_path', () => {
    const fixture = JSON.stringify({
      bans: [
        { player: { steam: '76561198000000020' }, meta: { why: 'cheating' } },
        { player: {}, meta: { why: 'no id' } },
      ],
    });
    const { records, skipped } = parseJsonGeneric(fixture, {
      list_path: 'bans',
      fields: { steam_id64: 'player.steam', reason: 'meta.why' },
    });
    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
    expect(records[0]).toMatchObject({ steamId64: '76561198000000020', reason: 'cheating' });
  });

  it('skips records with neither steam_id64 nor eos_id', () => {
    const fixture = JSON.stringify([{ nickname: 'Ghost' }]);
    const { records, skipped } = parseJsonGeneric(fixture, {});
    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});

describe('parseCsv', () => {
  it('parses header-named columns', () => {
    const csv = [
      'steam_id64,reason',
      '76561198000000030,aimbot',
      '76561198000000031,teamkill',
    ].join('\n');
    const { records, skipped } = parseCsv(csv, {
      csv: { has_header: true, columns: { steam_id64: 'steam_id64', reason: 'reason' } },
    });
    expect(skipped).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ steamId64: '76561198000000030', reason: 'aimbot' });
  });

  it('parses indexed columns without a header, honoring quoted fields', () => {
    const csv = ['76561198000000032,"aim, bot"'].join('\n');
    const { records } = parseCsv(csv, {
      csv: { has_header: false, columns: { steam_id64: 0, reason: 1 } },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ steamId64: '76561198000000032', reason: 'aim, bot' });
  });

  it('skips a row lacking any identity column', () => {
    const csv = ['steam_id64,reason', ',no id here'].join('\n');
    const { records, skipped } = parseCsv(csv, {
      csv: { has_header: true, columns: { steam_id64: 'steam_id64', reason: 'reason' } },
    });
    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});

describe('parseBanList', () => {
  it('throws for an unknown format', () => {
    expect(() => parseBanList('unknown_format', '')).toThrow(/unsupported/);
  });

  it('dispatches to the matching adapter', () => {
    const { records } = parseBanList('squad_bans_cfg', 'Banned:76561198000000040:0');
    expect(records).toHaveLength(1);
  });
});
