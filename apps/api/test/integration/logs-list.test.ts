import { encodeLogEntry, PANEL_LOGS_STREAM } from '@squad/shared-config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

let h: IntegrationHarness;
let cookie: string;

async function seed(
  entries: Array<{
    source: 'bridge' | 'rcon' | 'log-ingest' | 'worker' | 'depot' | 'install' | 'api';
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    serverId?: string;
    ctx?: Record<string, unknown>;
  }>,
): Promise<void> {
  for (const e of entries) {
    const fields = encodeLogEntry(e);
    const args: unknown[] = [PANEL_LOGS_STREAM, '*'];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    await h.redis.xadd(...(args as [string, ...string[]]));
  }
}

// One app + database per file; the logs stream is the only state these tests
// touch, so each one starts with it emptied.
beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: 76561198000000999n },
  });
  cookie = await loginAsOwner(h);
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  await h.redis.del(PANEL_LOGS_STREAM);
});

describe('GET /api/v1/logs', () => {
  it('returns latest entries newest-first with default limit', async () => {
    await seed([
      { source: 'rcon', level: 'info', msg: 'a' },
      { source: 'bridge', level: 'warn', msg: 'b' },
      { source: 'api', level: 'error', msg: 'c' },
    ]);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ msg: string }> };
    expect(body.entries).toHaveLength(3);
    expect(body.entries[0]?.msg).toBe('c');
    expect(body.entries.at(-1)?.msg).toBe('a');
  });

  it('filters by source code', async () => {
    await seed([
      { source: 'rcon', level: 'info', msg: 'a' },
      { source: 'bridge', level: 'info', msg: 'b' },
    ]);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?src=R',
      headers: { cookie },
    });
    const body = res.json() as { entries: Array<{ source: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.source).toBe('rcon');
  });

  it('filters by minimum level', async () => {
    await seed([
      { source: 'api', level: 'debug', msg: 'a' },
      { source: 'api', level: 'info', msg: 'b' },
      { source: 'api', level: 'error', msg: 'c' },
    ]);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?lvl=warn',
      headers: { cookie },
    });
    const body = res.json() as { entries: Array<{ msg: string }> };
    expect(body.entries.map((e) => e.msg)).toEqual(['c']);
  });

  it('filters by serverId', async () => {
    await seed([
      { source: 'rcon', level: 'info', msg: 'a', serverId: '01999999-9999-7999-8999-999999999999' },
      { source: 'rcon', level: 'info', msg: 'b' },
    ]);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?srv=01999999-9999-7999-8999-999999999999',
      headers: { cookie },
    });
    const body = res.json() as { entries: Array<{ msg: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.msg).toBe('a');
  });

  it('substring-filters by msg via q', async () => {
    await seed([
      { source: 'api', level: 'info', msg: 'rate-limit hit' },
      { source: 'api', level: 'info', msg: 'route 5xx' },
    ]);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?q=rate',
      headers: { cookie },
    });
    const body = res.json() as { entries: Array<{ msg: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.msg).toBe('rate-limit hit');
  });

  it('honors limit parameter', async () => {
    await seed([
      { source: 'api', level: 'info', msg: 'a' },
      { source: 'api', level: 'info', msg: 'b' },
      { source: 'api', level: 'info', msg: 'c' },
    ]);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?limit=2',
      headers: { cookie },
    });
    const body = res.json() as { entries: Array<unknown> };
    expect(body.entries).toHaveLength(2);
  });

  it('returns entries with id field for cursor pagination', async () => {
    await seed([{ source: 'api', level: 'info', msg: 'x' }]);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs', headers: { cookie } });
    const body = res.json() as { entries: Array<{ id: string }> };
    expect(body.entries[0]?.id).toMatch(/^\d+-\d+$/);
  });

  // Regression (#186): filters used to run after COUNT, so a run of more than
  // `limit` non-matching entries hid every later match and froze the live tail.
  it('finds matches behind more than `limit` non-matching entries on the initial load', async () => {
    await seed([{ source: 'api', level: 'error', msg: 'old-error' }]);
    await seed(
      Array.from({ length: 30 }, (_, i) => ({
        source: 'api' as const,
        level: 'info' as const,
        msg: `noise-${i}`,
      })),
    );
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?lvl=error&limit=10',
      headers: { cookie },
    });
    const body = res.json() as {
      entries: Array<{ msg: string }>;
      newest_scanned_id: string | null;
    };
    expect(body.entries.map((e) => e.msg)).toEqual(['old-error']);
    const tipId = (
      (await h.redis.xrevrange(PANEL_LOGS_STREAM, '+', '-', 'COUNT', 1)) as Array<
        [string, string[]]
      >
    )[0]?.[0];
    expect(body.newest_scanned_id).toBe(tipId);
  });

  it('advances the live-tail cursor past non-matching entries and reaches later matches', async () => {
    await seed([{ source: 'api', level: 'error', msg: 'first-error' }]);
    const first = h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?lvl=error&limit=10',
      headers: { cookie },
    });
    const firstBody = (await first).json() as { entries: Array<{ id: string }> };
    const after = firstBody.entries[0]?.id as string;
    await seed(
      Array.from({ length: 30 }, (_, i) => ({
        source: 'api' as const,
        level: 'info' as const,
        msg: `noise-${i}`,
      })),
    );
    await seed([{ source: 'api', level: 'error', msg: 'second-error' }]);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/logs?lvl=error&limit=10&after=${after}`,
      headers: { cookie },
    });
    const body = res.json() as {
      entries: Array<{ msg: string; id: string }>;
      newest_scanned_id: string | null;
    };
    expect(body.entries.map((e) => e.msg)).toEqual(['second-error']);
    expect(body.newest_scanned_id).toBe(body.entries[0]?.id);
  });

  it('returns the newest scanned id even when a live-tail poll matches nothing', async () => {
    await seed([{ source: 'api', level: 'error', msg: 'first-error' }]);
    const afterId = (
      (await h.redis.xrevrange(PANEL_LOGS_STREAM, '+', '-', 'COUNT', 1)) as Array<
        [string, string[]]
      >
    )[0]?.[0];
    await seed(
      Array.from({ length: 5 }, (_, i) => ({
        source: 'api' as const,
        level: 'info' as const,
        msg: `noise-${i}`,
      })),
    );
    const tipId = (
      (await h.redis.xrevrange(PANEL_LOGS_STREAM, '+', '-', 'COUNT', 1)) as Array<
        [string, string[]]
      >
    )[0]?.[0];

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/logs?lvl=error&limit=2&after=${afterId}`,
      headers: { cookie },
    });
    const body = res.json() as { entries: unknown[]; newest_scanned_id: string | null };
    expect(body.entries).toEqual([]);
    expect(body.newest_scanned_id).toBe(tipId);
  });

  it('rejects an oversized src filter with 400 (#70)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/logs?src=${'B,'.repeat(100)}B`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
