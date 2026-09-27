import { players } from '@squad/db/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = testSteamId(270001);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Fixture players with deliberately staggered values so that every sort key
 * produces a different, fully deterministic ordering. `q=ozz` matches exactly
 * Bravozz (old) and Echozz (new), which is what the filter/search composition
 * case relies on; no fixture name is a substring relationship with the seeded
 * owner's `owner`.
 */
interface Fixture {
  name: string;
  steamSuffix: number;
  firstSeenAgoMs: number;
  lastSeenAgoMs: number;
  totalTimePlayedSeconds: number;
}

const FIXTURES: Fixture[] = [
  {
    name: 'Alphazz',
    steamSuffix: 270002,
    firstSeenAgoMs: 30 * DAY_MS,
    lastSeenAgoMs: 1 * DAY_MS,
    totalTimePlayedSeconds: 400,
  },
  {
    name: 'Bravozz',
    steamSuffix: 270003,
    firstSeenAgoMs: 20 * DAY_MS,
    lastSeenAgoMs: 3 * DAY_MS,
    totalTimePlayedSeconds: 100,
  },
  {
    name: 'Charliezz',
    steamSuffix: 270004,
    firstSeenAgoMs: 2 * DAY_MS,
    lastSeenAgoMs: 10 * DAY_MS,
    totalTimePlayedSeconds: 300,
  },
  {
    // 7 days and one minute old — just outside the `filter=new` window.
    name: 'Deltazz',
    steamSuffix: 270005,
    firstSeenAgoMs: 7 * DAY_MS + MINUTE_MS,
    lastSeenAgoMs: 2 * DAY_MS,
    totalTimePlayedSeconds: 200,
  },
  {
    // 6 days and 23 hours old — just inside the `filter=new` window.
    name: 'Echozz',
    steamSuffix: 270006,
    firstSeenAgoMs: 6 * DAY_MS + 23 * HOUR_MS,
    lastSeenAgoMs: 5 * DAY_MS,
    totalTimePlayedSeconds: 250,
  },
];

const FIXTURE_NAMES = new Set(FIXTURES.map((f) => f.name));

interface ListItem {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

interface ListBody {
  items: ListItem[];
  total: number;
}

describe('GET /api/v1/players — sorting and filters', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;

  async function list(query: string): Promise<{ status: number; body: ListBody }> {
    const res = await h.app.inject({
      method: 'GET',
      url: query ? `/api/v1/players?${query}` : '/api/v1/players',
      headers: { cookie: ownerCookie },
    });
    return {
      status: res.statusCode,
      body: res.statusCode === 200 ? (res.json() as ListBody) : { items: [], total: 0 },
    };
  }

  /** Fixture names in response order, with the seeded owner filtered out. */
  async function order(query: string): Promise<string[]> {
    const { status, body } = await list(query);
    expect(status).toBe(200);
    return body.items.map((i) => i.canonical_name).filter((n) => FIXTURE_NAMES.has(n));
  }

  // Every test only reads the list, so the app and fixtures are built once.
  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
    ownerCookie = await loginAsOwner(h);
    const now = Date.now();
    await h.db.insert(players).values(
      FIXTURES.map((f) => ({
        steamId64: testSteamId(f.steamSuffix),
        canonicalName: f.name,
        canonicalNameNormalized: f.name.toLowerCase(),
        firstSeenAt: new Date(now - f.firstSeenAgoMs),
        lastSeenAt: new Date(now - f.lastSeenAgoMs),
        totalTimePlayedSeconds: f.totalTimePlayedSeconds,
      })),
    );
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('defaults to last_seen descending when no sort params are supplied', async () => {
    expect(await order('')).toEqual(['Alphazz', 'Deltazz', 'Bravozz', 'Echozz', 'Charliezz']);
  });

  it('sort=nickname&dir=asc orders items by normalized nickname ascending', async () => {
    expect(await order('sort=nickname&dir=asc')).toEqual([
      'Alphazz',
      'Bravozz',
      'Charliezz',
      'Deltazz',
      'Echozz',
    ]);
  });

  it('sort=nickname&dir=desc returns the exact reverse of the ascending order', async () => {
    const ascending = await order('sort=nickname&dir=asc');
    const descending = await order('sort=nickname&dir=desc');
    expect(descending).toEqual([...ascending].reverse());
  });

  it('sort=last_seen&dir=asc puts the least recently seen player first', async () => {
    expect(await order('sort=last_seen&dir=asc')).toEqual([
      'Charliezz',
      'Echozz',
      'Bravozz',
      'Deltazz',
      'Alphazz',
    ]);
  });

  it('sort=created&dir=desc puts the most recently created player first', async () => {
    expect(await order('sort=created&dir=desc')).toEqual([
      'Charliezz',
      'Echozz',
      'Deltazz',
      'Bravozz',
      'Alphazz',
    ]);
  });

  it('sort=created&dir=asc puts the oldest player first', async () => {
    expect(await order('sort=created&dir=asc')).toEqual([
      'Alphazz',
      'Bravozz',
      'Deltazz',
      'Echozz',
      'Charliezz',
    ]);
  });

  it('sort=total_time&dir=desc orders items by playtime descending', async () => {
    expect(await order('sort=total_time&dir=desc')).toEqual([
      'Alphazz',
      'Charliezz',
      'Echozz',
      'Deltazz',
      'Bravozz',
    ]);
  });

  it('sort=total_time&dir=asc orders items by playtime ascending', async () => {
    expect(await order('sort=total_time&dir=asc')).toEqual([
      'Bravozz',
      'Deltazz',
      'Echozz',
      'Charliezz',
      'Alphazz',
    ]);
  });

  it('filter=new returns only players first seen inside the last 7 days', async () => {
    const names = await order('filter=new');
    expect(new Set(names)).toEqual(new Set(['Charliezz', 'Echozz']));
  });

  it('filter=new excludes a player first seen 7 days and one minute ago', async () => {
    expect(await order('filter=new')).not.toContain('Deltazz');
  });

  it('filter=new combines with ?q= instead of replacing it', async () => {
    expect(new Set(await order('q=ozz'))).toEqual(new Set(['Bravozz', 'Echozz']));
    expect(await order('q=ozz&filter=new')).toEqual(['Echozz']);
  });

  it('rejects an unknown sort value with 400', async () => {
    const { status } = await list('sort=bogus');
    expect(status).toBe(400);
  });

  it('rejects an unknown dir value with 400', async () => {
    const { status } = await list('dir=sideways');
    expect(status).toBe(400);
  });

  it('rejects an unknown filter value with 400', async () => {
    const { status } = await list('filter=active_bans');
    expect(status).toBe(400);
  });

  it('keeps the items and total response shape unchanged', async () => {
    const { status, body } = await list('');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['items', 'total']);
    expect(body.total).toBe(body.items.length);
    const item = body.items.find((i) => i.canonical_name === 'Alphazz');
    expect(item).toBeDefined();
    expect(Object.keys(item as ListItem).sort()).toEqual([
      'canonical_name',
      'eos_id',
      'first_seen_at',
      'id',
      'last_seen_at',
      'steam_id64',
      'total_time_played_seconds',
    ]);
    expect((item as ListItem).steam_id64).toBe(testSteamId(270002).toString());
    expect((item as ListItem).total_time_played_seconds).toBe(400);
  });

  it('still returns 401 without a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/players?sort=nickname' });
    expect(res.statusCode).toBe(401);
  });
});
