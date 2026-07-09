import {
  externalBanSources,
  externalBans,
  playerNameHistory,
  players,
  roles,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
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

const OWNER_STEAM = testSteamId(811001);
const NO_PANEL_STEAM = testSteamId(811002);

let h: IntegrationHarness;
let ownerCookie: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

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
    userAgent: 'suspects-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(steamSuffix: number, canonicalName: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSuffix),
      canonicalName,
      canonicalNameNormalized: canonicalName.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${canonicalName}`);
  return row.id;
}

async function setMark(playerId: string, markTypeId: number, cookie: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/v1/players/${playerId}/marks`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ mark_type_id: markTypeId }),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function seedActiveBan(steamId64: bigint): Promise<void> {
  const [source] = await h.db
    .insert(externalBanSources)
    .values({ name: `test-source-${steamId64}`, url: 'https://example.test/bans', format: 'csv' })
    .returning({ id: externalBanSources.id });
  if (!source) throw new Error('failed to seed ban source');
  await h.db.insert(externalBans).values({
    sourceId: source.id,
    steamId64: steamId64.toString(),
    reason: 'cheating',
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'SuspectsOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db
    .insert(players)
    .values({
      steamId64: NO_PANEL_STEAM,
      canonicalName: 'SuspectsNoPanel',
      canonicalNameNormalized: 'suspectsnopanel',
      roleId: queuePriority[0]?.id ?? null,
    })
    .onConflictDoNothing();
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/suspects', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/suspects' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without panel_access with 403', async () => {
    const cookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/suspects',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('rejects an invalid mark_type_ids param with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/suspects?mark_type_ids=1,abc',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_mark_type_ids' });
  });

  it('rejects an invalid cursor with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/suspects?cursor=not-a-cursor',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_cursor' });
  });

  it('returns one row with both marks for a player with two active marks', async () => {
    const playerId = await seedPlayer(811010, 'SuspectTwoMarks');
    await setMark(playerId, 1, ownerCookie);
    await setMark(playerId, 2, ownerCookie);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/suspects?q=SuspectTwoMarks`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; marks: Array<{ mark_type_id: number }> }>;
    };
    const rows = body.items.filter((row) => row.id === playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.marks.map((m) => m.mark_type_id).sort()).toEqual([1, 2]);
  });

  it('applies the mark_type_ids OR filter combined with no_active_ban', async () => {
    const matchingNoBanId = await seedPlayer(811020, 'SuspectFilterMatchNoBan');
    await setMark(matchingNoBanId, 3, ownerCookie);

    const matchingBannedId = await seedPlayer(811021, 'SuspectFilterMatchBanned');
    await setMark(matchingBannedId, 4, ownerCookie);
    await seedActiveBan(testSteamId(811021));

    const nonMatchingId = await seedPlayer(811022, 'SuspectFilterNoMatch');
    await setMark(nonMatchingId, 5, ownerCookie);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/suspects?mark_type_ids=3,4&no_active_ban=true&limit=100',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; has_active_ban: boolean }>;
    };
    const ids = body.items.map((row) => row.id);
    expect(ids).toContain(matchingNoBanId);
    expect(ids).not.toContain(matchingBannedId);
    expect(ids).not.toContain(nonMatchingId);

    const withoutBanFilter = await h.app.inject({
      method: 'GET',
      url: '/api/v1/suspects?mark_type_ids=3,4&limit=100',
      headers: { cookie: ownerCookie },
    });
    const withBanBody = withoutBanFilter.json() as {
      items: Array<{ id: string; has_active_ban: boolean }>;
    };
    const bannedRow = withBanBody.items.find((row) => row.id === matchingBannedId);
    expect(bannedRow).toBeDefined();
    expect(bannedRow?.has_active_ban).toBe(true);
  });

  it('matches q against the current name and historical names', async () => {
    const playerId = await seedPlayer(811030, 'CurrentNickQ');
    await setMark(playerId, 6, ownerCookie);
    await h.db.insert(playerNameHistory).values({
      playerId,
      name: 'OldHistoricalNickQ',
      nameNormalized: 'oldhistoricalnickq',
    });

    const byCurrent = await h.app.inject({
      method: 'GET',
      url: '/api/v1/suspects?q=CurrentNickQ',
      headers: { cookie: ownerCookie },
    });
    expect(byCurrent.statusCode).toBe(200);
    expect((byCurrent.json() as { items: Array<{ id: string }> }).items.map((r) => r.id)).toContain(
      playerId,
    );

    const byHistory = await h.app.inject({
      method: 'GET',
      url: '/api/v1/suspects?q=OldHistoricalNickQ',
      headers: { cookie: ownerCookie },
    });
    expect(byHistory.statusCode).toBe(200);
    expect((byHistory.json() as { items: Array<{ id: string }> }).items.map((r) => r.id)).toContain(
      playerId,
    );
  });

  it('paginates via keyset cursor without duplicates or omissions', async () => {
    const seededIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const playerId = await seedPlayer(811040 + i, `SuspectPage${i}`);
      await setMark(playerId, 7, ownerCookie);
      seededIds.push(playerId);
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    let guard = 0;
    do {
      const url: string = cursor
        ? `/api/v1/suspects?mark_type_ids=7&limit=2&cursor=${encodeURIComponent(cursor)}`
        : '/api/v1/suspects?mark_type_ids=7&limit=2';
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie: ownerCookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(body.items.length).toBeLessThanOrEqual(2);
      for (const item of body.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = body.next_cursor;
      guard += 1;
    } while (cursor && guard < 20);

    for (const id of seededIds) {
      expect(seen.has(id)).toBe(true);
    }
  });
});
