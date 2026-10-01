// #10: config secrets must never leave the host file. The RCON password in
// Rcon.cfg and the license key in License.cfg are masked in every API
// response and in every `config_versions` row the panel writes (the table is
// append-only, so a plaintext row could never be removed again), while the
// file on disk keeps the real values.
import { createHash } from 'node:crypto';
import { configVersions, playerApiTokens, serverCredentials, servers } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES, PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq, like } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { mintApiToken } from '../../src/lib/api-tokens.js';
import { decryptString, deserialize, encrypt, serialize } from '../../src/lib/crypto.js';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { softDeleteServer } from '../../src/lib/server-delete.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type FakeBridge,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = testSteamId(914001);
const MASK = '********';
const RCON_SECRET = 'Rc0n-Secret-Pw-9f1c';
const OUT_OF_BAND_PASSWORD = 'Host-Side-Pw-5e2d';
const LICENSE_SECRET = 'LIC-KEY-SECRET-77aa';
const DEPOT_ROOT = '/depot-test-config-secrets';

let h: IntegrationHarness;
let cookie: string;
let serverCounter = 0;
let prevDepotEnv: string | undefined;

beforeAll(async () => {
  prevDepotEnv = process.env.PANEL_DEPOT_HOST_PATH;
  process.env.PANEL_DEPOT_HOST_PATH = DEPOT_ROOT;
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
  cookie = await loginAsOwner(h);
}, 60_000);

afterAll(async () => {
  if (prevDepotEnv === undefined) delete process.env.PANEL_DEPOT_HOST_PATH;
  else process.env.PANEL_DEPOT_HOST_PATH = prevDepotEnv;
  await h.cleanup();
}, 60_000);

function rconCfg(password: string, maxConnections = 5): string {
  return `IP=0.0.0.0\nPort=21114\nPassword=${password}\nMaxConnections=${maxConnections}\n`;
}

function licenseCfg(key: string): string {
  return `LicenseId=lic-id-1\nLicenseKey=${key}\n`;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function diskPath(id: string, name: string): string {
  return `${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/${name}`;
}

function setDisk(id: string, name: string, content: string): void {
  h.bridge.files.set(diskPath(id, name), Buffer.from(content, 'utf-8'));
}

function readDisk(id: string, name: string): string {
  return h.bridge.files.get(diskPath(id, name))?.toString('utf-8') ?? '';
}

async function createServer(): Promise<string> {
  serverCounter += 1;
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: {
      display_name: `Secrets Server ${serverCounter}`,
      slug: `secrets-server-${serverCounter}`,
      game_port: 7800 + serverCounter * 2,
      query_port: 27200 + serverCounter,
      beacon_port: 15100 + serverCounter,
      rcon_port: 21200 + serverCounter,
      max_players: 80,
      tickrate: 50,
      multihome: '0.0.0.0',
    },
  });
  if (resp.statusCode !== 201) throw new Error(`server create failed: ${resp.body}`);
  return resp.json<{ id: string }>().id;
}

/**
 * A server whose panel RCON credentials are `RCON_SECRET` on port 21114 — the
 * values `rconCfg()` renders — so writes that keep `Password=`/`Port=` pass
 * the credential guard (#280).
 */
async function createRconServer(): Promise<string> {
  const id = await createServer();
  await h.db
    .update(serverCredentials)
    .set({
      rconPort: 21114,
      rconPasswordEncrypted: serialize(encrypt(h.app.encryptionKey, RCON_SECRET)),
    })
    .where(eq(serverCredentials.serverId, id));
  return id;
}

async function getConfig(id: string, name: string, headers: Record<string, string> = { cookie }) {
  return h.app.inject({ method: 'GET', url: `/api/v1/servers/${id}/configs/${name}`, headers });
}

