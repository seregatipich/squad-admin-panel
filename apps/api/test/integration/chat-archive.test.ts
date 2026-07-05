import { chatMessages, playerNameHistory, players, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(180000);
const NO_PANEL_STEAM = testSteamId(180099);

const P1_STEAM = testSteamId(180001);
const P3_STEAM = testSteamId(180003);
const P2_EOS = 'eos-chat-000000000000000000000002';

const SERVER_ONE = '019e1000-0000-7000-8000-000000000001';
const SERVER_TWO = '019e1000-0000-7000-8000-000000000002';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let noPanelCookie: string;

let p1Id: string;
let p2Id: string;
let p3Id: string;

interface ChatItem {
  id: number;
  serverId: string;
  scope: string;
  message: string;
  source: string;
  isFlagged: boolean;
  teamId: number | null;
  squadId: number | null;
  sentAt: string;
  player: { id: string; nickname: string };
}

interface ListBody {
  items: ChatItem[];
  next_cursor: string | null;
}

const monthStart = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
})();
const BASE = new Date(monthStart.getTime() + 10 * 24 * 3600 * 1000);
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

interface SeedSpec {
  playerRef: 'p1' | 'p2' | 'p3';
  serverId: string;
  scope: string;
  source: 'log' | 'panel';
  flagged: boolean;
  message: string;
  minute: number;
}

const seedSpecs: SeedSpec[] = [
  {
    playerRef: 'p1',
    serverId: SERVER_ONE,
    scope: 'all',
    source: 'log',
    flagged: false,
    message: 'AlphaSniper reporting in from grid delta',
    minute: 0,
  },
  {
    playerRef: 'p2',
    serverId: SERVER_ONE,
    scope: 'team',
    source: 'log',
    flagged: false,
    message: 'BravoEos moving up to objective bravo',
    minute: 5,
  },
  {
    playerRef: 'p3',
    serverId: SERVER_TWO,
    scope: 'squad',
    source: 'log',
    flagged: false,
    message: 'CharlieRunner needs an ammo resupply now',
    minute: 10,
  },
  {
    playerRef: 'p1',
    serverId: SERVER_TWO,
    scope: 'admin',
    source: 'panel',
    flagged: true,
    message: 'Coordinated a massive flanking maneuver on the eastern ridge',
    minute: 15,
  },
  {
    playerRef: 'p2',
    serverId: SERVER_ONE,
    scope: 'broadcast',
    source: 'panel',
    flagged: false,
    message: 'Server restart scheduled in ten minutes everyone',
    minute: 20,
  },
  {
    playerRef: 'p3',
    serverId: SERVER_ONE,
    scope: 'all',
    source: 'log',
    flagged: true,
    message: 'CharlieRunner spotted enemy armor near the bridge',
    minute: 20,
  },
  {
    playerRef: 'p1',
    serverId: SERVER_TWO,
    scope: 'team',
    source: 'log',
    flagged: false,
    message: 'AlphaSniper holding an overwatch position',
    minute: 30,
  },
  {
    playerRef: 'p2',
    serverId: SERVER_TWO,
    scope: 'direct',
    source: 'log',
    flagged: false,
    message: 'BravoEos whispering tactical intel privately',
    minute: 35,
  },
];

const seededIds: number[] = [];

async function loginAsSteam(steamId64: bigint, userAgent: string): Promise<string> {
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
    userAgent,
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function list(cookie: string, qs: string): Promise<ListBody> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/chat/messages${qs}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as ListBody;
}

