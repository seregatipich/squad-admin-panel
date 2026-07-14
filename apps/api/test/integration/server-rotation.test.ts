import { configVersions, players, roleSquadPermissions, roles } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = testSteamId(145000);

// Known-to-catalog layers seeded by migration 0042 (static ROT-1 fallback dataset).
const KNOWN_LAYER_A = 'Yehorivka RAAS v11';
const KNOWN_LAYER_B = 'Gorodok RAAS v1';
const UNKNOWN_LAYER = 'Custom_Layer_v9';

const CRLF = '\r\n';
const HEADER = `// operator header, keep me${CRLF}`;
const MANUAL_LINE = `ManuallyAddedLine${CRLF}`;
const MANAGED_SEGMENT =
  `//SQUAD-PANEL BEGIN — не редактировать вручную${CRLF}` +
  `${KNOWN_LAYER_A}${CRLF}` +
  `${KNOWN_LAYER_B}${CRLF}` +
  `${UNKNOWN_LAYER}${CRLF}` +
  '//SQUAD-PANEL END';
const FIXTURE = `${HEADER}${MANUAL_LINE}${MANAGED_SEGMENT}${CRLF}`;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function login(): Promise<string> {
  return loginAsOwner(h);
}

async function createServer(cookie: string, slug = 'rot-server'): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: {
      display_name: 'Rotation Server',
      slug,
      game_port: 7787,
      query_port: 27165,
      beacon_port: 15000,
      rcon_port: 21114,
      max_players: 80,
      tickrate: 50,
      multihome: '0.0.0.0',
    },
  });
  if (resp.statusCode !== 201) throw new Error(`server create failed: ${resp.body}`);
  return resp.json<{ id: string }>().id;
}

function seedRotationFile(serverId: string, content: string) {
  h.bridge.files.set(
    `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/LayerRotation.cfg`,
    Buffer.from(content),
  );
}

function readRotationFile(serverId: string): string | undefined {
  const buf = h.bridge.files.get(
    `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/LayerRotation.cfg`,
  );
  return buf?.toString('utf-8');
}

/**
 * Demotes the seeded owner to a role with only the given squad permissions
 * (mirrors the pattern in server-messaging.test.ts), so a session can be
 * exercised with a specific squad-permission grant instead of full Owner
 * short-circuiting.
 */
async function asRoleWithSquadPermissions(keys: string[]): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `Rotation-${keys.join('-') || 'none'}-${roleId.slice(0, 8)}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: true,
    });
    for (const key of keys) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded above
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

async function asRoleWithoutPanelAccess(): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `NoPanelAccess-${roleId.slice(0, 8)}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: false,
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded above
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