async function putConfig(id: string, name: string, content: string) {
  const resp = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/servers/${id}/configs/${name}`,
    headers: { cookie },
    payload: { content },
  });
  expect(resp.statusCode, resp.body).toBe(200);
  return resp.json<{ version_id?: string; sha256: string }>();
}

async function storedContents(id: string, name: string): Promise<string[]> {
  const rows = await h.db
    .select({ content: configVersions.content })
    .from(configVersions)
    .where(and(eq(configVersions.serverId, id), eq(configVersions.filename, name)));
  return rows.map((row) => row.content);
}

/** The panel's authoritative RCON password, decrypted from `server_credentials`. */
async function panelRconPassword(id: string): Promise<string> {
  const [creds] = await h.db
    .select()
    .from(serverCredentials)
    .where(eq(serverCredentials.serverId, id));
  return decryptString(
    h.app.encryptionKey,
    deserialize(Buffer.from(creds?.rconPasswordEncrypted as unknown as Buffer)),
  );
}

async function rconDriftState(id: string): Promise<string | undefined> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/servers/${id}/configs/drift`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  const items = res.json<{ items: Array<{ name: string; state: string }> }>().items;
  return items.find((item) => item.name === 'Rcon.cfg')?.state;
}

async function historyReads(id: string, name: string, fromId: string, toId: string) {
  const base = `/api/v1/servers/${id}/configs/${name}`;
  const urls = [
    `${base}/history`,
    `${base}/versions/${fromId}`,
    `${base}/versions/${toId}`,
    `${base}/diff?from=${fromId}&to=${toId}`,
    `${base}/blame`,
  ];
  const bodies: string[] = [];
  for (const url of urls) {
    const res = await h.app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    bodies.push(res.body);
  }
  return bodies;
}

