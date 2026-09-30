import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

// Regression test for finding #338: a malformed `a2s:status:<id>` or
// `crashes:<id>` redis entry used to 500 the whole GET /api/v1/servers list
// and GET /api/v1/servers/:id detail, because the JSON.parse calls for those
// keys were not wrapped in try/catch (unlike the adjacent rcon:status parse).

interface SeededServer {
  id: string;
}

async function seedServer(h: IntegrationHarness): Promise<SeededServer> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Malformed redis json ${id.slice(0, 8)}`,
    slug: `malformed-redis-json-${id}`,
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
  return { id };
}

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: 76561198000000338n },
    bridge: makeFakeBridge(),
  });
});

afterAll(async () => {
  await h.cleanup();
});

describe('malformed cached JSON in Redis does not 500 the servers routes', () => {
  it('GET /api/v1/servers tolerates a corrupt a2s:status entry', async () => {
    const { id } = await seedServer(h);
    await h.redis.set(`a2s:status:${id}`, 'not-json{{{');

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/servers', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; a2s_status: unknown }> };
    const item = body.items.find((row) => row.id === id);
    expect(item).toBeDefined();
    expect(item?.a2s_status).toBeNull();
  });

  it('GET /api/v1/servers/:id tolerates a corrupt a2s:status entry and crash_history entries', async () => {
    const { id } = await seedServer(h);
    await h.redis.set(`a2s:status:${id}`, '{not valid json');
    await h.redis.zadd(`crashes:${id}`, 1, '{"broken"');
    await h.redis.zadd(`crashes:${id}`, 2, JSON.stringify({ reason: 'oom', at: '2026-01-01' }));

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { a2s_status: unknown; crash_history: unknown[] };
    expect(body.a2s_status).toBeNull();
    // The one malformed crash entry is dropped, the valid one survives.
    expect(body.crash_history).toEqual([{ reason: 'oom', at: '2026-01-01' }]);
  });
});