describe('GET /api/v1/servers/:id/rotation', () => {
  it('returns 401 without a session cookie', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/rotation` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a role without panel_access', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const cookie = await asRoleWithoutPanelAccess();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for a nonexistent server', async () => {
    const cookie = await login();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/019e2000-0000-7000-8000-0000000000ff/rotation',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns entries in file order, flagging the catalog-unknown layer', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    seedRotationFile(serverId, FIXTURE);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      file_exists: boolean;
      has_managed_segment: boolean;
      can_edit: boolean;
      entries: Array<{
        layer: string;
        known: boolean;
        map: string | null;
        gamemode: string | null;
      }>;
    }>();
    expect(body.file_exists).toBe(true);
    expect(body.has_managed_segment).toBe(true);
    expect(body.can_edit).toBe(true);
    expect(body.entries.map((e) => e.layer)).toEqual([KNOWN_LAYER_A, KNOWN_LAYER_B, UNKNOWN_LAYER]);
    const a = body.entries.find((e) => e.layer === KNOWN_LAYER_A);
    expect(a).toMatchObject({ known: true, map: 'Yehorivka', gamemode: 'RAAS' });
    const unknown = body.entries.find((e) => e.layer === UNKNOWN_LAYER);
    expect(unknown).toMatchObject({ known: false, map: null, gamemode: null });
  });

  it('reports file_exists:false and an empty entry list when the file is missing', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ file_exists: boolean; entries: unknown[] }>();
    expect(body.file_exists).toBe(false);
    expect(body.entries).toEqual([]);
  });

  it('reports can_edit:false for a role with panel_access but no changemap permission', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    seedRotationFile(serverId, FIXTURE);
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ can_edit: boolean }>().can_edit).toBe(false);
  });
});

describe('PUT /api/v1/servers/:id/rotation', () => {
  it('returns 401 without a session cookie', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      payload: { layers: [KNOWN_LAYER_A] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 {error:"forbidden"} for a role lacking the changemap squad permission', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    seedRotationFile(serverId, FIXTURE);
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [KNOWN_LAYER_A] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('succeeds with a changemap-only role', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    seedRotationFile(serverId, FIXTURE);
    const cookie = await asRoleWithSquadPermissions(['changemap']);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [KNOWN_LAYER_B, KNOWN_LAYER_A] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('rewrites the file with reordered layers, preserving content outside the markers byte-for-byte', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    seedRotationFile(serverId, FIXTURE);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [KNOWN_LAYER_B, UNKNOWN_LAYER, KNOWN_LAYER_A] },
    });
    expect(res.statusCode).toBe(200);

    const written = readRotationFile(serverId);
    expect(written).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const content = written!;
    expect(content.startsWith(`${HEADER}${MANUAL_LINE}`)).toBe(true);
    const segmentStart = content.indexOf('//SQUAD-PANEL BEGIN');
    const segment = content.slice(segmentStart);
    const lines = segment.split(CRLF);
    expect(lines[1]).toBe(KNOWN_LAYER_B);
    expect(lines[2]).toBe(UNKNOWN_LAYER);
    expect(lines[3]).toBe(KNOWN_LAYER_A);
    expect(segment).toContain('//SQUAD-PANEL END');
  });

  it('preserves the unknown layer name verbatim when resubmitted', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    seedRotationFile(serverId, FIXTURE);

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [UNKNOWN_LAYER] },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
    });
    const body = res.json<{ entries: Array<{ layer: string; known: boolean }> }>();
    expect(body.entries).toEqual([
      {
        layer: UNKNOWN_LAYER,
        known: false,
        map: null,
        gamemode: null,
        version: null,
        is_seed: null,
        deprecated: null,
      },
    ]);
  });

  it('creates the managed segment without destroying existing content when the file has no markers yet', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const noMarkerFixture = 'PreviousManualLine1\nPreviousManualLine2\n';
    seedRotationFile(serverId, noMarkerFixture);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [KNOWN_LAYER_A] },
    });
    expect(res.statusCode).toBe(200);
    const content = readRotationFile(serverId) ?? '';
    expect(content).toContain(noMarkerFixture);
    expect(content).toContain('//SQUAD-PANEL BEGIN');
    expect(content).toContain(KNOWN_LAYER_A);
  });

  it('reports unchanged:true and does not create a duplicate config_versions row when resubmitting identical layers', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    seedRotationFile(serverId, FIXTURE);

    const first = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [KNOWN_LAYER_A, KNOWN_LAYER_B, UNKNOWN_LAYER] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ unchanged: boolean }>().unchanged).toBe(false);

    const countAfterFirst = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(
        and(
          eq(configVersions.serverId, serverId),
          eq(configVersions.filename, 'LayerRotation.cfg'),
        ),
      );

    const second = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [KNOWN_LAYER_A, KNOWN_LAYER_B, UNKNOWN_LAYER] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ unchanged: boolean }>().unchanged).toBe(true);

    const countAfterSecond = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(
        and(
          eq(configVersions.serverId, serverId),
          eq(configVersions.filename, 'LayerRotation.cfg'),
        ),
      );
    expect(countAfterSecond.length).toBe(countAfterFirst.length);
  });

  it('returns 400 invalid_layer_name for a name containing a line break', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: ['a\r\nb'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_layer_name' });
  });

  it('writes a config_versions row and an audit_log entry with before/after segment context', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    seedRotationFile(serverId, FIXTURE);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/rotation`,
      headers: { cookie },
      payload: { layers: [KNOWN_LAYER_A] },
    });
    expect(res.statusCode).toBe(200);

    const versionRows = await h.db
      .select()
      .from(configVersions)
      .where(
        and(
          eq(configVersions.serverId, serverId),
          eq(configVersions.filename, 'LayerRotation.cfg'),
        ),
      );
    expect(versionRows.length).toBeGreaterThan(0);

    const row = await assertAuditRow(h, {
      action: 'server.rotation.write',
      resource: 'server',
      targetId: serverId,
    });
    const context = row.context as { before_segment: string | null; after_segment: string };
    expect(context.before_segment).toContain(KNOWN_LAYER_A);
    expect(context.after_segment).toContain(KNOWN_LAYER_A);
  });
});
