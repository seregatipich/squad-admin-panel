// CFG-2 (#64): generic config drift detection + resolution. Out-of-band disk
// edits (e.g. over SSH) are surfaced via GET /configs/drift, inspectable via
// /drift/diff, and resolvable either way: accept (record the disk bytes as a
// new version) or revert (repair the disk back to the DB tip byte-for-byte).
// reset-default re-seeds a file from the SteamCMD depot template with the
// install-time Rcon/Server rewrites so the RCON password survives.
import { configVersions, serverCredentials, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decryptString, deserialize } from '../../src/lib/crypto.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000064064n;
// PANEL_DEPOT_HOST_PATH is resolved on every call by server-install.ts, so a
// per-file env override needs no dynamic module reload.
const DEPOT_ROOT = '/depot-test-64';
const DEPOT_CONFIG_DIR = `${DEPOT_ROOT}/SquadGame/ServerConfig`;

let h: IntegrationHarness;
let prevDepotEnv: string | undefined;

beforeAll(async () => {
  prevDepotEnv = process.env.PANEL_DEPOT_HOST_PATH;
  process.env.PANEL_DEPOT_HOST_PATH = DEPOT_ROOT;
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

beforeEach(async () => {
  // Every case creates the same "drift-server" slug and ports; retire the
  // previous case's server so the create succeeds, and drop the fake disk
  // (including seeded depot templates) along with any swapped bridge method.
  await h.db.update(servers).set({ deletedAt: new Date() }).where(isNull(servers.deletedAt));
  Object.assign(h.bridge, makeFakeBridge());
});

afterAll(async () => {
  if (prevDepotEnv === undefined) delete process.env.PANEL_DEPOT_HOST_PATH;
  else process.env.PANEL_DEPOT_HOST_PATH = prevDepotEnv;
  await h?.cleanup();
});

async function login(): Promise<string> {
  return loginAsOwner(h);
}

async function createServer(cookie: string): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: {
      display_name: 'Drift Server',
      slug: 'drift-server',
      game_port: 7791,
      query_port: 27167,
      beacon_port: 15002,
      rcon_port: 21116,
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

async function putConfig(cookie: string, id: string, name: string, content: string) {
  const resp = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/servers/${id}/configs/${name}`,
    headers: { cookie },
    payload: { content },
  });
  expect(resp.statusCode, resp.body).toBe(200);
  return resp.json<{ version_id: string; sha256: string }>();
}

interface DriftItem {
  name: string;
  state: 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';
  disk_sha256: string | null;
  version_sha256: string | null;
  tip_version_id: string | null;
}

describe('POST /api/v1/servers/:id/configs/:name/drift/revert (CFG-2 #64)', () => {
  it('revert to unchanged DB tip repairs an out-of-band disk edit byte-for-byte', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const crlfTip = '[SquadName]\r\nServerName="Drift"\r\nMaxPlayers=80\r\n';
    await putConfig(cookie, id, 'Server.cfg', crlfTip);
    // Out-of-band SSH edit: different bytes AND different line endings.
    h.bridge.files.set(
      diskPath(id, 'Server.cfg'),
      Buffer.from('[SquadName]\nServerName="hacked"\n', 'utf-8'),
    );

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Server.cfg/drift/revert`,
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode, resp.body).toBe(200);
    const body = resp.json<{ ok: boolean; unchanged: boolean; disk_repaired: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.unchanged).toBe(true);
    expect(body.disk_repaired).toBe(true);

    // AC-1: byte-for-byte restore including CRLF.
    const disk = h.bridge.files.get(diskPath(id, 'Server.cfg'));
    expect(disk).toBeDefined();
    expect(Buffer.from(crlfTip, 'utf-8').equals(disk as Buffer)).toBe(true);

    // Revert must NOT append a duplicate history row.
    const versions = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, 'Server.cfg')));
    expect(versions).toHaveLength(1);

    await assertAuditRow(h, {
      action: 'server.config.drift_revert',
      resource: 'server',
      targetId: id,
    });
  });

  it('revert repairs a deleted file back onto disk', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const tip = 'Welcome to the server\r\n';
    await putConfig(cookie, id, 'MOTD.cfg', tip);
    h.bridge.files.delete(diskPath(id, 'MOTD.cfg'));

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/drift/revert`,
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode, resp.body).toBe(200);
    const disk = h.bridge.files.get(diskPath(id, 'MOTD.cfg'));
    expect(disk).toBeDefined();
    expect(Buffer.from(tip, 'utf-8').equals(disk as Buffer)).toBe(true);
  });

  it('404 version_not_found when the file has no history', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/drift/revert`,
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json()).toEqual({ error: 'version_not_found' });
  });
});

