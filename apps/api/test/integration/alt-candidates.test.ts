import {
  altIgnoredIps,
  moderationActions,
  playerCoplay,
  playerIpHistory,
  playerNameHistory,
  players,
  servers,
} from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(810001);
const PLAYER_A = testSteamId(810002);
const PLAYER_B = testSteamId(810003);
const PLAYER_C = testSteamId(810004); // unrelated, different IP
const TEST_PLAYER_LIMITED_VIEWER = testSteamId(810005); // role without can_view_ips

let h: IntegrationHarness;

async function seedPlayer(
  steamId: bigint,
  name: string,
  extra?: { createdAt?: Date },
): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: steamId,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      createdAt: extra?.createdAt,
    })
    .returning({ id: players.id });
  return row.id;
}

async function seedServer(name: string): Promise<string> {
  const [row] = await h.db
    .insert(servers)
    .values({ id: uuidv7(), displayName: name, slug: `${name.toLowerCase()}-${uuidv7()}` })
    .returning({ id: servers.id });
  return row.id;
}

/** Insert a `player_coplay` bucket, normalising to the canonical player_a_id < player_b_id order. */
async function seedCoplay(opts: {
  p1: string;
  p2: string;
  serverId: string;
  windowStart: string;
  overlapSeconds: number;
  sharedSessionCount?: number;
}): Promise<void> {
  const [a, b] = opts.p1 < opts.p2 ? [opts.p1, opts.p2] : [opts.p2, opts.p1];
  await h.db.insert(playerCoplay).values({
    playerAId: a,
    playerBId: b,
    serverId: opts.serverId,
    windowStart: opts.windowStart,
    overlapSeconds: opts.overlapSeconds,
    sharedSessionCount: opts.sharedSessionCount ?? 1,
  });
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player found for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'alt-candidates-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h) await h.cleanup();
});

