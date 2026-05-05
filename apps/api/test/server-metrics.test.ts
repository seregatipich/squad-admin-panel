import { servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER = 76561198000000001n;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /api/v1/servers/:id/metrics', () => {
  it('returns empty array when no metrics exist', async () => {
    const id = uuidv7();
    await h.db.insert(servers).values({
      id,
      displayName: 'Test',
      slug: `t-${id.slice(0, 8)}`,
      status: 'running',
      runtime: 'container',
    });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/metrics`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().points).toEqual([]);
  });

  it('returns stored metrics within time range', async () => {
    const id = uuidv7();
    await h.db.insert(servers).values({
      id,
      displayName: 'Test',
      slug: `t-${id.slice(0, 8)}`,
      status: 'running',
      runtime: 'container',
    });

    const streamKey = `container:metrics:${id}`;
    await h.redis.xadd(
      streamKey,
      '*',
      'v',
      JSON.stringify({
        cpu_percent: 45.2,
        mem_bytes: 2_000_000_000,
        mem_percent: 62.5,
        pids: 42,
        timestamp: new Date().toISOString(),
      }),
    );

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/metrics`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.points.length).toBe(1);
    expect(body.points[0].cpu_percent).toBe(45.2);
  });

  it('returns 404 for nonexistent server', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/metrics`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('filters metrics by since/until parameters', async () => {
    const id = uuidv7();
    await h.db.insert(servers).values({
      id,
      displayName: 'Test',
      slug: `t-${id.slice(0, 8)}`,
      status: 'running',
      runtime: 'container',
    });

    const streamKey = `container:metrics:${id}`;

    // Insert entry at a known timestamp: 2026-01-01T00:00:00Z
    const ts1 = new Date('2026-01-01T00:00:00Z').getTime();
    await h.redis.xadd(
      streamKey,
      `${ts1}-0`,
      'v',
      JSON.stringify({
        cpu_percent: 10,
        mem_bytes: 100,
        mem_percent: 5,
        pids: 2,
        timestamp: '2026-01-01T00:00:00Z',
      }),
    );

    // Insert entry at a known timestamp: 2026-01-02T00:00:00Z
    const ts2 = new Date('2026-01-02T00:00:00Z').getTime();
    await h.redis.xadd(
      streamKey,
      `${ts2}-0`,
      'v',
      JSON.stringify({
        cpu_percent: 20,
        mem_bytes: 200,
        mem_percent: 10,
        pids: 4,
        timestamp: '2026-01-02T00:00:00Z',
      }),
    );

    const cookie = await loginAsOwner(h);

    // Query a range that only includes the first entry
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/metrics`,
      headers: { cookie },
      query: {
        since: '2025-12-31T00:00:00Z',
        until: '2026-01-01T12:00:00Z',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.points.length).toBe(1);
    expect(body.points[0].cpu_percent).toBe(10);
  });

  it('returns 404 for deleted server', async () => {
    const id = uuidv7();
    await h.db.insert(servers).values({
      id,
      displayName: 'Deleted',
      slug: `d-${id.slice(0, 8)}`,
      status: 'stopped',
      runtime: 'container',
      deletedAt: new Date(),
    });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/metrics`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