describe('GET /api/v1/servers/:id/configs/drift (CFG-2 #64)', () => {
  it('GET configs/drift reports drift for an out-of-band edit and in_sync otherwise', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await putConfig(cookie, id, 'Server.cfg', 'ServerName="A"\r\n');
    await putConfig(cookie, id, 'MOTD.cfg', 'panel text\r\n');
    h.bridge.files.set(diskPath(id, 'MOTD.cfg'), Buffer.from('ssh edit\r\n', 'utf-8'));
    await putConfig(cookie, id, 'Bans.cfg', 'ban list');
    h.bridge.files.delete(diskPath(id, 'Bans.cfg'));
    // Simulate a bridge transport failure for exactly one file.
    const originalFileRead = h.bridge.fileRead;
    h.bridge.fileRead = async (p: { path: string }) => {
      if (p.path.endsWith('/Rcon.cfg')) throw new Error('bridge timeout');
      return originalFileRead(p);
    };
    await h.db.insert(configVersions).values({
      serverId: id,
      filename: 'Rcon.cfg',
      content: 'Port=1\n',
      sha256: Buffer.alloc(32),
      parentVersionId: null,
      authorPlayerId: null,
      authorLabel: 'system',
      authorIp: null,
      message: 'seed',
    });

    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/drift`,
      headers: { cookie },
    });
    expect(resp.statusCode, resp.body).toBe(200);
    const body = resp.json<{ items: DriftItem[]; checked_at: string }>();
    expect(typeof body.checked_at).toBe('string');

    const byName = new Map(body.items.map((i) => [i.name, i]));
    expect(byName.get('Server.cfg')?.state).toBe('in_sync');
    expect(byName.get('Server.cfg')?.disk_sha256).toBe(byName.get('Server.cfg')?.version_sha256);
    expect(byName.get('Server.cfg')?.tip_version_id).toBeTruthy();
    expect(byName.get('MOTD.cfg')?.state).toBe('drift');
    expect(byName.get('MOTD.cfg')?.disk_sha256).not.toBe(byName.get('MOTD.cfg')?.version_sha256);
    expect(byName.get('Bans.cfg')?.state).toBe('missing');
    expect(byName.get('Bans.cfg')?.disk_sha256).toBeNull();
    expect(byName.get('Rcon.cfg')?.state).toBe('unreachable');
    // Never versioned nor written → no baseline to compare against.
    expect(byName.get('VoteConfig.cfg')?.state).toBe('unknown');
    expect(byName.get('VoteConfig.cfg')?.version_sha256).toBeNull();

    // Managed / panel-owned files are excluded from the generic sweep set.
    expect(body.items).toHaveLength(16);
    expect(byName.has('Admins.cfg')).toBe(false);
    expect(byName.has('LayerRotation.cfg')).toBe(false);
    expect(byName.has('License.cfg')).toBe(false);
  });

  it('404 for an unknown server id', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/019e0000-0000-7000-8000-000000000064/configs/drift',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });
});

describe('GET /api/v1/servers/:id/configs/:name/drift/diff (CFG-2 #64)', () => {
  it('drift diff returns a unified patch', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await putConfig(cookie, id, 'Server.cfg', 'Common\r\npanel-only\r\n');
    h.bridge.files.set(diskPath(id, 'Server.cfg'), Buffer.from('Common\r\ndisk-only\r\n', 'utf-8'));

    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Server.cfg/drift/diff`,
      headers: { cookie },
    });
    expect(resp.statusCode, resp.body).toBe(200);
    const body = resp.json<{ name: string; diff: string }>();
    expect(body.name).toBe('Server.cfg');
    expect(body.diff).toContain('-panel-only');
    expect(body.diff).toContain('+disk-only');
    expect(body.diff).toContain('panel');
    expect(body.diff).toContain('disk');
  });

  it('404 file_not_found when the file is absent from disk', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await putConfig(cookie, id, 'MOTD.cfg', 'text');
    h.bridge.files.delete(diskPath(id, 'MOTD.cfg'));
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/drift/diff`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json<{ error: string }>().error).toBe('file_not_found');
  });

  it('404 version_not_found when the file has no history', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    h.bridge.files.set(diskPath(id, 'MOTD.cfg'), Buffer.from('untracked', 'utf-8'));
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/drift/diff`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json<{ error: string }>().error).toBe('version_not_found');
  });
});

