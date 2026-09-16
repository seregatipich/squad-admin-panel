import { createServer as createNetServer, type Socket } from 'node:net';
import { withAdminsCfgServerLock } from '@squad/db';
import { configVersions, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000000999n;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  await h.cleanup();
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
      display_name: 'Cfg Server',
      slug: 'cfg-server',
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

function seedFakeConfig(id: string, name: string, content: string) {
  h.bridge.files.set(`${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/${name}`, Buffer.from(content));
}

/**
 * Minimal Valve-RCON-speaking TCP server for integration tests. Accepts
 * the AUTH packet, echoes an empty SERVERDATA_RESPONSE_VALUE for each
 * EXECCOMMAND, and remembers the command bodies so the test can assert
 * which RCON commands the panel emitted.
 */
async function startFakeRcon(): Promise<{
  port: number;
  receivedCommands: string[];
  close: () => void;
}> {
  const received: string[] = [];
  const server = createNetServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.byteLength >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.byteLength - 4 < size) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + size - 2).toString('utf-8');
        buf = buf.subarray(4 + size);

        if (!authed && type === 3 /* SERVERDATA_AUTH */) {
          // Valve protocol quirk: Squad emits two packets for the AUTH
          // response — a zero-length SERVERDATA_RESPONSE_VALUE followed by
          // the actual SERVERDATA_AUTH_RESPONSE. The panel client is
          // tolerant; we send the short form.
          const resp = Buffer.alloc(14);
          resp.writeInt32LE(10, 0);
          resp.writeInt32LE(id, 4);
          resp.writeInt32LE(2 /* SERVERDATA_AUTH_RESPONSE */, 8);
          sock.write(resp);
          authed = true;
        } else if (authed && type === 2 /* SERVERDATA_EXECCOMMAND */) {
          if (body) received.push(body);
          const resp = Buffer.alloc(14);
          resp.writeInt32LE(10, 0);
          resp.writeInt32LE(id, 4);
          resp.writeInt32LE(0 /* SERVERDATA_RESPONSE_VALUE */, 8);
          sock.write(resp);
        }
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === 'object' && 'port' in addr ? (addr.port as number) : 0;
  if (!port) throw new Error('fake RCON port not assigned');
  return {
    port,
    receivedCommands: received,
    close: () => server.close(),
  };
}

describe('GET /api/v1/servers/:id/configs', () => {
  it('lists every allowlisted file with existence flag and sha', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    seedFakeConfig(id, 'Admins.cfg', '// admins');
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ items: Array<{ name: string; exists: boolean }> }>();
    expect(body.items.length).toBeGreaterThanOrEqual(19);
    const admins = body.items.find((i) => i.name === 'Admins.cfg');
    expect(admins?.exists).toBe(true);
    const absent = body.items.find((i) => i.name !== 'Admins.cfg' && !i.exists);
    expect(absent?.exists).toBe(false);
  });

  it('returns 404 for an unknown server id', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/019e0000-0000-7000-8000-000000000000/configs',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });
});

