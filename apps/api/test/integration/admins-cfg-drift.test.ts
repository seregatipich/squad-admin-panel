import { adminsCfgSyncOutbox, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdminsCfgSyncEvent } from '../../src/lib/admins-cfg-sync.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const STATUS_KEY = (id: string) => `admins-cfg:status:${id}`;

let h: IntegrationHarness;
let cookie: string;
let healthyId: string;
let corruptId: string;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: testSteamId(82001) } });
  cookie = await loginAsOwner(h);
  healthyId = uuidv7();
  corruptId = uuidv7();
  for (const [id, slug] of [
    [healthyId, 'drift-healthy'],
    [corruptId, 'drift-corrupt'],
  ] as const) {
    await h.db.insert(servers).values({ id, displayName: slug, slug: `${slug}-${id.slice(-6)}` });
  }
  await h.redis.set(
    STATUS_KEY(healthyId),
    JSON.stringify({
      state: 'in_sync',
      last_synced_at: '2026-09-01T00:00:00.000Z',
      last_segment_hash: 'a',
      last_db_hash: 'a',
    }),
  );
  await h.redis.set(STATUS_KEY(corruptId), '{"state":"in_sync"'); // truncated JSON
});

afterAll(async () => {
  await h.redis.del(STATUS_KEY(healthyId), STATUS_KEY(corruptId));
  await h.cleanup();
});

describe('GET /api/v1/admins-cfg/drift*', () => {
  it('reports unknown for a corrupt status entry instead of 500 (#82)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admins-cfg/drift?server_id=${corruptId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.state).toBe('unknown');
  });

  it('rejects a status whose shape the worker no longer writes (#82)', async () => {
    await h.redis.set(STATUS_KEY(corruptId), JSON.stringify({ state: 'exploded', extra: 1 }));
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/admins-cfg/drift?server_id=${corruptId}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status.state).toBe('unknown');
    } finally {
      await h.redis.set(STATUS_KEY(corruptId), '{"state":"in_sync"');
    }
  });

  it('one corrupt entry does not break /drift/all, which reads every status in one round trip (#82, #83)', async () => {
    const mget = vi.spyOn(h.redis, 'mget');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admins-cfg/drift/all',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Array<{ server_id: string; status: { state: string } }> }>()
      .items;
    const byId = new Map(items.map((i) => [i.server_id, i.status.state]));
    expect(byId.get(healthyId)).toBe('in_sync');
    expect(byId.get(corruptId)).toBe('unknown');
    expect(mget).toHaveBeenCalledTimes(1);
    mget.mockRestore();
  });
});

describe('POST /api/v1/admins-cfg/sync request id (#84)', () => {
  async function enqueuedRequestIds(serverId: string): Promise<string[]> {
    const rows = await h.db
      .select({ payload: adminsCfgSyncOutbox.payload })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.serverId, serverId));
    return rows.map((row) => (row.payload as AdminsCfgSyncEvent).request_id ?? '');
  }

  it('enqueues the sanitised request id the response carries, not the raw header', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admins-cfg/sync?server_id=${healthyId}`,
      headers: { cookie, 'x-request-id': `bad id <script>${'x'.repeat(300)}` },
    });
    expect(res.statusCode).toBe(200);
    const responseId = res.headers['x-request-id'];
    expect(responseId).toMatch(/^[\w-]{1,128}$/);
    expect(await enqueuedRequestIds(healthyId)).toContain(responseId);
  });

  it('keeps a well-formed caller request id for correlation', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admins-cfg/sync?server_id=${healthyId}`,
      headers: { cookie, 'x-request-id': 'corr-84-abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('corr-84-abc');
    expect(await enqueuedRequestIds(healthyId)).toContain('corr-84-abc');
  });
});
