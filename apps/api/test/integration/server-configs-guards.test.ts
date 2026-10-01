// #42 write guards for the config editor: per-file permissions (#1236), the
// server-existence and backup-marker checks (#281), the Rcon.cfg credential
// guard (#280), serialized writes (#282) and bounded diff/blame work (#283).
import type { DatabaseClient } from '@squad/db';
import {
  configVersions,
  players,
  roleSquadPermissions,
  roles,
  serverCredentials,
  servers,
} from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, deserialize } from '../../src/lib/crypto.js';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { waitForBlockedBackendOn } from '../helpers/row-lock.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = testSteamId(942001);
const MASK = '********';

let h: IntegrationHarness;
let ownerCookie: string;
let serverCounter = 0;
let steamCounter = 0;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);
}, 60_000);

beforeEach(() => {
  Object.assign(h.bridge, makeFakeBridge());
});

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

async function createServer(): Promise<string> {
  serverCounter += 1;
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie: ownerCookie },
    payload: {
      display_name: `Guard Server ${serverCounter}`,
      slug: `guard-server-${serverCounter}`,
      game_port: 9100 + serverCounter * 2,
      query_port: 29100 + serverCounter,
      beacon_port: 16100 + serverCounter,
      rcon_port: 22100 + serverCounter,
      max_players: 80,
      tickrate: 50,
      multihome: '0.0.0.0',
    },
  });
  if (resp.statusCode !== 201) throw new Error(`server create failed: ${resp.body}`);
  return resp.json<{ id: string }>().id;
}

function diskPath(id: string, name: string): string {
  return `${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/${name}`;
}

function setDisk(id: string, name: string, content: string): void {
  h.bridge.files.set(diskPath(id, name), Buffer.from(content, 'utf-8'));
}

function readDisk(id: string, name: string): string | undefined {
  return h.bridge.files.get(diskPath(id, name))?.toString('utf-8');
}

