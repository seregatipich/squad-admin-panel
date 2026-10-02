import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeA2sStatus } from '../src/lib/servers/status-cache.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

/**
 * #127: an A2S query that got no answer is "query unavailable", not a server
 * that hides itself. The routes hand the panel the cached `a2s:status:<id>`
 * entry; the entry of a worker that predates the fix (`visible: false`,
 * `reason: 'timeout'`) is normalised so the two never read differently.
 */

const AT = '2026-10-02T11:00:00.000Z';

describe('normalizeA2sStatus', () => {
  it('turns the old timeout shape into visible:null with no last success', () => {
    expect(normalizeA2sStatus({ visible: false, reason: 'timeout', queried_at: AT })).toEqual({
      visible: null,
      reason: 'timeout',
      queried_at: AT,
      last_success_at: null,
    });
  });

  it('keeps an answered query that reports the server as not visible', () => {
    const answered = { visible: false, server_name: 'X', queried_at: AT, last_success_at: AT };
    expect(normalizeA2sStatus(answered)).toBe(answered);
  });

  it('keeps the new unavailable shape and its last success', () => {
    const entry = { visible: null, reason: 'timeout', queried_at: AT, last_success_at: AT };
    expect(normalizeA2sStatus(entry)).toEqual(entry);
  });

  it('passes through null and non-objects', () => {
    expect(normalizeA2sStatus(null)).toBeNull();
    expect(normalizeA2sStatus(undefined)).toBeNull();
    expect(normalizeA2sStatus('x')).toBe('x');
  });
});

let h: IntegrationHarness;

async function seedServer(): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `A2S status ${id.slice(0, 8)}`,
    slug: `a2s-status-${id}`,
    status: 'running',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.alloc(64, 0x01),
  });
  await h.redis.set(
    `rcon:status:${id}`,
    JSON.stringify({ state: 'connected', player_count: 12, ts: AT }),
  );
  return id;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: 76561198000000127n },
    bridge: makeFakeBridge(),
  });
});

afterAll(async () => {
  await h.cleanup();
});

describe('A2S status in the server routes', () => {
  it('serves an unanswered query as visible:null with its last success, beside a connected RCON', async () => {
    const id = await seedServer();
    await h.redis.set(
      `a2s:status:${id}`,
      JSON.stringify({ visible: null, reason: 'timeout', queried_at: AT, last_success_at: AT }),
    );
    const cookie = await loginAsOwner(h);

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      rcon_status: { state: 'connected', player_count: 12 },
      a2s_status: { visible: null, reason: 'timeout', last_success_at: AT },
    });

    const list = await h.app.inject({ method: 'GET', url: '/api/v1/servers', headers: { cookie } });
    const row = (
      list.json() as { items: Array<{ id: string; rcon_state: string; a2s_status: unknown }> }
    ).items.find((item) => item.id === id);
    expect(row).toMatchObject({
      rcon_state: 'connected',
      a2s_status: { visible: null, reason: 'timeout' },
    });
  });

  it('normalises the entry of a worker that still writes visible:false for a timeout', async () => {
    const id = await seedServer();
    await h.redis.set(
      `a2s:status:${id}`,
      JSON.stringify({ visible: false, reason: 'timeout', queried_at: AT }),
    );
    const cookie = await loginAsOwner(h);

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(detail.json()).toMatchObject({
      a2s_status: { visible: null, reason: 'timeout', last_success_at: null },
    });

    const list = await h.app.inject({ method: 'GET', url: '/api/v1/servers', headers: { cookie } });
    const row = (list.json() as { items: Array<{ id: string; a2s_status: unknown }> }).items.find(
      (item) => item.id === id,
    );
    expect(row?.a2s_status).toMatchObject({ visible: null, last_success_at: null });
  });

  it('keeps a genuine visible:false answer', async () => {
    const id = await seedServer();
    await h.redis.set(
      `a2s:status:${id}`,
      JSON.stringify({
        visible: false,
        server_name: 'Hidden',
        queried_at: AT,
        last_success_at: AT,
      }),
    );
    const cookie = await loginAsOwner(h);
    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(detail.json()).toMatchObject({ a2s_status: { visible: false, server_name: 'Hidden' } });
  });
});