describe('GET /api/v1/players/:playerId/alt-candidates', () => {
  it('is mutually visible between two players sharing one IP', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const idC = await seedPlayer(PLAYER_C, 'PlayerC');

    const seenA = new Date('2026-06-01T10:00:00Z');
    const seenB = new Date('2026-06-01T10:01:30Z'); // 90s later
    await h.db.insert(playerIpHistory).values([
      {
        playerId: idA,
        ip: '203.0.113.10',
        countryCode: 'FR',
        countryName: 'France',
        city: 'Paris',
        lastSeenAt: seenA,
      },
      { playerId: idB, ip: '203.0.113.10', lastSeenAt: seenB },
      // PlayerC uses a different IP entirely — must not show up as a candidate.
      { playerId: idC, ip: '198.51.100.20' },
    ]);

    const cookie = await loginAsOwner(h);

    const resA = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.json() as {
      candidates: Array<{
        player_id: string;
        shared_ip_count: number;
        min_time_delta_seconds: number;
        matches: Array<{ ip: string; ignored: boolean }>;
      }>;
      total: number;
    };
    expect(bodyA.candidates).toHaveLength(1);
    expect(bodyA.candidates[0].player_id).toBe(idB);
    expect(bodyA.candidates[0].shared_ip_count).toBe(1);
    expect(bodyA.candidates[0].min_time_delta_seconds).toBe(90);
    expect(bodyA.candidates[0].matches[0]).toMatchObject({ ip: '203.0.113.10', ignored: false });

    const resB = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idB}/alt-candidates`,
      headers: { cookie },
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = resB.json() as { candidates: Array<{ player_id: string }> };
    expect(bodyB.candidates).toHaveLength(1);
    expect(bodyB.candidates[0].player_id).toBe(idA);
  });

  it('excludes a shared IP covered by an ignored CIDR from the score, but keeps the pair visible', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    // SteamID64 kept far from PLAYER_A (beyond the default steamid_proximity threshold) so
    // that signal stays off and the score in this test reflects only the ignored-IP behavior
    // under test — using PLAYER_B here would spuriously add its weight (both are 1 apart).
    const idB = await seedPlayer(PLAYER_A + 50_000n, 'PlayerB');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
    ]);
    await h.db.insert(altIgnoredIps).values({ cidr: '203.0.113.0/24' });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      candidates: Array<{
        player_id: string;
        shared_ip_count: number;
        ignored_shared_ip_count: number;
        score: number;
        confidence: string;
        matches: Array<{ ignored: boolean }>;
      }>;
    };
    expect(body.candidates).toHaveLength(1);
    const candidate = body.candidates[0];
    expect(candidate.shared_ip_count).toBe(0);
    expect(candidate.ignored_shared_ip_count).toBe(1);
    expect(candidate.matches[0].ignored).toBe(true);
    expect(candidate.score).toBe(0);
    expect(candidate.confidence).toBe('low');
  });

  it('raises the score and lists a shared historical nickname', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    // See the ignored-CIDR test above: kept far from PLAYER_A so steamid_proximity doesn't
    // add an extra, untested-for signal to the score asserted below.
    const idB = await seedPlayer(PLAYER_A + 50_000n, 'PlayerB');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
    ]);
    await h.db.insert(playerNameHistory).values([
      { playerId: idA, name: 'GhostSniper', nameNormalized: 'ghostsniper' },
      { playerId: idB, name: 'ghostsniper_', nameNormalized: 'ghostsniper' },
    ]);

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    const body = res.json() as {
      candidates: Array<{
        signals: { shared_names: { value: string[]; weight: number } };
        score: number;
      }>;
    };
    expect(body.candidates[0].signals.shared_names.value).toEqual(['ghostsniper']);
    // 50 (shared IP) + 25 (shared name) with the seeded default weights.
    expect(body.candidates[0].score).toBe(75);
  });

  it('flags a young account created after the target player last ban', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    await h.db.insert(moderationActions).values({
      playerId: idA,
      actionType: 'ban',
      authorSystemLabel: 'test-fixture',
      context: {},
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    const idB = await seedPlayer(PLAYER_B, 'PlayerB', {
      createdAt: new Date('2026-05-15T00:00:00Z'),
    });
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
    ]);

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    const body = res.json() as {
      candidates: Array<{ signals: { young_account: { value: boolean } } }>;
    };
    expect(body.candidates[0].signals.young_account.value).toBe(true);
  });

  it('flags SteamID64 proximity below the threshold and not above it', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const closeSteamId = PLAYER_A + 500n;
    const farSteamId = PLAYER_A + 50_000n;
    const idClose = await seedPlayer(closeSteamId, 'CloseTwin');
    const idFar = await seedPlayer(farSteamId, 'FarPlayer');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idClose, ip: '203.0.113.10' },
      { playerId: idFar, ip: '203.0.113.10' },
    ]);

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    const body = res.json() as {
      candidates: Array<{ player_id: string; signals: { steamid_proximity: { value: boolean } } }>;
    };
    const close = body.candidates.find((c) => c.player_id === idClose);
    const far = body.candidates.find((c) => c.player_id === idFar);
    expect(close?.signals.steamid_proximity.value).toBe(true);
    expect(far?.signals.steamid_proximity.value).toBe(false);
  });

  it('flags a non-reverted permanent ban as active+permanent, and a reverted one as neither', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const idC = await seedPlayer(PLAYER_C, 'PlayerC');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
      { playerId: idA, ip: '203.0.113.11' },
      { playerId: idC, ip: '203.0.113.11' },
    ]);
    await h.db.insert(moderationActions).values([
      {
        playerId: idB,
        actionType: 'ban',
        authorSystemLabel: 'test-fixture',
        context: {},
        revertedAt: null,
      },
      {
        playerId: idC,
        actionType: 'ban',
        authorSystemLabel: 'test-fixture',
        context: {},
        revertedAt: new Date(),
      },
    ]);

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    const body = res.json() as {
      candidates: Array<{ player_id: string; has_active_ban: boolean; has_permanent_ban: boolean }>;
    };
    const candidateB = body.candidates.find((candidate) => candidate.player_id === idB);
    const candidateC = body.candidates.find((candidate) => candidate.player_id === idC);
    expect(candidateB).toMatchObject({ has_active_ban: true, has_permanent_ban: true });
    expect(candidateC).toMatchObject({ has_active_ban: false, has_permanent_ban: false });
  });

  it('sorts by confidence/score descending and paginates with limit/offset', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idHigh = await seedPlayer(PLAYER_B, 'HighScore');
    const idLow = await seedPlayer(PLAYER_C, 'LowScore');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idHigh, ip: '203.0.113.10' },
      { playerId: idA, ip: '203.0.113.11' },
      { playerId: idLow, ip: '203.0.113.11' },
    ]);
    // Give the "high" candidate a shared historical nickname to push its score up.
    await h.db.insert(playerNameHistory).values([
      { playerId: idA, name: 'SharedNick', nameNormalized: 'sharednick' },
      { playerId: idHigh, name: 'sharednick', nameNormalized: 'sharednick' },
    ]);

    const cookie = await loginAsOwner(h);
    const full = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    const fullBody = full.json() as {
      candidates: Array<{ player_id: string; score: number }>;
      total: number;
    };
    expect(fullBody.total).toBe(2);
    expect(fullBody.candidates[0].player_id).toBe(idHigh);
    expect(fullBody.candidates[0].score).toBeGreaterThan(fullBody.candidates[1].score);

    const page1 = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates?limit=1&offset=0`,
      headers: { cookie },
    });
    const page1Body = page1.json() as { candidates: Array<{ player_id: string }>; total: number };
    expect(page1Body.candidates).toHaveLength(1);
    expect(page1Body.candidates[0].player_id).toBe(idHigh);
    expect(page1Body.total).toBe(2);

    const page2 = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates?limit=1&offset=1`,
      headers: { cookie },
    });
    const page2Body = page2.json() as { candidates: Array<{ player_id: string }> };
    expect(page2Body.candidates).toHaveLength(1);
    expect(page2Body.candidates[0].player_id).toBe(idLow);
  });

  it('rejects an unauthenticated request', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a logged-in user whose role lacks can_view_ips, with no IPs/candidates leaked', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
    ]);
    await seedPlayer(TEST_PLAYER_LIMITED_VIEWER, 'LimitedViewer');

    const ownerCookie = await loginAsOwner(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: `no-view-ips-${Date.now()}`,
        color: '#123456',
        squad_permissions: [],
        panel_access: true,
        can_view_ips: false,
      }),
    });
    expect(created.statusCode).toBe(201);
    const roleId = (created.json() as { id: string }).id;
    await h.db
      .update(players)
      .set({ roleId })
      .where(eq(players.steamId64, TEST_PLAYER_LIMITED_VIEWER));
    invalidateAllPermissionCaches();

    const cookie = await loginAsSteam(TEST_PLAYER_LIMITED_VIEWER);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as Record<string, unknown>;
    expect(body.candidates).toBeUndefined();
  });

  it('uses the player_ip_history(ip) index rather than a sequential scan', async () => {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const planRows = (await tx.execute(sql`
        EXPLAIN (FORMAT TEXT)
        SELECT b.player_id
        FROM player_ip_history a
        JOIN player_ip_history b ON b.ip = a.ip AND b.player_id <> a.player_id
        WHERE a.player_id = ${'00000000-0000-0000-0000-000000000000'}
      `)) as unknown as Array<{ 'QUERY PLAN': string }>;
      const plan = planRows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('player_ip_history_ip_idx');
      expect(plan).not.toContain('Seq Scan on player_ip_history');
    });
  });
});

describe('GET /api/v1/players/:playerId/alt-candidates — ALT-3 co-play anti-signal', () => {
  const TODAY = new Date().toISOString().slice(0, 10);
  // Default alt_detection_settings.coplay_overlap_threshold_seconds = 36 000 (10h).
  const OVER_THRESHOLD_SECONDS = 40_000;
  const UNDER_THRESHOLD_SECONDS = 100;

  it('lowers the score and confidence of a candidate with a large co-play overlap', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    // Kept far from PLAYER_A (beyond the default steamid_proximity threshold, see the
    // ignored-CIDR test above) so the score here reflects only shared-IP + coplay.
    const idHighOverlap = await seedPlayer(PLAYER_A + 50_000n, 'HighOverlapCandidate');
    const idNoOverlap = await seedPlayer(PLAYER_A + 60_000n, 'NoOverlapCandidate');
    const server = await seedServer('AltCoplayServer');

    // Both candidates share one IP with the target (identical IP-based score).
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idHighOverlap, ip: '203.0.113.10' },
      { playerId: idA, ip: '203.0.113.11' },
      { playerId: idNoOverlap, ip: '203.0.113.11' },
    ]);
    // Only idHighOverlap has a large rolling-window co-play overlap with the target.
    await seedCoplay({
      p1: idA,
      p2: idHighOverlap,
      serverId: server,
      windowStart: TODAY,
      overlapSeconds: OVER_THRESHOLD_SECONDS,
    });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      candidates: Array<{
        player_id: string;
        score: number;
        confidence: string;
        signals: {
          coplay_overlap: { value: number; threshold_seconds: number; weight: number };
        };
      }>;
    };
    const withOverlap = body.candidates.find((c) => c.player_id === idHighOverlap);
    const withoutOverlap = body.candidates.find((c) => c.player_id === idNoOverlap);
    expect(withOverlap).toBeDefined();
    expect(withoutOverlap).toBeDefined();

    expect(withOverlap?.signals.coplay_overlap).toMatchObject({
      value: OVER_THRESHOLD_SECONDS,
      threshold_seconds: 36_000,
      weight: -30,
    });
    // Shared IP alone (50) is 'medium'; the co-play anti-signal (-30) drags it to 20 -> 'low'.
    expect(withoutOverlap?.score).toBe(50);
    expect(withoutOverlap?.confidence).toBe('medium');
    expect(withOverlap?.score).toBe(20);
    expect(withOverlap?.confidence).toBe('low');
    expect(withOverlap?.score).toBeLessThan(withoutOverlap?.score as number);
  });

  it('does not subtract the anti-signal when overlap is below the threshold', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_A + 50_000n, 'PlayerB');
    const server = await seedServer('AltCoplayBelowThreshold');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
    ]);
    await seedCoplay({
      p1: idA,
      p2: idB,
      serverId: server,
      windowStart: TODAY,
      overlapSeconds: UNDER_THRESHOLD_SECONDS,
    });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    const body = res.json() as {
      candidates: Array<{
        player_id: string;
        score: number;
        signals: { coplay_overlap: { value: number } };
      }>;
    };
    const candidate = body.candidates.find((c) => c.player_id === idB);
    expect(candidate?.signals.coplay_overlap.value).toBe(UNDER_THRESHOLD_SECONDS);
    // Only the shared-IP weight (50) contributes; the anti-signal did not fire.
    expect(candidate?.score).toBe(50);
  });

  it('ignores co-play buckets outside the rolling window (>90 days old)', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_A + 50_000n, 'PlayerB');
    const server = await seedServer('AltCoplayStale');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
    ]);
    const staleDay = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    await seedCoplay({
      p1: idA,
      p2: idB,
      serverId: server,
      windowStart: staleDay,
      overlapSeconds: OVER_THRESHOLD_SECONDS,
    });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    const body = res.json() as {
      candidates: Array<{
        player_id: string;
        score: number;
        signals: { coplay_overlap: { value: number } };
      }>;
    };
    const candidate = body.candidates.find((c) => c.player_id === idB);
    expect(candidate?.signals.coplay_overlap.value).toBe(0);
    expect(candidate?.score).toBe(50);
  });
});