async function seedRoleCookie(
  db: DatabaseClient,
  opts: { canAssignRoles?: boolean; squadPermissions?: string[] } = {},
): Promise<string> {
  const roleId = uuidv7();
  await db.insert(roles).values({
    id: roleId,
    name: `Guard-Role-${roleId}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: true,
    // `config:edit` is an infrastructure key: panel_access alone no longer
    // grants it (#36), and these roles exist to edit configs.
    canManageInfrastructure: true,
    canAssignRoles: opts.canAssignRoles ?? false,
  });
  for (const key of opts.squadPermissions ?? []) {
    await db.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
  }
  steamCounter += 1;
  const playerId = uuidv7();
  const name = `Guard-${playerId.slice(0, 8)}`;
  await db.insert(players).values({
    id: playerId,
    steamId64: testSteamId(942100 + steamCounter),
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
    roleId,
  });
  invalidatePermissionCache(playerId);
  const { token } = await createSession(db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'config-guards-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function put(id: string, name: string, payload: object, cookie = ownerCookie) {
  return h.app.inject({
    method: 'PUT',
    url: `/api/v1/servers/${id}/configs/${name}`,
    headers: { cookie },
    payload,
  });
}

async function panelRcon(id: string): Promise<{ password: string; port: number }> {
  const [creds] = await h.db
    .select()
    .from(serverCredentials)
    .where(eq(serverCredentials.serverId, id));
  if (!creds?.rconPasswordEncrypted) throw new Error('no credentials');
  return {
    password: decryptString(
      h.app.encryptionKey,
      deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
    ),
    port: creds.rconPort,
  };
}

function rconCfg(port: number, password: string, maxConnections = 5): string {
  return `IP=0.0.0.0\nPort=${port}\nPassword=${password}\nMaxConnections=${maxConnections}\n`;
}

describe('per-file write permissions (#1236)', () => {
  const GATED: Array<[string, string]> = [
    ['Bans.cfg', 'mod:ban_perm'],
    ['RemoteBanListHosts.cfg', 'mod:ban_perm'],
    ['Admins.cfg', 'user:manage_roles'],
    ['RemoteAdminListHosts.cfg', 'user:manage_roles'],
  ];

  it.each(GATED)('a config:edit role without the gate cannot PUT %s', async (name, required) => {
    const id = await createServer();
    setDisk(id, name, '// original\n');
    const cookie = await seedRoleCookie(h.db);

    const res = await put(id, name, { content: 'Admin=76561198000000001:Admin\n' }, cookie);

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', required_permission: required });
    expect(readDisk(id, name)).toBe('// original\n');
  });

  it('the same role can still PUT an ungated file', async () => {
    const id = await createServer();
    const cookie = await seedRoleCookie(h.db);
    const res = await put(id, 'MOTD.cfg', { content: 'Welcome\n' }, cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(readDisk(id, 'MOTD.cfg')).toBe('Welcome\n');
  });

  it('a role with the squad ban permission can PUT Bans.cfg', async () => {
    const id = await createServer();
    const cookie = await seedRoleCookie(h.db, { squadPermissions: ['ban'] });
    const res = await put(id, 'Bans.cfg', { content: '76561198000000001:0\n' }, cookie);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a role that can assign roles can PUT Admins.cfg', async () => {
    const id = await createServer();
    const cookie = await seedRoleCookie(h.db, { canAssignRoles: true });
    const res = await put(id, 'Admins.cfg', { content: '// admins\n' }, cookie);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('drift accept, drift revert, reset-default and restore are gated the same way', async () => {
    const id = await createServer();
    await put(id, 'Bans.cfg', { content: '// v1\n' });
    const [tip] = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, 'Bans.cfg')));
    setDisk(id, 'Bans.cfg', '76561198000000001:0\n');
    const cookie = await seedRoleCookie(h.db);

    for (const url of [
      `/api/v1/servers/${id}/configs/Bans.cfg/drift/accept`,
      `/api/v1/servers/${id}/configs/Bans.cfg/drift/revert`,
      `/api/v1/servers/${id}/configs/Bans.cfg/reset-default`,
      `/api/v1/servers/${id}/configs/Bans.cfg/restore/${tip?.id}`,
    ]) {
      const res = await h.app.inject({ method: 'POST', url, headers: { cookie }, payload: {} });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
    }
    expect(readDisk(id, 'Bans.cfg')).toBe('76561198000000001:0\n');
  });
});

describe('writes require a live server and a panel-owned message (#281)', () => {
  it('PUT on an unknown server id is 404 and never touches the disk', async () => {
    const unknownId = uuidv7();
    const write = vi.spyOn(h.bridge, 'fileAtomicWrite');
    const res = await put(unknownId, 'MOTD.cfg', { content: 'hello\n' });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toMatchObject({ message: 'not_found' });
    expect(write).not.toHaveBeenCalled();
    expect(readDisk(unknownId, 'MOTD.cfg')).toBeUndefined();
  });

  it('PUT on a soft-deleted server is 404 and adds no history row', async () => {
    const id = await createServer();
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, id));
    const write = vi.spyOn(h.bridge, 'fileAtomicWrite');

    const res = await put(id, 'Admins.cfg', { content: 'Admin=76561198000000001:Admin\n' });

    expect(res.statusCode, res.body).toBe(404);
    expect(write).not.toHaveBeenCalled();
    const rows = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(eq(configVersions.serverId, id));
    expect(rows).toHaveLength(0);
  });

  it('restore on a soft-deleted server is 404', async () => {
    const id = await createServer();
    const first = await put(id, 'MOTD.cfg', { content: 'one\n' });
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, id));
    const write = vi.spyOn(h.bridge, 'fileAtomicWrite');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/restore/${first.json<{ version_id: string }>().version_id}`,
      headers: { cookie: ownerCookie },
      payload: {},
    });

    expect(res.statusCode, res.body).toBe(404);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a user message that spoofs the deletion-backup marker', async () => {
    const id = await createServer();
    const res = await put(id, 'MOTD.cfg', {
      content: 'hello\n',
      message: 'deletion-backup-marker 2026-01-01T00:00:00.000Z',
    });
    expect(res.statusCode, res.body).toBe(400);

    const restore = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/drift/accept`,
      headers: { cookie: ownerCookie },
      payload: { message: '  Deletion-Backup-Marker' },
    });
    expect(restore.statusCode, restore.body).toBe(400);
  });
});

describe('Rcon.cfg password and port stay panel-managed (#280)', () => {
  it('a masked round-trip that edits another line writes the panel password', async () => {
    const id = await createServer();
    const { password, port } = await panelRcon(id);
    setDisk(id, 'Rcon.cfg', rconCfg(port, password));

    const res = await put(id, 'Rcon.cfg', { content: rconCfg(port, MASK, 9) });

    expect(res.statusCode, res.body).toBe(200);
    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(port, password, 9));
  });

  it('refuses a Port change that server_credentials would not follow', async () => {
    const id = await createServer();
    const { password, port } = await panelRcon(id);
    setDisk(id, 'Rcon.cfg', rconCfg(port, password));

    const res = await put(id, 'Rcon.cfg', { content: rconCfg(port + 1, MASK) });

    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('rcon_credentials_managed');
    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(port, password));
  });

  it('refuses a new plaintext password that server_credentials would not follow', async () => {
    const id = await createServer();
    const { password, port } = await panelRcon(id);
    setDisk(id, 'Rcon.cfg', rconCfg(port, password));

    const res = await put(id, 'Rcon.cfg', { content: rconCfg(port, 'Typed-New-Pw-1') });

    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('rcon_credentials_managed');
    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(port, password));
  });

  it('drift accept refuses to adopt an out-of-band password', async () => {
    const id = await createServer();
    const { password, port } = await panelRcon(id);
    setDisk(id, 'Rcon.cfg', rconCfg(port, password));
    await put(id, 'Rcon.cfg', { content: rconCfg(port, MASK, 6) });
    setDisk(id, 'Rcon.cfg', rconCfg(port, 'Out-Of-Band-Pw', 6));

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/drift/accept`,
      headers: { cookie: ownerCookie },
      payload: {},
    });

    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('rcon_credentials_managed');
  });
});