describe('POST /api/v1/servers/:id/configs/:name/drift/accept (CFG-2 #64)', () => {
  it('accept records the disk bytes as a new version and leaves disk untouched', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await putConfig(cookie, id, 'MOTD.cfg', 'panel text\r\n');
    const sshBytes = Buffer.from('ssh edit\r\nsecond line\r\n', 'utf-8');
    h.bridge.files.set(diskPath(id, 'MOTD.cfg'), sshBytes);

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/MOTD.cfg/drift/accept`,
      headers: { cookie },
      payload: { message: 'принято из ssh' },
    });
    expect(resp.statusCode, resp.body).toBe(200);
    const body = resp.json<{ unchanged: boolean; version_id: string }>();
    expect(body.unchanged).toBe(false);
    expect(body.version_id).toBeTruthy();

    const versions = await h.db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, 'MOTD.cfg')));
    expect(versions).toHaveLength(2);
    const tip = versions.sort((a, b) => +b.createdAt - +a.createdAt)[0];
    expect(tip?.content).toBe(sshBytes.toString('utf-8'));
    expect(tip?.message).toBe('принято из ssh');

    // The disk bytes stay exactly as the operator left them.
    const disk = h.bridge.files.get(diskPath(id, 'MOTD.cfg'));
    expect(disk).toBeDefined();
    expect(sshBytes.equals(disk as Buffer)).toBe(true);

    await assertAuditRow(h, {
      action: 'server.config.drift_accept',
      resource: 'server',
      targetId: id,
    });
  });

  it('revert/accept on a clean file → 409 no_drift', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await putConfig(cookie, id, 'Server.cfg', 'ServerName="clean"\r\n');
    for (const action of ['accept', 'revert'] as const) {
      const resp = await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${id}/configs/Server.cfg/drift/${action}`,
        headers: { cookie },
        payload: {},
      });
      expect(resp.statusCode, `${action}: ${resp.body}`).toBe(409);
      expect(resp.json()).toEqual({ error: 'no_drift' });
    }
  });
});

describe('POST /api/v1/servers/:id/configs/:name/reset-default (CFG-2 #64)', () => {
  it('reset-default writes the depot template with Rcon/Server rewrites', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    h.bridge.files.set(
      `${DEPOT_CONFIG_DIR}/Rcon.cfg`,
      Buffer.from('Port=0\r\nPassword=CHANGEME\r\n', 'utf-8'),
    );
    h.bridge.files.set(
      `${DEPOT_CONFIG_DIR}/Server.cfg`,
      Buffer.from('ServerName="Depot Default"\r\nMaxPlayers=100\r\n', 'utf-8'),
    );
    await putConfig(cookie, id, 'Rcon.cfg', 'Port=9\nPassword=broken\n');

    const resetRcon = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/reset-default`,
      headers: { cookie },
      payload: { message: 'сброс' },
    });
    expect(resetRcon.statusCode, resetRcon.body).toBe(200);

    // The install-time rewrite must survive the reset: the real RCON port and
    // password land in the file, not the depot placeholders.
    const [creds] = await h.db
      .select()
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, id));
    expect(creds).toBeDefined();
    const realPassword = decryptString(
      h.app.encryptionKey,
      deserialize(Buffer.from(creds?.rconPasswordEncrypted as unknown as Buffer)),
    );
    const rconDisk = h.bridge.files.get(diskPath(id, 'Rcon.cfg'))?.toString('utf-8') ?? '';
    expect(rconDisk).toContain(`Port=${creds?.rconPort}`);
    expect(rconDisk).toContain(`Password=${realPassword}`);
    expect(rconDisk).not.toContain('CHANGEME');

    const resetServer = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Server.cfg/reset-default`,
      headers: { cookie },
      payload: {},
    });
    expect(resetServer.statusCode, resetServer.body).toBe(200);
    const serverDisk = h.bridge.files.get(diskPath(id, 'Server.cfg'))?.toString('utf-8') ?? '';
    expect(serverDisk).toContain('ServerName="Drift Server"');
    expect(serverDisk).toContain('MaxPlayers=100');

    await assertAuditRow(h, {
      action: 'server.config.reset_default',
      resource: 'server',
      targetId: id,
    });
  });

  it('→ 422 depot_default_unavailable when depot file missing', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/VoteConfig.cfg/reset-default`,
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode, resp.body).toBe(422);
    expect(resp.json()).toEqual({ error: 'depot_default_unavailable' });
  });
});

describe('drift/reset guards (CFG-2 #64)', () => {
  it('License.cfg and managed files are rejected with 400 on all drift/reset routes', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const routes = (name: string) => [
      { method: 'GET' as const, url: `/api/v1/servers/${id}/configs/${name}/drift/diff` },
      { method: 'POST' as const, url: `/api/v1/servers/${id}/configs/${name}/drift/accept` },
      { method: 'POST' as const, url: `/api/v1/servers/${id}/configs/${name}/drift/revert` },
      { method: 'POST' as const, url: `/api/v1/servers/${id}/configs/${name}/reset-default` },
    ];
    const cases: Array<{ name: string; error: string }> = [
      { name: 'License.cfg', error: 'panel_managed_file' },
      { name: 'Admins.cfg', error: 'managed_file' },
      { name: 'LayerRotation.cfg', error: 'managed_file' },
      { name: 'Nope.cfg', error: 'file_not_in_allowlist' },
    ];
    for (const { name, error } of cases) {
      for (const r of routes(name)) {
        const resp = await h.app.inject({
          method: r.method,
          url: r.url,
          headers: { cookie },
          ...(r.method === 'POST' ? { payload: {} } : {}),
        });
        expect(resp.statusCode, `${r.method} ${r.url}: ${resp.body}`).toBe(400);
        expect(resp.json()).toEqual({ error });
      }
    }
  });
});
