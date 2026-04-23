import { configVersions, serverSettings, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './harness.js';

const EMAIL = 'owner@test.local';
const PASSWORD = 'correct-horse-battery-staple';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { email: EMAIL, password: PASSWORD },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function login(): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  if (resp.statusCode !== 200) throw new Error(`login failed: ${resp.body}`);
  const raw = Array.isArray(resp.headers['set-cookie'])
    ? resp.headers['set-cookie'][0]!
    : (resp.headers['set-cookie'] as string);
  return raw.match(/(__Host-sid=[^;]+)/)?.[1]!;
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

describe('PUT /api/v1/servers/:id/configs/:name', () => {
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
    const v1 = (
      await h.app.inject({
        method: 'GET',
        url: `/api/v1/servers/${id}/configs/Admins.cfg/history`,
        headers: { cookie },
      })
    )
      .json<{ items: Array<{ id: string }> }>()
      .items.at(-1)!;
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
    const restored = versions.sort((a, b) => +b.createdAt - +a.createdAt)[0]!;
    expect(restored.content).toBe('original');
    await assertAuditRow(h, { action: 'server.config.restore', resource: 'server', targetId: id });
    void v2;
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
