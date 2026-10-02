/**
 * /api/v1/servers/:id/logs/files — browse + stream-download on-disk Squad logs.
 *
 * Uses a fake bridge whose `squadLogList` / `fileReadStream` are overridden per
 * test so we assert the route's JSON shape and its streaming/permission
 * behaviour without a real host filesystem.
 */

import { request as httpRequest } from 'node:http';
import { players, roles } from '@squad/db/schema';
import { PANEL_SAVED_ROOT } from '@squad/shared-config';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { narrowedOwnerHeaders } from './helpers/narrowed-token.js';
import { VIEWER_PERMISSIONS } from './helpers/viewer-fixture.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000005002n;
const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

let h: IntegrationHarness;

// Each describe shares one harness across its cases, and several cases demote
// the seeded owner; put it back on Owner so no case inherits a narrowed role.
afterEach(async () => {
  await assignRole(await ownerRoleId());
});

/** Reassign the seeded owner to a fresh role, invalidating its perm cache. */
async function assignRole(roleId: string): Promise<void> {
  const steamId = h.seed.ownerSteamId64;
  if (!steamId) throw new Error('missing seeded owner');
  await h.db.update(players).set({ roleId }).where(eq(players.steamId64, steamId));
  const ownerPlayerId = h.seed.ownerPlayerId;
  if (!ownerPlayerId) throw new Error('missing seeded owner');
  invalidatePermissionCache(ownerPlayerId);
}

async function ownerRoleId(): Promise<string> {
  const rows = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error('Owner role missing — migration 0009 not applied?');
  return id;
}

describe('GET /api/v1/servers/:id/logs/files', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
      bridge: makeFakeBridge({
        squadLogList: async ({ path }) => {
          expect(path).toBe(`${PANEL_SAVED_ROOT}/${SERVER_ID}/Logs`);
          return {
            files: [
              { name: 'SquadGame.log', size: 4096, mtime: '2026-07-24T10:00:00Z', is_live: true },
              {
                name: 'SquadGame-2026.07.23-11.00.00.log',
                size: 10_485_760,
                mtime: '2026-07-23T11:00:00Z',
                is_live: false,
              },
            ],
          };
        },
      }),
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('lists SquadGame*.log files with size, mtime and the live badge', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as {
      files: Array<{ name: string; size: number; mtime: string; is_live: boolean }>;
    };
    expect(body.files).toHaveLength(2);
    const live = body.files.find((f) => f.is_live);
    expect(live?.name).toBe('SquadGame.log');
    expect(live?.size).toBe(4096);
    const rotated = body.files.find((f) => !f.is_live);
    expect(rotated?.name).toBe('SquadGame-2026.07.23-11.00.00.log');
    expect(rotated?.size).toBe(10_485_760);
  });

  it('returns 401 when unauthenticated', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files`,
    });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for a caller without server:download_logs (Viewer permissions)', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files`,
      headers: await narrowedOwnerHeaders(h, VIEWER_PERMISSIONS),
    });
    expect(resp.statusCode).toBe(403);
  });

  it('grants access by default to any panel_access role (rbac auto-grant)', async () => {
    // A role with panel_access but NO explicit permission rows — the permission
    // must be granted purely by derivePanelPermissions, matching the spec's
    // "default — panel_access roles".
    const roleId = uuidv7();
    await h.db.insert(roles).values({
      id: roleId,
      name: `panel-${roleId}`,
      color: 'neutral',
      isSystemRole: false,
      panelAccess: true,
    });
    await assignRole(roleId);

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect((resp.json() as { files: unknown[] }).files).toHaveLength(2);
  });
});

