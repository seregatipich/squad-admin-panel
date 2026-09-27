import { playerSessions, players, servers } from '@squad/db/schema';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAnalyticsAggregates } from '../../src/routes/analytics.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

/**
 * Regression tests for #9: `peak_by_hour` backs the anonymous
 * `/api/v1/public/stats` route, so its cost must not scale with
 * (hourly ticks in the window) x (all session history). The previous query
 * re-scanned `player_sessions` once per hourly tick through a correlated
 * subquery; these tests pin a single pass over the table and prove the
 * rewrite returns exactly what the per-tick definition returns.
 */

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const WINDOW_FROM = '2026-06-10T00:30:00.000Z';
const WINDOW_TO = '2026-06-12T05:00:00.000Z';

let h: IntegrationHarness;
let serverId: string;
let otherServerId: string;

/** The per-tick definition of "concurrent players", evaluated the slow, obvious way. */
function referencePeakByHour(scopeServerId: string, fromIso: string, toIso: string): SQL {
  return sql`
    WITH ticks AS (
      SELECT gs AS wall
      FROM generate_series(
        date_trunc('hour', ${fromIso}::timestamptz AT TIME ZONE 'UTC'),
        ${toIso}::timestamptz AT TIME ZONE 'UTC',
        interval '1 hour'
      ) AS gs
    ),
    samples AS (
      SELECT extract(hour FROM t.wall)::int AS hour,
             (
               SELECT count(*)::int
               FROM player_sessions s
               WHERE s.connected_at <= (t.wall AT TIME ZONE 'UTC')
                 AND (s.disconnected_at IS NULL OR s.disconnected_at > (t.wall AT TIME ZONE 'UTC'))
                 AND s.server_id = ${scopeServerId}::uuid
             ) AS concurrent
      FROM ticks t
    )
    SELECT hour, max(concurrent)::int AS peak
    FROM samples
    GROUP BY hour
    ORDER BY hour
  `;
}

