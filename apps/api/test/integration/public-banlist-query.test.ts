import { moderationActions, players } from '@squad/db/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPublishableBanRows } from '../../src/routes/public-banlist.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness } from './harness.js';

const DAY_MS = 86_400_000;

/**
 * Audit #71 (#239): the banlist query must drop temporary bans that have
 * already expired in SQL, so the rows it loads no longer grow with the whole
 * ban history. Anything `parseBanLengthToExpiry` would keep — permanent,
 * malformed, absurdly long, still-running — must still be loaded.
 */
describe('loadPublishableBanRows', () => {
  let h: IntegrationHarness;
  const now = new Date();
  const nicknames = new Map<string, string>();

  async function seedBan(suffix: number, banLength: string | null, issuedAgoMs: number) {
    const name = `BanQuery${suffix}`;
    const [player] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(suffix),
        canonicalName: name,
        canonicalNameNormalized: name.toLowerCase(),
      })
      .returning({ id: players.id });
    if (!player) throw new Error('player insert failed');
    await h.db.insert(moderationActions).values({
      playerId: player.id,
      actionType: 'ban',
      authorSystemLabel: 'test-harness',
      reason: 'cheating',
      context: banLength === null ? {} : { ban_length: banLength },
      createdAt: new Date(now.getTime() - issuedAgoMs),
    });
    nicknames.set(name, banLength ?? '<none>');
  }

  beforeAll(async () => {
    h = await buildIntegrationApp();
    await seedBan(716001, '1d', 10 * DAY_MS); // expired temporary ban
    await seedBan(716002, '2h', DAY_MS); // expired, unit suffix
    await seedBan(716003, '30d', DAY_MS); // running temporary ban
    await seedBan(716004, '0', 400 * DAY_MS); // permanent
    await seedBan(716005, 'forever', 400 * DAY_MS); // malformed → permanent
    await seedBan(716006, null, 400 * DAY_MS); // no ban_length → permanent
    await seedBan(716007, '99999999999999999999y', 400 * DAY_MS); // absurdly long
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('loads every ban the publisher would keep and none that already expired', async () => {
    const rows = await loadPublishableBanRows(h.db, now);
    const loaded = new Set(rows.map((row) => row.nickname));
    expect(loaded.has('BanQuery716001')).toBe(false);
    expect(loaded.has('BanQuery716002')).toBe(false);
    for (const kept of [716003, 716004, 716005, 716006, 716007]) {
      expect(loaded.has(`BanQuery${kept}`)).toBe(true);
    }
    const running = rows.find((row) => row.nickname === 'BanQuery716003');
    expect(running?.banLength).toBe('30d');
    expect(running?.steamId64).toBe(testSteamId(716003).toString());
  });
});