async function count(cookie: string, qs: string): Promise<number> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/chat/messages/count${qs}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { count: number }).count;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'ChatOwner' },
  });
  ownerCookie = await loginAsOwner(h);

  for (const serverId of [SERVER_ONE, SERVER_TWO]) {
    await h.db.insert(servers).values({
      id: serverId,
      displayName: `Chat Server ${serverId.slice(-1)}`,
      slug: `chat-server-${serverId.slice(-1)}`,
    });
  }

  const seedPlayer = async (
    steamId64: bigint | null,
    eosId: string | null,
    canonicalName: string,
    historyNames: string[],
  ): Promise<string> => {
    const [row] = await h.db
      .insert(players)
      .values({
        steamId64,
        eosId,
        canonicalName,
        canonicalNameNormalized: canonicalName.toLowerCase(),
      })
      .returning({ id: players.id });
    if (!row) throw new Error('failed to seed player');
    for (const name of historyNames) {
      await h.db.insert(playerNameHistory).values({
        playerId: row.id,
        name,
        nameNormalized: name.toLowerCase(),
      });
    }
    return row.id;
  };

  p1Id = await seedPlayer(P1_STEAM, null, 'AlphaSniper', ['AlphaSniper', 'OldAlpha']);
  p2Id = await seedPlayer(null, P2_EOS, 'BravoEos', ['BravoEos']);
  p3Id = await seedPlayer(P3_STEAM, null, 'CharlieRunner', ['CharlieRunner']);

  const playerIdByRef = { p1: p1Id, p2: p2Id, p3: p3Id };
  for (const spec of seedSpecs) {
    const [row] = await h.db
      .insert(chatMessages)
      .values({
        playerId: playerIdByRef[spec.playerRef],
        serverId: spec.serverId,
        sentAt: at(spec.minute),
        scope: spec.scope,
        source: spec.source,
        isFlagged: spec.flagged,
        message: spec.message,
      })
      .returning({ id: chatMessages.id });
    if (!row) throw new Error('failed to seed chat message');
    seededIds.push(Number(row.id));
  }

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'NoPanelChat',
    canonicalNameNormalized: 'nopanelchat',
    roleId: queuePriority[0]?.id ?? null,
  });
  noPanelCookie = await loginAsSteam(NO_PANEL_STEAM, 'chat-nopanel-test');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/chat/messages — RBAC', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/chat/messages' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a logged-in user without panel_access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/chat/messages',
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects the count endpoint without panel_access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/chat/messages/count',
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('GET /api/v1/chat/messages — response shape', () => {
  it('returns all seeded rows newest-first with denormalized player fields', async () => {
    const body = await list(ownerCookie, '?limit=300');
    expect(body.items).toHaveLength(seedSpecs.length);

    const sentTimes = body.items.map((item) => new Date(item.sentAt).getTime());
    for (let i = 1; i < sentTimes.length; i += 1) {
      expect(sentTimes[i - 1]).toBeGreaterThanOrEqual(sentTimes[i] as number);
    }

    const alpha = body.items.find((item) => item.message.startsWith('AlphaSniper reporting'));
    expect(alpha).toBeTruthy();
    expect(alpha?.player).toEqual({ id: p1Id, nickname: 'AlphaSniper' });
    expect(alpha?.serverId).toBe(SERVER_ONE);
    expect(alpha?.scope).toBe('all');
    expect(typeof alpha?.id).toBe('number');
  });
});