describe('GET /api/v1/servers/:id/logs/files/:name/download', () => {
  // Binary payload (all 256 byte values, repeated) split into several frames —
  // proves base64 round-trips arbitrary bytes and that chunks are streamed and
  // reassembled in order.
  const payload = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
  const FRAME_BYTES = 400;
  let emittedFrames = 0;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
      bridge: makeFakeBridge({
        fileReadStream: async ({ path }, onStream) => {
          expect(path).toBe(`${PANEL_SAVED_ROOT}/${SERVER_ID}/Logs/SquadGame.log`);
          for (let off = 0; off < payload.length; off += FRAME_BYTES) {
            const chunk = payload.subarray(off, off + FRAME_BYTES);
            emittedFrames += 1;
            onStream({ id: 'fake', stream: 'stdout', data: chunk.toString('base64') });
          }
          return { bytes_sent: payload.length };
        },
      }),
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  beforeEach(() => {
    emittedFrames = 0;
  });

  it('streams the file as an attachment, reassembled byte-exact from many frames', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files/SquadGame.log/download`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers['content-type']).toContain('application/octet-stream');
    expect(resp.headers['content-disposition']).toBe('attachment; filename="SquadGame.log"');

    // Multiple frames were emitted and forwarded (not collected into one read):
    expect(emittedFrames).toBeGreaterThan(1);
    expect(emittedFrames).toBe(Math.ceil(payload.length / FRAME_BYTES));
    // The response body is exactly the concatenation of the streamed chunks.
    expect(Buffer.compare(resp.rawPayload, payload)).toBe(0);
  });

  it('returns 401 when unauthenticated', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files/SquadGame.log/download`,
    });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for a caller without server:download_logs (Viewer permissions)', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files/SquadGame.log/download`,
      headers: await narrowedOwnerHeaders(h, VIEWER_PERMISSIONS),
    });
    expect(resp.statusCode).toBe(403);
  });

  it('rejects a filename that is not a SquadGame*.log with 400', async () => {
    const cookie = await loginAsOwner(h);
    for (const bad of ['passwd', 'Other.log', 'SquadGame.txt', '..%2f..%2fetc']) {
      const resp = await h.app.inject({
        method: 'GET',
        url: `/api/v1/servers/${SERVER_ID}/logs/files/${bad}/download`,
        headers: { cookie },
      });
      expect(resp.statusCode, `filename ${bad} should be rejected`).toBe(400);
    }
    expect(emittedFrames).toBe(0);
  });
});

describe('download backpressure and abort (#291)', () => {
  const FRAME = Buffer.alloc(16 * 1024, 0x61).toString('base64');
  const state = {
    paused: false,
    closed: false,
    emitted: 0,
    maxFrames: 0,
    frameDelayMs: 0,
    pauseCalls: 0,
  };
  let baseUrl = '';

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
      bridge: makeFakeBridge({
        pause: () => {
          state.paused = true;
          state.pauseCalls += 1;
        },
        resume: () => {
          state.paused = false;
        },
        close: async () => {
          state.closed = true;
        },
        // A fast producer: frames keep coming until the maximum, unless the
        // route pauses the connection or closes it.
        fileReadStream: async (_params, onStream) => {
          while (!state.closed && state.emitted < state.maxFrames) {
            if (state.paused) {
              await new Promise((r) => setTimeout(r, 5));
              continue;
            }
            onStream({ id: 'fake', stream: 'stdout', data: FRAME });
            state.emitted += 1;
            await new Promise((r) =>
              state.frameDelayMs > 0 ? setTimeout(r, state.frameDelayMs) : setImmediate(r),
            );
          }
          if (state.closed) throw new Error('client closed');
          return { bytes_sent: state.emitted * 16 * 1024 };
        },
      }),
    });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = h.app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await h.cleanup();
  });

  beforeEach(() => {
    Object.assign(state, {
      paused: false,
      closed: false,
      emitted: 0,
      pauseCalls: 0,
      frameDelayMs: 0,
    });
  });

  function startDownload(cookie: string) {
    return httpRequest(`${baseUrl}/api/v1/servers/${SERVER_ID}/logs/files/SquadGame.log/download`, {
      headers: { cookie },
    });
  }

  it('pauses the bridge read while the HTTP client is not reading', async () => {
    state.maxFrames = 2_000; // ~32 MiB if nothing pushes back
    const cookie = await loginAsOwner(h);
    const req = startDownload(cookie);
    req.on('response', (res) => res.pause());
    req.on('error', () => undefined);
    req.end();

    await vi.waitFor(() => expect(state.pauseCalls).toBeGreaterThan(0), { timeout: 5_000 });
    expect(state.emitted).toBeLessThan(state.maxFrames);
    req.destroy();
  });

  it('closes the bridge connection when the client aborts the download', async () => {
    state.maxFrames = 5_000;
    state.frameDelayMs = 2;
    const cookie = await loginAsOwner(h);
    const req = startDownload(cookie);
    req.on('response', (res) => res.once('data', () => req.destroy()));
    req.on('error', () => undefined);
    req.end();

    await vi.waitFor(() => expect(state.closed).toBe(true), { timeout: 2_000 });
    expect(state.emitted).toBeLessThan(state.maxFrames);
  });
});
