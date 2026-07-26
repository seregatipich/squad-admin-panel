import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { economySettings, playerBonusAccruals, players, roles } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(840001);
const NO_PANEL_STEAM = testSteamId(840002);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCRUALS_SQL = readFileSync(
  path.resolve(__dirname, '../../../../packages/db/sql/player-bonus-accruals.sql'),
  'utf-8',
);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let rich: string;
let grinder: string;
let eosOnly: string;

interface BonusLeaderboardRow {
  rank: number;
  player_id: string;
  current_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  value: number;
  online_seconds: number;
}

interface BonusLeaderboardBody {
  period: string;
  available: boolean;
  economy_enabled: boolean;
  total_rows: number;
  rows: BonusLeaderboardRow[];
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'leaderboards-bonuses-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function setEconomyEnabled(enabled: boolean) {
  await h.db
    .update(economySettings)
    .set({ economyEnabled: enabled })
    .where(eq(economySettings.id, 1));
  const keys = await h.redis.keys('leaderboard-bonuses:*');
  if (keys.length > 0) await h.redis.del(...keys);
}

function fetchBonuses(query = '', cookie = ownerCookie) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/leaderboards/bonuses${query}`,
    headers: { cookie },
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'BonusLbOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  for (const stmt of ACCRUALS_SQL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await h.db.execute(sql.raw(trimmed));
  }

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'BonusLbNoPanel',
    canonicalNameNormalized: 'bonuslbnopanel',
    roleId: queuePriority[0]?.id ?? null,
  });

  // rich: fat balance, tiny recent accruals — tops period=all, not period=30d.
  // grinder: small balance, big recent accruals — tops period=30d.
  // eosOnly: no steam_id64 at all — must still appear (EOS-only criterion).
  const seeded = await h.db
    .insert(players)
    .values([
      {
        steamId64: testSteamId(840010),
        canonicalName: 'BonusRich',
        canonicalNameNormalized: 'bonusrich',
        eosId: 'eos-bonus-rich',
        bonusBalance: 500,
        totalTimePlayedSeconds: 9000,
      },
      {
        steamId64: testSteamId(840011),
        canonicalName: 'BonusGrinder',
        canonicalNameNormalized: 'bonusgrinder',
        eosId: 'eos-bonus-grinder',
        bonusBalance: 100,
        totalTimePlayedSeconds: 7200,
      },
      {
        steamId64: null,
        canonicalName: 'BonusEosOnly',
        canonicalNameNormalized: 'bonuseosonly',
        eosId: 'eos-bonus-only',
        bonusBalance: 300,
        totalTimePlayedSeconds: 3600,
      },
    ])
    .returning({ id: players.id, name: players.canonicalName });
  rich = seeded.find((p) => p.name === 'BonusRich')?.id as string;
  grinder = seeded.find((p) => p.name === 'BonusGrinder')?.id as string;
  eosOnly = seeded.find((p) => p.name === 'BonusEosOnly')?.id as string;

  // Precomputed 30-day window rows, as the aggregator tick would write them.
  await h.db.insert(playerBonusAccruals).values([
    { playerId: rich, accrued30d: 50 },
    { playerId: grinder, accrued30d: 400 },
    { playerId: eosOnly, accrued30d: 10 },
  ]);

  await setEconomyEnabled(true);
});

afterAll(async () => {
  await h.cleanup();
});

describeIfDb('GET /api/v1/leaderboards/bonuses', () => {
  it('requires panel_access', async () => {
    const noPanelCookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await fetchBonuses('', noPanelCookie);
    expect(res.statusCode).toBe(403);
  });

  it('period=all ranks by balance and includes EOS-only players', async () => {
    const res = await fetchBonuses('?period=all');
    expect(res.statusCode).toBe(200);
    const body = res.json() as BonusLeaderboardBody;
    expect(body.available).toBe(true);
    expect(body.economy_enabled).toBe(true);
    expect(body.period).toBe('all');
    expect(body.rows.map((r) => r.current_name)).toEqual([
      'BonusRich',
      'BonusEosOnly',
      'BonusGrinder',
    ]);
    expect(body.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(body.rows.map((r) => r.value)).toEqual([500, 300, 100]);
    expect(body.total_rows).toBe(3);

    const eosRow = body.rows.find((r) => r.player_id === eosOnly);
    expect(eosRow?.steam_id64).toBeNull();
    expect(eosRow?.eos_id).toBe('eos-bonus-only');
    expect(eosRow?.online_seconds).toBe(3600);

    expect(body.rows[0]?.steam_id64).toBe(testSteamId(840010).toString());
    expect(body.rows[0]?.online_seconds).toBe(9000);
  });

  it('period=30d ranks by windowed accruals, not balance', async () => {
    const res = await fetchBonuses('?period=30d');
    expect(res.statusCode).toBe(200);
    const body = res.json() as BonusLeaderboardBody;
    expect(body.available).toBe(true);
    expect(body.period).toBe('30d');
    // BonusRich tops the balance ranking but drops behind the grinder here.
    expect(body.rows.map((r) => r.current_name)).toEqual([
      'BonusGrinder',
      'BonusRich',
      'BonusEosOnly',
    ]);
    expect(body.rows.map((r) => r.value)).toEqual([400, 50, 10]);
    expect(body.total_rows).toBe(3);
  });

  it('limit caps rows', async () => {
    const res = await fetchBonuses('?period=all&limit=2');
    const body = res.json() as BonusLeaderboardBody;
    expect(body.rows).toHaveLength(2);
    expect(body.rows.map((r) => r.current_name)).toEqual(['BonusRich', 'BonusEosOnly']);
    expect(body.total_rows).toBe(3);
  });

  it('serves the second identical request from the redis cache', async () => {
    const miss = await fetchBonuses('?period=all&limit=7');
    const hit = await fetchBonuses('?period=all&limit=7');
    expect(miss.headers['x-cache']).toBe('miss');
    expect(hit.headers['x-cache']).toBe('hit');
    expect(hit.json()).toEqual(miss.json());
  });

  it('economy disabled → available:false envelope', async () => {
    await setEconomyEnabled(false);
    try {
      const res = await fetchBonuses('?period=all');
      expect(res.statusCode).toBe(200);
      const body = res.json() as BonusLeaderboardBody;
      expect(body.available).toBe(false);
      expect(body.economy_enabled).toBe(false);
      expect(body.rows).toEqual([]);
      expect(body.total_rows).toBe(0);
    } finally {
      await setEconomyEnabled(true);
    }
  });

  it('rejects an invalid period', async () => {
    const res = await fetchBonuses('?period=7d');
    expect(res.statusCode).toBe(400);
  });
});

describeIfDb('GET /api/v1/me — economy_enabled (ECON-5)', () => {
  it('reflects the economy_settings flag additively', async () => {
    await setEconomyEnabled(true);
    const on = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: ownerCookie },
    });
    expect(on.statusCode).toBe(200);
    const onBody = on.json() as { economy_enabled: boolean; permissions: string[] };
    expect(onBody.economy_enabled).toBe(true);
    expect(Array.isArray(onBody.permissions)).toBe(true);

    await setEconomyEnabled(false);
    try {
      const off = await h.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: ownerCookie },
      });
      expect((off.json() as { economy_enabled: boolean }).economy_enabled).toBe(false);
    } finally {
      await setEconomyEnabled(true);
    }
  });
});