describeIfDb('GET /api/v1/chat/messages — filters', () => {
  it('filters by serverId', async () => {
    const body = await list(ownerCookie, `?serverId=${SERVER_ONE}&limit=300`);
    expect(body.items).toHaveLength(4);
    expect(body.items.every((item) => item.serverId === SERVER_ONE)).toBe(true);
    expect(await count(ownerCookie, `?serverId=${SERVER_ONE}`)).toBe(4);
  });

  it('filters by multiple scopes', async () => {
    const body = await list(ownerCookie, '?scope=all&scope=team&limit=300');
    expect(body.items).toHaveLength(4);
    expect(body.items.every((item) => ['all', 'team'].includes(item.scope))).toBe(true);
  });

  it('filters by source', async () => {
    const body = await list(ownerCookie, '?source=panel&limit=300');
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.source === 'panel')).toBe(true);
  });

  it('filters by flaggedOnly', async () => {
    const body = await list(ownerCookie, '?flaggedOnly=true&limit=300');
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.isFlagged)).toBe(true);
  });

  it('filters by from/to time range', async () => {
    const from = at(10).toISOString();
    const to = at(25).toISOString();
    const body = await list(
      ownerCookie,
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=300`,
    );
    expect(body.items).toHaveLength(4);
  });

  it('resolves playerQuery by nickname substring from name history', async () => {
    const body = await list(ownerCookie, '?playerQuery=alpha&limit=300');
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item) => item.player.id === p1Id)).toBe(true);
  });

  it('resolves playerQuery by an older nickname no longer canonical', async () => {
    const body = await list(ownerCookie, '?playerQuery=oldalpha&limit=300');
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item) => item.player.id === p1Id)).toBe(true);
  });

  it('resolves playerQuery by exact SteamID64', async () => {
    const body = await list(ownerCookie, `?playerQuery=${P1_STEAM.toString()}&limit=300`);
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item) => item.player.id === p1Id)).toBe(true);
  });

  it('resolves playerQuery by exact EOS id', async () => {
    const body = await list(ownerCookie, `?playerQuery=${P2_EOS}&limit=300`);
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item) => item.player.id === p2Id)).toBe(true);
  });

  it('returns no rows when playerQuery resolves to nobody', async () => {
    const body = await list(ownerCookie, '?playerQuery=nonexistentnickname&limit=300');
    expect(body.items).toHaveLength(0);
    expect(await count(ownerCookie, '?playerQuery=nonexistentnickname')).toBe(0);
  });

  it('searches message text beyond the competitor 17-char limit', async () => {
    const longNeedle = 'massive flanking maneuver on the eastern';
    expect(longNeedle.length).toBeGreaterThan(17);
    const body = await list(ownerCookie, `?text=${encodeURIComponent(longNeedle)}&limit=300`);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.message).toContain(longNeedle);
  });

  it('escapes LIKE metacharacters in text search', async () => {
    const body = await list(ownerCookie, `?text=${encodeURIComponent('100%_off')}&limit=300`);
    expect(body.items).toHaveLength(0);
  });

  it('combines every filter down to a single row', async () => {
    const qs = `?serverId=${SERVER_TWO}&scope=admin&source=panel&flaggedOnly=true&playerQuery=alpha&text=${encodeURIComponent('massive flanking')}&limit=300`;
    const body = await list(ownerCookie, qs);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.scope).toBe('admin');
    expect(await count(ownerCookie, qs.replace('&limit=300', ''))).toBe(1);
  });

  it('keeps count consistent with returned rows for a combined filter', async () => {
    const qs = `?serverId=${SERVER_ONE}&flaggedOnly=true`;
    const body = await list(ownerCookie, `${qs}&limit=300`);
    expect(await count(ownerCookie, qs)).toBe(body.items.length);
    expect(body.items).toHaveLength(1);
  });
});

describeIfDb('GET /api/v1/chat/messages — keyset pagination', () => {
  it('pages through every row exactly once with no loss or duplication', async () => {
    const collected: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const qs: string = cursor ? `?limit=3&cursor=${encodeURIComponent(cursor)}` : '?limit=3';
      const body: ListBody = await list(ownerCookie, qs);
      collected.push(...body.items.map((item) => item.id));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(collected).toHaveLength(seededIds.length);
    expect(new Set(collected).size).toBe(seededIds.length);
    expect([...collected].sort()).toEqual([...seededIds].sort());
  });

  it('does not lose or duplicate rows when a newer row is inserted mid-pagination', async () => {
    const page1 = await list(ownerCookie, '?limit=3');
    expect(page1.items).toHaveLength(3);
    expect(page1.next_cursor).toBeTruthy();

    const [inserted] = await h.db
      .insert(chatMessages)
      .values({
        playerId: p1Id,
        serverId: SERVER_ONE,
        sentAt: at(500),
        scope: 'all',
        source: 'log',
        isFlagged: false,
        message: 'AlphaSniper live-inserted after page one',
      })
      .returning({ id: chatMessages.id });
    const insertedId = Number(inserted?.id);

    const collected = [...page1.items.map((item) => item.id)];
    let cursor: string | null = page1.next_cursor;
    for (let page = 0; page < 20 && cursor; page += 1) {
      const body: ListBody = await list(
        ownerCookie,
        `?limit=3&cursor=${encodeURIComponent(cursor)}`,
      );
      collected.push(...body.items.map((item) => item.id));
      cursor = body.next_cursor;
    }

    for (const originalId of seededIds) {
      expect(collected.filter((id) => id === originalId)).toHaveLength(1);
    }
    expect(collected.filter((id) => id === insertedId)).toHaveLength(0);
    expect(new Set(collected).size).toBe(collected.length);

    await h.db.delete(chatMessages).where(eq(chatMessages.id, BigInt(insertedId)));
  });
});
