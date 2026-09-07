import { serverLogSources, servers } from '@squad/db/schema';
import { logSourceStatusKey } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import { utils as sshUtils } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptString, deserialize } from '../../src/lib/crypto.js';
import { generateSshKeyPair } from '../../src/routes/server-log-source.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000000778n;

const externalBody = {
  display_name: '[RU] МирДружбаЖвачка ★ BSS ★ [МИКС]',
  slug: 'bss-a',
  rcon_host: '80.242.59.123',
  rcon_port: 7900,
  rcon_password: 'remote-rcon-secret',
  query_port: 7810,
  game_port: 7800,
};

const sourceBody = {
  ssh_host: '80.242.59.123',
  ssh_port: 22,
  ssh_user: 'squad',
  log_path: '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log',
};

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function createExternal(cookie: string, slug = externalBody.slug): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers/external',
    headers: { cookie },
    payload: { ...externalBody, slug },
  });
  expect(resp.statusCode).toBe(201);
  return resp.json<{ id: string }>().id;
}

describe('generateSshKeyPair', () => {
  it('produces a PKCS#1 PEM ssh2 can dial with and a matching authorized_keys line', () => {
    const pair = generateSshKeyPair('squad-admin-panel@tk104.duckdns.org');
    expect(pair.privateKeyPem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    const [type, blob, comment] = pair.publicKeyLine.split(' ');
    expect(type).toBe('ssh-rsa');
    expect(comment).toBe('squad-admin-panel@tk104.duckdns.org');
    const parsed = sshUtils.parseKey(pair.privateKeyPem);
    expect(parsed).not.toBeInstanceOf(Error);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    expect((key as { getPublicSSH(): Buffer }).getPublicSSH().toString('base64')).toBe(blob);
  });
});

describe('PUT /api/v1/servers/:id/log-source', () => {
  it('creates the source with a panel-generated key, encrypted at rest, and returns the public key', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createExternal(cookie);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: sourceBody,
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      configured: boolean;
      public_key: string;
      key_version: number;
      enabled: boolean;
      host_key_fingerprint: string | null;
      status: unknown;
      log_path: string;
    }>();
    expect(body).toMatchObject({
      configured: true,
      enabled: true,
      key_version: 1,
      host_key_fingerprint: null,
      status: null,
      log_path: sourceBody.log_path,
    });
    expect(body.public_key).toMatch(/^ssh-rsa [A-Za-z0-9+/=]+ squad-admin-panel@/);
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');

    const [row] = await h.db
      .select()
      .from(serverLogSources)
      .where(eq(serverLogSources.serverId, id));
    expect(row?.sshHost).toBe('80.242.59.123');
    expect(row?.sshUser).toBe('squad');
    const pem = decryptString(
      h.app.encryptionKey,
      deserialize(Buffer.from(row?.sshPrivateKeyEncrypted as unknown as Buffer)),
    );
    expect(pem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    const parsed = sshUtils.parseKey(pem);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    expect(`ssh-rsa ${(key as { getPublicSSH(): Buffer }).getPublicSSH().toString('base64')}`).toBe(
      body.public_key.split(' ').slice(0, 2).join(' '),
    );
    await assertAuditRow(h, {
      action: 'server.log_source.update',
      resource: 'server',
      targetId: id,
    });
  });

  it('keeps the key across edits, drops the host-key pin when the host changes, and rotates on request', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createExternal(cookie);
    const first = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: sourceBody,
    });
    const publicKey = first.json<{ public_key: string }>().public_key;
    // Simulate the worker's trust-on-first-use pin.
    await h.db
      .update(serverLogSources)
      .set({ hostKeyFingerprint: 'SHA256:pinned' })
      .where(eq(serverLogSources.serverId, id));

    const samePath = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: { ...sourceBody, log_path: '/opt/squad1/SquadGame/Saved/Logs/SquadGame_2.log' },
    });
    expect(samePath.json()).toMatchObject({
      public_key: publicKey,
      key_version: 1,
      host_key_fingerprint: 'SHA256:pinned',
      log_path: '/opt/squad1/SquadGame/Saved/Logs/SquadGame_2.log',
    });

    const moved = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: { ...sourceBody, ssh_host: 'other.example.org' },
    });
    expect(moved.json()).toMatchObject({
      public_key: publicKey,
      host_key_fingerprint: null,
      ssh_host: 'other.example.org',
    });

    const rotated = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: { ...sourceBody, regenerate_key: true },
    });
    const rotatedBody = rotated.json<{ public_key: string; key_version: number }>();
    expect(rotatedBody.key_version).toBe(2);
    expect(rotatedBody.public_key).not.toBe(publicKey);
  });

  it('answers 409 for a panel-hosted server and 400 for an unsafe path', async () => {
    const cookie = await loginAsOwner(h);
    const local = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        display_name: 'Panel Box',
        slug: 'panel-box',
        game_port: 7787,
        query_port: 27165,
        beacon_port: 15000,
        rcon_port: 21114,
      },
    });
    const localId = local.json<{ id: string }>().id;
    const refused = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${localId}/log-source`,
      headers: { cookie },
      payload: sourceBody,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'not_external_server' });

    const id = await createExternal(cookie);
    const unsafe = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: { ...sourceBody, log_path: "/opt/squad1/'; rm -rf /; '" },
    });
    expect([400, 422]).toContain(unsafe.statusCode);
    const rows = await h.db
      .select({ serverId: serverLogSources.serverId })
      .from(serverLogSources)
      .where(eq(serverLogSources.serverId, id));
    expect(rows).toHaveLength(0);
  });
});

describe('GET / DELETE /api/v1/servers/:id/log-source', () => {
  it('reports configured=false before setup and merges the worker status afterwards', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createExternal(cookie);
    const before = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ configured: false, status: null });

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: sourceBody,
    });
    await h.redis.set(
      logSourceStatusKey(id),
      JSON.stringify({
        state: 'connected',
        ts: '2026-09-07T10:00:00.000Z',
        lines: 1234,
        last_line_at: '2026-09-07T10:00:00.000Z',
        error: null,
        host_key_fingerprint: 'SHA256:abc',
      }),
    );
    const after = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
    });
    expect(after.json()).toMatchObject({
      configured: true,
      ssh_user: 'squad',
      status: { state: 'connected', lines: 1234 },
    });
  });

  it('DELETE removes the row and the status key; a second DELETE is 404', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createExternal(cookie);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: sourceBody,
    });
    await h.redis.set(logSourceStatusKey(id), JSON.stringify({ state: 'connecting', ts: 'x' }));
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    expect(await h.redis.get(logSourceStatusKey(id))).toBeNull();
    expect(
      await h.db
        .select({ serverId: serverLogSources.serverId })
        .from(serverLogSources)
        .where(eq(serverLogSources.serverId, id)),
    ).toHaveLength(0);
    const again = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(404);
    await assertAuditRow(h, {
      action: 'server.log_source.delete',
      resource: 'server',
      targetId: id,
    });
  });

  it('is deleted together with the server row (cascade) on soft-delete + hard cleanup', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createExternal(cookie);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/log-source`,
      headers: { cookie },
      payload: sourceBody,
    });
    await h.db.delete(servers).where(eq(servers.id, id));
    expect(
      await h.db
        .select({ serverId: serverLogSources.serverId })
        .from(serverLogSources)
        .where(eq(serverLogSources.serverId, id)),
    ).toHaveLength(0);
  });
});