describeIfDb('Rcon.cfg password masking (#10)', () => {
  it('GET masks the password and reports the sha of the on-disk bytes', async () => {
    const id = await createRconServer();
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));

    const res = await getConfig(id, 'Rcon.cfg');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ content: string; sha256: string }>();
    expect(body.content).toBe(rconCfg(MASK));
    expect(body.sha256).toBe(sha256Hex(rconCfg(RCON_SECRET)));
    expect(res.body).not.toContain(RCON_SECRET);
  });

  it('a server:view-scoped API token cannot read the RCON password', async () => {
    const id = await createRconServer();
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));
    const minted = mintApiToken();
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    const ownerId = h.seed.ownerPlayerId!;
    await h.db.insert(playerApiTokens).values({
      id: minted.id,
      playerId: ownerId,
      name: 'monitoring',
      tokenHash: minted.tokenHash,
      scopes: ['server:view'],
    });
    invalidatePermissionCache(ownerId);

    const res = await getConfig(id, 'Rcon.cfg', { authorization: `Bearer ${minted.plaintext}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(RCON_SECRET);
  });

  it('an editor round-trip keeps the real password on disk and never stores it', async () => {
    const id = await createRconServer();
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));
    const first = await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 6));
    const second = await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 7));

    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(RCON_SECRET, 7));
    expect(second.sha256).toBe(sha256Hex(rconCfg(RCON_SECRET, 7)));
    const stored = await storedContents(id, 'Rcon.cfg');
    expect(stored).toHaveLength(2);
    for (const content of stored) expect(content).not.toContain(RCON_SECRET);

    // biome-ignore lint/style/noNonNullAssertion: a non-deduped PUT returns version_id
    for (const body of await historyReads(id, 'Rcon.cfg', first.version_id!, second.version_id!)) {
      expect(body).not.toContain(RCON_SECRET);
    }

    // The tip digest still describes the disk bytes, so drift stays in sync.
    const drift = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/drift`,
      headers: { cookie },
    });
    expect(drift.statusCode).toBe(200);
    const items = drift.json<{ items: Array<{ name: string; state: string }> }>().items;
    expect(items.find((item) => item.name === 'Rcon.cfg')?.state).toBe('in_sync');
  });

  it('restoring a masked version writes the current real password to disk', async () => {
    const id = await createRconServer();
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));
    const first = await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 6));
    await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 7));

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/restore/${first.version_id}`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(RCON_SECRET, 6));
  });

  it('refuses a masked write when no real password can be resolved', async () => {
    const id = await createRconServer();
    await h.db.delete(serverCredentials).where(eq(serverCredentials.serverId, id));

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg`,
      headers: { cookie },
      payload: { content: rconCfg(MASK) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('rcon_password_unavailable');
    expect(readDisk(id, 'Rcon.cfg')).toBe('');
  });

  it('reset-default keeps the real password on disk but stores it masked', async () => {
    const id = await createRconServer();
    h.bridge.files.set(
      `${DEPOT_ROOT}/SquadGame/ServerConfig/Rcon.cfg`,
      Buffer.from('Port=0\nPassword=CHANGEME\n', 'utf-8'),
    );
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/reset-default`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);

    const [creds] = await h.db
      .select()
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, id));
    const realPassword = decryptString(
      h.app.encryptionKey,
      deserialize(Buffer.from(creds?.rconPasswordEncrypted as unknown as Buffer)),
    );
    expect(readDisk(id, 'Rcon.cfg')).toContain(`Password=${realPassword}`);
    const stored = await storedContents(id, 'Rcon.cfg');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain(`Password=${MASK}`);
    expect(stored[0]).not.toContain(realPassword);
  });

  it('masks a legacy plaintext history row on every read path', async () => {
    const id = await createRconServer();
    const legacyContent = rconCfg(RCON_SECRET);
    const [legacy] = await h.db
      .insert(configVersions)
      .values({
        serverId: id,
        filename: 'Rcon.cfg',
        content: legacyContent,
        sha256: createHash('sha256').update(legacyContent).digest(),
        authorLabel: 'system',
        message: 'initial install — legacy plaintext row',
      })
      .returning({ id: configVersions.id });
    setDisk(id, 'Rcon.cfg', legacyContent);
    const next = await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 9));

    // biome-ignore lint/style/noNonNullAssertion: insert().returning() yields the row
    for (const body of await historyReads(id, 'Rcon.cfg', legacy!.id, next.version_id!)) {
      expect(body).not.toContain(RCON_SECRET);
    }
  });

  it('drift revert restores the panel password over an out-of-band change', async () => {
    const id = await createRconServer();
    const panelPassword = await panelRconPassword(id);
    setDisk(id, 'Rcon.cfg', rconCfg(panelPassword));
    await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 6));
    setDisk(id, 'Rcon.cfg', rconCfg(OUT_OF_BAND_PASSWORD, 6));

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/drift/revert`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ unchanged: true, disk_repaired: true });
    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(panelPassword, 6));
    expect(await rconDriftState(id)).toBe('in_sync');
    expect(await storedContents(id, 'Rcon.cfg')).toHaveLength(1);
  });

  it('restoring a version after an out-of-band change writes the panel password', async () => {
    const id = await createRconServer();
    const panelPassword = await panelRconPassword(id);
    setDisk(id, 'Rcon.cfg', rconCfg(panelPassword));
    const first = await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 6));
    await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 7));
    setDisk(id, 'Rcon.cfg', rconCfg(OUT_OF_BAND_PASSWORD, 7));

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/restore/${first.version_id}`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(panelPassword, 6));
    expect(res.json<{ sha256: string }>().sha256).toBe(sha256Hex(rconCfg(panelPassword, 6)));
  });

  it('drift accept records an out-of-band change masked and leaves the disk alone', async () => {
    const id = await createRconServer();
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));
    await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 6));
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET, 8));

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/drift/accept`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(readDisk(id, 'Rcon.cfg')).toBe(rconCfg(RCON_SECRET, 8));
    const stored = await storedContents(id, 'Rcon.cfg');
    expect(stored).toHaveLength(2);
    expect(stored).toContain(rconCfg(MASK, 8));
    for (const content of stored) expect(content).not.toContain(RCON_SECRET);
    expect(await rconDriftState(id)).toBe('in_sync');
  });

  it('drift accept refuses an out-of-band password the panel would not follow (#280)', async () => {
    const id = await createRconServer();
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));
    await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 6));
    setDisk(id, 'Rcon.cfg', rconCfg(OUT_OF_BAND_PASSWORD, 8));

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/drift/accept`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('rcon_credentials_managed');
    expect(res.body).not.toContain(OUT_OF_BAND_PASSWORD);
    expect(await storedContents(id, 'Rcon.cfg')).toHaveLength(1);
  });

  it('drift diff masks the password on both sides', async () => {
    const id = await createRconServer();
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));
    await putConfig(id, 'Rcon.cfg', rconCfg(MASK, 6));
    setDisk(id, 'Rcon.cfg', rconCfg('Out-Of-Band-Pw-42', 8));

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/configs/Rcon.cfg/drift/diff`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('MaxConnections=8');
    expect(res.body).not.toContain(RCON_SECRET);
    expect(res.body).not.toContain('Out-Of-Band-Pw-42');
  });
});