describe('GET /api/v1/servers/:id/configs/:name', () => {
  it('returns content + sha256 + behavior class for an allowed file', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    seedFakeConfig(id, 'Admins.cfg', 'line-1\nline-2');
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ content: string; sha256: string; behavior: string }>();
    expect(body.content).toBe('line-1\nline-2');
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.behavior).toBe('string');
  });

  it('400 for a file outside the allowlist', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/evil.conf`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json()).toEqual({ error: 'file_not_in_allowlist' });
  });
});

describe('PUT /api/v1/servers/:id/configs/:name auto-reloads Squad', () => {
  // These cases exercise the RCON reload path, which now fires only for
  // hot_reload files (CFG-1, #63) — Admins.cfg is one, so they write it.
  it('reports reload.applied=false / reason=not_running when server status is pending', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'ServerName="x"' },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      reload: { applied: boolean; reason?: string; detail?: string };
    }>();
    expect(body.reload.applied).toBe(false);
    expect(body.reload.reason).toBe('not_running');
  });

  it('fires AdminReloadServerConfig when the server is running', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    // Force status=running so reloadServerConfig gets past the guard.
    await h.db
      .update(servers)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(servers.id, id));
    // Point the RCON client at a tiny in-process fake server that accepts
    // the Valve-RCON AUTH handshake and echoes back the command.
    const fake = await startFakeRcon();
    try {
      await h.db
        .update(serverCredentials)
        .set({ rconHost: '127.0.0.1', rconPort: fake.port })
        .where(eq(serverCredentials.serverId, id));

      const resp = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/servers/${id}/configs/Admins.cfg`,
        headers: { cookie },
        payload: { content: 'ServerName="y"' },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        reload: { applied: true; via: string; command: string };
      }>();
      expect(body.reload.applied).toBe(true);
      expect(body.reload.via).toBe('rcon');
      expect(body.reload.command).toBe('AdminReloadServerConfig');
      expect(fake.receivedCommands).toContain('AdminReloadServerConfig');
    } finally {
      fake.close();
    }
  });

  it('falls back to RCON_HOST_DEFAULT when credentials leave rcon_host NULL', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await h.db
      .update(servers)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(servers.id, id));
    // Verify POST /servers left rcon_host as NULL (regression for 0007).
    const [credsBefore] = await h.db
      .select()
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, id));
    expect(credsBefore?.rconHost).toBeNull();

    const fake = await startFakeRcon();
    const prev = process.env.RCON_HOST_DEFAULT;
    process.env.RCON_HOST_DEFAULT = '127.0.0.1';
    try {
      await h.db
        .update(serverCredentials)
        .set({ rconPort: fake.port })
        .where(eq(serverCredentials.serverId, id));

      const resp = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/servers/${id}/configs/Admins.cfg`,
        headers: { cookie },
        payload: { content: 'ServerName="fallback"' },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        reload: { applied: boolean; via?: string; command?: string; reason?: string };
      }>();
      expect(body.reload.applied, JSON.stringify(body.reload)).toBe(true);
      expect(body.reload.command).toBe('AdminReloadServerConfig');
      expect(fake.receivedCommands).toContain('AdminReloadServerConfig');
    } finally {
      if (prev === undefined) delete process.env.RCON_HOST_DEFAULT;
      else process.env.RCON_HOST_DEFAULT = prev;
      fake.close();
    }
  });

  it('reports reload.applied=false with reason=rcon_failed when no RCON listener answers', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await h.db
      .update(servers)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(servers.id, id));
    // Port 1 is privileged and nothing on localhost listens there — connect
    // attempt must be refused quickly and surfaced as rcon_failed, not crash.
    await h.db
      .update(serverCredentials)
      .set({ rconHost: '127.0.0.1', rconPort: 1 })
      .where(eq(serverCredentials.serverId, id));

    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'ServerName="no-listener"' },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      unchanged: boolean;
      reload: { applied: boolean; reason?: string; detail?: string };
    }>();
    expect(body.unchanged).toBe(false); // write still succeeded
    expect(body.reload.applied).toBe(false);
    expect(body.reload.reason).toBe('rcon_failed');
    expect(body.reload.detail).toBeTruthy();
  });
});

describe('PUT /api/v1/servers/:id/configs/:name gates reload on hot_reload (CFG-1, #63)', () => {
  it('does NOT fire RCON for a requires_restart file, returns reason=not_hot_reload', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    // Running server with a reachable fake RCON: proves the gate short-circuits
    // BEFORE any RCON command, not merely because the server is unreachable.
    await h.db
      .update(servers)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(servers.id, id));
    const fake = await startFakeRcon();
    try {
      await h.db
        .update(serverCredentials)
        .set({ rconHost: '127.0.0.1', rconPort: fake.port })
        .where(eq(serverCredentials.serverId, id));

      const resp = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/servers/${id}/configs/Server.cfg`,
        headers: { cookie },
        payload: { content: 'ServerName="requires-restart"' },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{
        unchanged: boolean;
        reload: { applied: boolean; reason?: string };
      }>();
      expect(body.unchanged).toBe(false); // the write still happened
      expect(body.reload.applied).toBe(false);
      expect(body.reload.reason).toBe('not_hot_reload');
      expect(fake.receivedCommands).not.toContain('AdminReloadServerConfig');
      expect(fake.receivedCommands).toHaveLength(0);
    } finally {
      fake.close();
    }
  });

  it('does NOT fire RCON for a rotation file (LayerRotation.cfg), returns reason=not_hot_reload', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await h.db
      .update(servers)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(servers.id, id));
    const fake = await startFakeRcon();
    try {
      await h.db
        .update(serverCredentials)
        .set({ rconHost: '127.0.0.1', rconPort: fake.port })
        .where(eq(serverCredentials.serverId, id));

      const resp = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/servers/${id}/configs/LayerRotation.cfg`,
        headers: { cookie },
        payload: { content: 'Yehorivka RAAS v1' },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json<{ reload: { applied: boolean; reason?: string } }>();
      expect(body.reload.applied).toBe(false);
      expect(body.reload.reason).toBe('not_hot_reload');
      expect(fake.receivedCommands).toHaveLength(0);
    } finally {
      fake.close();
    }
  });
});

describe('PUT /api/v1/servers/:id/configs/:name', () => {
  it('serializes an Admins.cfg PUT behind the same server fence as delivery', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const path = `${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/Admins.cfg`;

    let releaseDelivery!: () => void;
    let reportDeliveryLocked!: () => void;
    let reportApiWrite!: () => void;
    const deliveryLocked = new Promise<void>((resolve) => {
      reportDeliveryLocked = resolve;
    });
    const apiWriteEntered = new Promise<void>((resolve) => {
      reportApiWrite = resolve;
    });
    const deliveryRelease = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const originalAtomicWrite = h.bridge.fileAtomicWrite;
    h.bridge.fileAtomicWrite = vi.fn(async (params) => {
      reportApiWrite();
      return originalAtomicWrite(params);
    });

    const delivery = withAdminsCfgServerLock(h.db, id, async () => {
      h.bridge.files.set(path, Buffer.from('// projection after refund\n'));
      reportDeliveryLocked();
      await deliveryRelease;
    });
    await deliveryLocked;

    const stalePut = h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'Manual=editor after delivery' },
    });
    const wroteBeforeDeliveryCommit = await Promise.race([
      apiWriteEntered.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseDelivery();

    const [, response] = await Promise.all([delivery, stalePut]);
    expect(wroteBeforeDeliveryCommit).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(h.bridge.files.get(path)?.toString()).toContain('Manual=editor after delivery');
  });

  it('writes a new version, persists sha, invokes bridge atomic write, writes audit row', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'updated content', message: 'first edit' },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ unchanged: boolean; version_id: string; sha256: string }>();
    expect(body.unchanged).toBe(false);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const versions = await h.db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, 'Admins.cfg')));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.message).toBe('first edit');
    expect(
      h.bridge.files.get(`${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/Admins.cfg`)?.toString(),
    ).toBe('updated content');
    await assertAuditRow(h, { action: 'server.config.write', resource: 'server', targetId: id });
  });

  it('second PUT with identical content is a no-op (unchanged=true, no new version)', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const payload = { content: 'same content' };
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload,
    });
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload,
    });
    expect(resp.json<{ unchanged: boolean }>().unchanged).toBe(true);
    const versions = await h.db
      .select()
      .from(configVersions)
      .where(eq(configVersions.serverId, id));
    expect(versions).toHaveLength(1);
  });

  it('round-trips a CRLF payload byte-identically through PUT → GET and into config_versions', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const crlf = '[SquadName]\r\nServerName="Test"\r\nMaxPlayers=80\r\n';
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Server.cfg`,
      headers: { cookie },
      payload: { content: crlf },
    });
    expect(put.statusCode).toBe(200);

    const get = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Server.cfg`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ content: string }>().content).toBe(crlf);

    const [row] = await h.db
      .select({ content: configVersions.content })
      .from(configVersions)
      .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, 'Server.cfg')));
    expect(row?.content).toBe(crlf);
    // the bridge stored the exact bytes on disk too
    expect(
      h.bridge.files.get(`${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/Server.cfg`)?.toString('utf-8'),
    ).toBe(crlf);
  });
});

describe('GET /api/v1/servers/:id/configs/:name/history + :vid + /diff + /blame', () => {
  it('history lists versions newest first', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'v1', message: 'a' },
    });
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'v2', message: 'b' },
    });
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Admins.cfg/history`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ items: Array<{ message: string; size: number }> }>();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.message).toBe('b');
    expect(body.items[1]?.message).toBe('a');
  });

  it('single version read returns its full content', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'abc\ndef' },
    });
    const { version_id } = put.json<{ version_id: string }>();
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Admins.cfg/versions/${version_id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json<{ content: string }>().content).toBe('abc\ndef');
  });

  it('diff between two versions returns a unified patch', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const a = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'hello\nworld' },
    });
    const b = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'hello\nUNIVERSE' },
    });
    const from = a.json<{ version_id: string }>().version_id;
    const to = b.json<{ version_id: string }>().version_id;
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Admins.cfg/diff?from=${from}&to=${to}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ patch: string }>();
    expect(body.patch).toContain('-world');
    expect(body.patch).toContain('+UNIVERSE');
  });

  it('blame returns per-line attribution and is re-served from the Redis cache', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'x\ny' },
    });
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'x\nY' },
    });
    const first = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Admins.cfg/blame`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json<{ lines: Array<{ text: string; version_id: string }> }>();
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]?.text).toBe('x');
    expect(body.lines[1]?.text).toBe('Y');

    const cached = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Admins.cfg/blame`,
      headers: { cookie },
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.body).toBe(first.body);
  });
});

