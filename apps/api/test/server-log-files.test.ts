/**
 * /api/v1/servers/:id/logs/files — browse + stream-download on-disk Squad logs.
 *
 * Uses a fake bridge whose `squadLogList` / `fileReadStream` are overridden per
 * test so we assert the route's JSON shape and its streaming/permission
 * behaviour without a real host filesystem.
 */
import { players, roles } from '@squad/db/schema';
import { PANEL_SAVED_ROOT } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000005002n;
const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

let h: IntegrationHarness;

afterEach(async () => {
  if (h?.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h?.cleanup();
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

async function viewerRoleId(): Promise<string> {
  const rows = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Viewer'))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error('Viewer fixture role missing');
  return id;
}

describe('GET /api/v1/servers/:id/logs/files', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
      bridge: makeFakeBridge({
        squadLogList: async ({ path }) => {
          expect(path).toBe(`${PANEL_SAVED_ROOT}/${SERVER_ID}/SquadGame/Saved/Logs`);
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

  it('returns 403 for a role without server:download_logs (Viewer)', async () => {
    await assignRole(await viewerRoleId());
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files`,
      headers: { cookie },
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

  beforeEach(async () => {
    emittedFrames = 0;
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      seedOwnerGuard: true,
      bridge: makeFakeBridge({
        fileReadStream: async ({ path }, onStream) => {
          expect(path).toBe(`${PANEL_SAVED_ROOT}/${SERVER_ID}/SquadGame/Saved/Logs/SquadGame.log`);
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

  it('returns 403 for a role without server:download_logs (Viewer)', async () => {
    await assignRole(await viewerRoleId());
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/logs/files/SquadGame.log/download`,
      headers: { cookie },
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