describeIfDb('deletion backup and archive restore (#10)', () => {
  async function createAndDelete(): Promise<string> {
    const id = await createServer();
    for (const file of ALLOWED_CONFIG_FILES) setDisk(id, file, `# ${file}\nkey=${file}\n`);
    setDisk(id, 'Rcon.cfg', rconCfg(RCON_SECRET));
    setDisk(id, 'License.cfg', licenseCfg(LICENSE_SECRET));
    await softDeleteServer(
      {
        db: h.db,
        bridge: h.bridge as unknown as FakeBridge,
        log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
        actorPlayerId: h.seed.ownerPlayerId ?? null,
        actorIp: '127.0.0.1',
        actorLabel: 'config-secrets-test',
      },
      id,
    );
    return id;
  }

  async function archiveRead(archiveId: string, filename: string) {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/archive/${archiveId}/configs/${filename}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res;
  }

  it('stores License.cfg and Rcon.cfg masked in the deletion backup', async () => {
    const archiveId = await createAndDelete();
    const rows = await h.db
      .select({ filename: configVersions.filename, content: configVersions.content })
      .from(configVersions)
      .where(
        and(
          eq(configVersions.serverId, archiveId),
          like(configVersions.message, 'deletion-backup-marker%'),
        ),
      );
    expect(rows).toHaveLength(ALLOWED_CONFIG_FILES.length);
    expect(rows.find((row) => row.filename === 'License.cfg')?.content).toBe(licenseCfg(MASK));
    expect(rows.find((row) => row.filename === 'Rcon.cfg')?.content).toBe(rconCfg(MASK));

    expect((await archiveRead(archiveId, 'License.cfg')).body).not.toContain(LICENSE_SECRET);
    expect((await archiveRead(archiveId, 'Rcon.cfg')).body).not.toContain(RCON_SECRET);
  });

  it('masks legacy plaintext backup rows served from the archive', async () => {
    const archiveId = await createAndDelete();
    const legacy = licenseCfg(LICENSE_SECRET);
    await h.db.insert(configVersions).values({
      serverId: archiveId,
      filename: 'License.cfg',
      content: legacy,
      sha256: createHash('sha256').update(legacy).digest(),
      authorLabel: 'system',
      message: `deletion-backup-marker ${new Date(Date.now() + 1_000).toISOString()}`,
      createdAt: new Date(Date.now() + 1_000),
    });

    const res = await archiveRead(archiveId, 'License.cfg');
    expect(res.json<{ content: string }>().content).toBe(licenseCfg(MASK));
  });

  it('restore-configs does not carry License.cfg from the archive into the new server', async () => {
    const archiveId = await createAndDelete();
    const legacy = licenseCfg(LICENSE_SECRET);
    await h.db.insert(configVersions).values({
      serverId: archiveId,
      filename: 'License.cfg',
      content: legacy,
      sha256: createHash('sha256').update(legacy).digest(),
      authorLabel: 'system',
      message: `deletion-backup-marker ${new Date(Date.now() + 1_000).toISOString()}`,
      createdAt: new Date(Date.now() + 1_000),
    });

    const newId = uuidv7();
    await h.db.insert(servers).values({
      id: newId,
      displayName: 'Restored target',
      slug: `restored-target-${newId.slice(-8)}`,
      status: 'ready',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${newId}/restore-configs`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { from_archive_id: archiveId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ files_skipped: string[] }>().files_skipped).toContain('License.cfg');
    expect(readDisk(newId, 'License.cfg')).toBe('');
    expect(await storedContents(newId, 'License.cfg')).toEqual([]);
  });
});