describe('concurrent writes of one file are serialized (#282)', () => {
  it('the DB tip always describes the bytes on disk', async () => {
    const id = await createServer();
    const path = diskPath(id, 'MOTD.cfg');
    const original = h.bridge.fileAtomicWrite;
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aAtGate: () => void = () => undefined;
    const aReachedGate = new Promise<void>((resolve) => {
      aAtGate = resolve;
    });
    h.bridge.fileAtomicWrite = vi.fn(async (params) => {
      const result = await original(params);
      // Hold A between its disk write and its history insert until B is done,
      // or until B is parked on the per-file advisory lock A holds.
      if (params.path === path && params.content === 'A\n') {
        aAtGate();
        await gateA;
      }
      return result;
    });

    const a = put(id, 'MOTD.cfg', { content: 'A\n' });
    await aReachedGate;
    const b = put(id, 'MOTD.cfg', { content: 'B\n' });
    await Promise.race([waitForBlockedBackendOn(h.url, 5_000), b]);
    releaseA();
    const [resA, resB] = await Promise.all([a, b]);

    expect(resA.statusCode, resA.body).toBe(200);
    expect(resB.statusCode, resB.body).toBe(200);
    const [tip] = await h.db
      .select({ content: configVersions.content })
      .from(configVersions)
      .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, 'MOTD.cfg')))
      .orderBy(desc(configVersions.createdAt))
      .limit(1);
    expect(tip?.content).toBe(readDisk(id, 'MOTD.cfg'));
  });

  it('a failed disk write leaves no history row behind', async () => {
    const id = await createServer();
    h.bridge.fileAtomicWrite = vi.fn(async () => {
      throw new Error('bridge down');
    });
    const res = await put(id, 'MOTD.cfg', { content: 'lost\n' });
    expect(res.statusCode).toBe(500);
    const rows = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(eq(configVersions.serverId, id));
    expect(rows).toHaveLength(0);
  });
});

describe('history and diff read only what they return (#284)', () => {
  it('history reports the UTF-8 byte size of each version', async () => {
    const id = await createServer();
    await put(id, 'MOTD.cfg', { content: 'Привет\n' });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/history`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: Array<{ size: number }> }>().items[0]?.size).toBe(
      Buffer.byteLength('Привет\n', 'utf-8'),
    );
  });

  it('diff only resolves versions of the requested file', async () => {
    const id = await createServer();
    const motd = await put(id, 'MOTD.cfg', { content: 'one\n' });
    const other = await put(id, 'ServerMessages.cfg', { content: 'two\n' });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/diff?from=${motd.json<{ version_id: string }>().version_id}&to=${other.json<{ version_id: string }>().version_id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe('diff and blame are bounded (#283)', () => {
  function unrelatedLines(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n');
  }

  it('answers 422 diff_too_large instead of blocking on two unrelated 1 MiB versions', async () => {
    const id = await createServer();
    const inserted = await h.db
      .insert(configVersions)
      .values(
        ['x', 'y'].map((prefix, i) => ({
          serverId: id,
          filename: 'MOTD.cfg',
          content: unrelatedLines(prefix, 120_000),
          sha256: Buffer.alloc(32, i + 1),
          authorLabel: 'system',
          message: `big ${prefix}`,
          createdAt: new Date(Date.now() + i),
        })),
      )
      .returning({ id: configVersions.id });

    const started = Date.now();
    const diff = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/diff?from=${inserted[0]?.id}&to=${inserted[1]?.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(diff.statusCode, diff.body.slice(0, 200)).toBe(422);
    expect(diff.json()).toMatchObject({ error: 'diff_too_large' });

    const blame = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/blame`,
      headers: { cookie: ownerCookie },
    });
    expect(blame.statusCode, blame.body.slice(0, 200)).toBe(422);
    expect(blame.json()).toMatchObject({ error: 'diff_too_large' });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
