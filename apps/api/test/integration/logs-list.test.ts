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
});