describe('POST /api/v1/servers/:id/configs/:name/restore/:vid', () => {
  it('creates a new version with the restored content and writes a restore audit row', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'original' },
    });
    const v2 = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'mistaken' },
    });
    // Two PUTs above guarantee at least one prior version exists, so the
    // oldest history entry (at(-1)) is always present.
    const v1 = (
      await h.app.inject({
        method: 'GET',
        url: `/api/v1/servers/${id}/configs/Admins.cfg/history`,
        headers: { cookie },
      })
    )
      .json<{ items: Array<{ id: string }> }>()
      .items.at(-1) as { id: string };
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Admins.cfg/restore/${v1.id}`,
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(200);
    const versions = await h.db
      .select()
      .from(configVersions)
      .where(eq(configVersions.serverId, id));
    expect(versions).toHaveLength(3);
    // toHaveLength(3) above guarantees the array is non-empty, so index 0 is defined.
    const restored = versions.sort(
      (a, b) => +b.createdAt - +a.createdAt,
    )[0] as (typeof versions)[number];
    expect(restored.content).toBe('original');
    await assertAuditRow(h, { action: 'server.config.restore', resource: 'server', targetId: id });
    void v2;
  });

  it('restoring the tip version repairs an out-of-band disk edit byte-for-byte (CFG-2 #64)', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const crlf = '[SquadName]\r\nServerName="Tip"\r\nMaxPlayers=80\r\n';
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Server.cfg`,
      headers: { cookie },
      payload: { content: crlf },
    });
    expect(put.statusCode).toBe(200);
    const vid = put.json<{ version_id: string }>().version_id;
    // Out-of-band SSH edit while the DB tip stays put — restoring the tip
    // version dedups by sha, but must still converge the disk.
    h.bridge.files.set(
      `${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/Server.cfg`,
      Buffer.from('tampered over ssh\n', 'utf-8'),
    );

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Server.cfg/restore/${vid}`,
      headers: { cookie },
      payload: {},
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ unchanged: boolean; disk_repaired?: boolean }>();
    expect(body.unchanged).toBe(true);
    expect(body.disk_repaired).toBe(true);

    // Byte-for-byte, CRLF preserved — no newline normalization anywhere.
    const disk = h.bridge.files.get(`${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/Server.cfg`);
    expect(disk).toBeDefined();
    expect(Buffer.from(crlf, 'utf-8').equals(disk as Buffer)).toBe(true);

    // No duplicate history row on the unchanged path.
    const versions = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, 'Server.cfg')));
    expect(versions).toHaveLength(1);
  });
});

describe('schema guardrails for config editor', () => {
  it('server_settings row created alongside server', async () => {
    const cookie = await login();
    const id = await createServer(cookie);
    const s = await h.db.query.servers.findFirst({ where: eq(servers.id, id) });
    expect(s).toBeDefined();
    const settings = await h.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, id),
    });
    expect(settings).toBeDefined();
  });
});