async function seedPlayer(steamSuffix: number): Promise<string> {
  const name = `PeakByHour${steamSuffix}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSuffix),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

/** Wraps the harness db so every statement `computeAnalyticsAggregates` executes is captured. */
function recordingApp(captured: SQL[]): FastifyInstance {
  const db = new Proxy(h.db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (query: SQL) => {
          captured.push(query);
          return target.execute(query);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db } as unknown as FastifyInstance;
}

interface PlanNode {
  'Relation Name'?: string;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

function sessionScanLoops(node: PlanNode, out: number[] = []): number[] {
  if (node['Relation Name']?.startsWith('player_sessions')) out.push(node['Actual Loops'] ?? 0);
  for (const child of node.Plans ?? []) sessionScanLoops(child, out);
  return out;
}

beforeAll(async () => {
  h = await buildIntegrationApp({ bridge: makeFakeBridge() });
  serverId = uuidv7();
  otherServerId = uuidv7();
  await h.db.insert(servers).values([
    { id: serverId, displayName: 'Peak by hour', slug: `peak-by-hour-${serverId}` },
    { id: otherServerId, displayName: 'Peak by hour other', slug: `peak-by-hour-${otherServerId}` },
  ]);

  const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => seedPlayer(835100 + i)));
  const at = (iso: string) => new Date(iso);
  const player = (index: number): string => {
    const id = ids[index];
    if (!id) throw new Error(`no seeded player at index ${index}`);
    return id;
  };
  await h.db.insert(playerSessions).values([
    // Started before the window, ends exactly on an hour boundary inside it.
    {
      playerId: player(0),
      serverId,
      connectedAt: at('2026-06-01T12:00:00Z'),
      disconnectedAt: at('2026-06-10T03:00:00Z'),
    },
    // Still open (never disconnected), started long before the window.
    {
      playerId: player(1),
      serverId,
      connectedAt: at('2026-06-02T08:15:00Z'),
      disconnectedAt: null,
    },
    // Starts exactly on a tick.
    {
      playerId: player(2),
      serverId,
      connectedAt: at('2026-06-10T05:00:00Z'),
      disconnectedAt: at('2026-06-10T07:59:59Z'),
    },
    // Starts inside, ends after the window.
    {
      playerId: player(3),
      serverId,
      connectedAt: at('2026-06-11T22:10:00Z'),
      disconnectedAt: at('2026-06-13T01:00:00Z'),
    },
    // Corrupt row: disconnected before it connected — never concurrent.
    {
      playerId: player(4),
      serverId,
      connectedAt: at('2026-06-10T06:30:00Z'),
      disconnectedAt: at('2026-06-10T04:00:00Z'),
    },
    // Zero-length session sitting on a tick — never concurrent.
    {
      playerId: player(5),
      serverId,
      connectedAt: at('2026-06-10T09:00:00Z'),
      disconnectedAt: at('2026-06-10T09:00:00Z'),
    },
    // Ends exactly on the first tick — excluded.
    {
      playerId: player(6),
      serverId,
      connectedAt: at('2026-06-09T20:00:00Z'),
      disconnectedAt: at('2026-06-10T00:00:00Z'),
    },
    // Entirely before and entirely after the window.
    {
      playerId: player(7),
      serverId,
      connectedAt: at('2026-06-05T10:00:00Z'),
      disconnectedAt: at('2026-06-05T11:00:00Z'),
    },
    {
      playerId: player(8),
      serverId,
      connectedAt: at('2026-06-12T05:00:01Z'),
      disconnectedAt: at('2026-06-12T09:00:00Z'),
    },
    // Starts exactly on the last tick (the window end).
    {
      playerId: player(9),
      serverId,
      connectedAt: at('2026-06-12T05:00:00Z'),
      disconnectedAt: at('2026-06-12T06:00:00Z'),
    },
    // Several overlapping sessions in the same evening hours.
    {
      playerId: player(10),
      serverId,
      connectedAt: at('2026-06-10T18:05:00Z'),
      disconnectedAt: at('2026-06-10T21:30:00Z'),
    },
    {
      playerId: player(11),
      serverId,
      connectedAt: at('2026-06-10T19:00:00Z'),
      disconnectedAt: at('2026-06-10T20:00:00Z'),
    },
    {
      playerId: player(0),
      serverId,
      connectedAt: at('2026-06-11T19:59:00Z'),
      disconnectedAt: at('2026-06-11T23:00:00Z'),
    },
    // Another server's session must not leak into this server's peaks.
    {
      playerId: player(2),
      serverId: otherServerId,
      connectedAt: at('2026-06-10T19:00:00Z'),
      disconnectedAt: at('2026-06-10T20:30:00Z'),
    },
  ]);
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

describeIfDb('analytics peak_by_hour (#9)', () => {
  it('matches the per-tick definition of concurrent players, edge cases included', async () => {
    const expectedRows = (await h.db.execute(
      referencePeakByHour(serverId, WINDOW_FROM, WINDOW_TO),
    )) as unknown as Array<{ hour: number; peak: number }>;
    const expected = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      peak_players: Number(expectedRows.find((row) => Number(row.hour) === hour)?.peak ?? 0),
    }));

    const aggregates = await computeAnalyticsAggregates(recordingApp([]), {
      serverId,
      fromIso: WINDOW_FROM,
      toIso: WINDOW_TO,
      limit: 10,
    });

    expect(aggregates.peak_by_hour).toEqual(expected);
    // Guard against a vacuous comparison: the fixture must produce real peaks.
    expect(Math.max(...expected.map((entry) => entry.peak_players))).toBeGreaterThanOrEqual(3);
  });

  it('reads player_sessions in a single pass instead of once per hourly tick', async () => {
    const captured: SQL[] = [];
    await computeAnalyticsAggregates(recordingApp(captured), {
      serverId: null,
      fromIso: WINDOW_FROM,
      toIso: WINDOW_TO,
      limit: 10,
    });
    const sessionQueries = captured.filter((query) =>
      new PgDialect().sqlToQuery(query).sql.includes('player_sessions'),
    );
    expect(sessionQueries).toHaveLength(1);

    const [explained] = (await h.db.execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sessionQueries[0]}`,
    )) as unknown as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>;
    const plan = explained?.['QUERY PLAN'][0]?.Plan;
    if (!plan) throw new Error('EXPLAIN returned no plan');

    const loops = sessionScanLoops(plan);
    expect(loops.length).toBeGreaterThan(0);
    expect(Math.max(...loops)).toBe(1);
  });
});
