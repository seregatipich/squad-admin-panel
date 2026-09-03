import { configVersions, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES } from '@squad/shared-config';
import { and, eq, isNull, like } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { softDeleteServer } from '../src/lib/server-delete.js';
import { setIsolatedTestVipLifecycleStrict, testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type FakeBridge,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = testSteamId(910);

interface SeededServer {
  id: string;
  slug: string;
}

async function seedServer(h: IntegrationHarness, opts: { slug: string }): Promise<SeededServer> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Test ${opts.slug}`,
    slug: opts.slug,
    description: `desc-${opts.slug}`,
    status: 'running',
    tags: ['ru', 'pvp'],
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.alloc(64, 0x01),
  });
  return { id, slug: opts.slug };
}

async function seedAndSoftDelete(
  h: IntegrationHarness,
  slug: string,
  contentByFile?: Map<string, string>,
): Promise<SeededServer> {
  const seeded = await seedServer(h, { slug });
  for (const file of ALLOWED_CONFIG_FILES) {
    const body = contentByFile?.get(file) ?? `# ${file}\nkey=${file}\n`;
    h.bridge.files.set(
      `/var/lib/squad-panel/configs/${seeded.id}/ServerConfig/${file}`,
      Buffer.from(body, 'utf-8'),
    );
  }
  if (!h.seed.ownerPlayerId) {
    throw new Error('seed owner missing; pass seedOwner to buildIntegrationApp');
  }
  await softDeleteServer(
    {
      db: h.db,
      bridge: h.bridge as unknown as FakeBridge,
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      actorPlayerId: h.seed.ownerPlayerId,
      actorIp: '127.0.0.1',
      actorLabel: `player:${h.seed.ownerPlayerId}`,
    },
    seeded.id,
  );
  return seeded;
}

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /api/v1/servers/archive', () => {
  it('lists soft-deleted servers only, ordered by deleted_at desc', async () => {
    const a = await seedAndSoftDelete(h, 'archived-a');
    // Stagger deleted_at so ordering is deterministic.
    await h.db
      .update(servers)
      .set({ deletedAt: new Date(Date.now() - 60_000) })
      .where(eq(servers.id, a.id));
    const b = await seedAndSoftDelete(h, 'archived-b');
    await seedServer(h, { slug: 'still-active' });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/archive',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; slug: string; deleted_at: string | null }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.slug)).toEqual(['archived-b', 'archived-a']);
    expect(body.items[0]?.id).toBe(b.id);
  });
});

describe('GET /api/v1/servers/archive/:id', () => {
  it('returns 404 when the server is not soft-deleted', async () => {
    const live = await seedServer(h, { slug: 'live-only' });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/archive/${live.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('includes backup file list with sha256 hex', async () => {
    const archived = await seedAndSoftDelete(h, 'archived-detail');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/archive/${archived.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      server: { id: string; slug: string; deleted_at: string | null };
      backups: Array<{ filename: string; sha256_hex: string }>;
    };
    expect(body.server.id).toBe(archived.id);
    const filenames = body.backups.map((b) => b.filename);
    expect(filenames).toContain('Admins.cfg');
    expect(filenames).toContain('Server.cfg');
    expect(filenames).toContain('Rcon.cfg');
    for (const b of body.backups) {
      expect(b.sha256_hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('GET /api/v1/servers/archive/:id/configs/:filename', () => {
  it('returns content + sha256_hex of the latest backup row', async () => {
    const customs = new Map<string, string>([['Admins.cfg', 'Admin=12345:Member\n']]);
    const archived = await seedAndSoftDelete(h, 'archived-readcfg', customs);
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/archive/${archived.id}/configs/Admins.cfg`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      filename: string;
      content: string;
      sha256_hex: string;
    };
    expect(body.filename).toBe('Admins.cfg');
    expect(body.content).toBe('Admin=12345:Member\n');
    expect(body.sha256_hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns 404 for a filename without a backup in the archive', async () => {
    const archived = await seedAndSoftDelete(h, 'archived-readcfg-404');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/archive/${archived.id}/configs/NotBackedUp.cfg`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/servers/archive/:id/restore', () => {
  it('rejects with 409 when slug is already in use by an active server', async () => {
    const archived = await seedAndSoftDelete(h, 'archived-conflict');
    await seedServer(h, { slug: 'taken-slug' });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/archive/${archived.id}/restore`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { slug: 'taken-slug' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('slug_in_use');
  });

  it('creates a new pending server and returns next_steps', async () => {
    const archived = await seedAndSoftDelete(h, 'archived-restore');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/archive/${archived.id}/restore`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { slug: 'fresh-slug' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      archive_id: string;
      slug: string;
      display_name: string;
      status: string;
      next_steps: string[];
    };
    expect(body.archive_id).toBe(archived.id);
    expect(body.slug).toBe('fresh-slug');
    expect(body.status).toBe('pending');
    expect(body.next_steps.length).toBe(3);
    expect(body.display_name).toMatch(/restored/);

    const fresh = await h.db.query.servers.findFirst({
      where: and(eq(servers.slug, 'fresh-slug'), isNull(servers.deletedAt)),
    });
    expect(fresh?.id).toBe(body.id);
    expect(fresh?.status).toBe('pending');
  });
});

describe('POST /api/v1/servers/:newId/restore-configs', () => {
  it('does not restore archived Admin/Group authority after the durable cutover', async () => {
    const staleEos = 'archived-stale-eos';
    const archived = await seedAndSoftDelete(
      h,
      'archived-strict-overlay',
      new Map([
        [
          'Admins.cfg',
          `//SQUAD-PANEL BEGIN\nAdmin=${staleEos}:VIP\n//SQUAD-PANEL END\nGroup=Injected:reserve\nManual=preserved`,
        ],
      ]),
    );
    const newId = uuidv7();
    await h.db.insert(servers).values({
      id: newId,
      displayName: 'Strict restore target',
      slug: 'strict-overlay-target',
      status: 'ready',
    });
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${newId}/restore-configs`,
      headers: { cookie: await loginAsOwner(h), 'content-type': 'application/json' },
      payload: { from_archive_id: archived.id },
    });

    expect(response.statusCode).toBe(200);
    const admins = h.bridge.files
      .get(`/var/lib/squad-panel/configs/${newId}/ServerConfig/Admins.cfg`)
      ?.toString();
    expect(admins).toContain('Manual=preserved');
    expect(admins).not.toContain(staleEos);
    expect(admins).not.toContain('Group=Injected');
    expect(admins?.match(/\/\/SQUAD-PANEL BEGIN/g)).toHaveLength(1);
    expect(admins?.match(/\/\/SQUAD-PANEL END/g)).toHaveLength(1);
  });

  it('overlays backup configs (skipping Rcon.cfg) and writes new config_versions rows', async () => {
    const archived = await seedAndSoftDelete(h, 'archived-overlay');

    // Create a fresh active server destined to receive overlays.
    const newId = uuidv7();
    await h.db.insert(servers).values({
      id: newId,
      displayName: 'Restored',
      slug: 'overlay-target',
      status: 'ready',
    });
    await h.db.insert(serverSettings).values({
      serverId: newId,
      installPath: `/var/lib/squad-panel/configs/${newId}`,
      gamePort: 7790,
      queryPort: 27170,
      beaconPort: 15010,
      rconPort: 21120,
    });

    const fileAtomicWrite = vi.fn(async ({ path, content }: { path: string; content: string }) => {
      h.bridge.files.set(path, Buffer.from(content, 'utf-8'));
      return { status: 'ok' };
    });
    h.bridge.fileAtomicWrite = fileAtomicWrite;

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${newId}/restore-configs`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { from_archive_id: archived.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      archive_server_id: string;
      files_restored: number;
      files_skipped: string[];
      files_missing: string[];
      config_version_ids: string[];
      errors: Array<{ file: string; error: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.archive_server_id).toBe(archived.id);
    expect(body.files_skipped).toEqual(['Rcon.cfg']);
    expect(body.files_missing).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.files_restored).toBe(ALLOWED_CONFIG_FILES.length - 1);
    expect(body.config_version_ids.length).toBe(body.files_restored);

    expect(fileAtomicWrite).toHaveBeenCalledTimes(ALLOWED_CONFIG_FILES.length - 1);
    for (const call of fileAtomicWrite.mock.calls) {
      expect(call[0].path).not.toContain('Rcon.cfg');
      expect(call[0].path.startsWith(`/var/lib/squad-panel/configs/${newId}/ServerConfig/`)).toBe(
        true,
      );
    }

    const restoredRows = await h.db
      .select({ id: configVersions.id, filename: configVersions.filename })
      .from(configVersions)
      .where(
        and(
          eq(configVersions.serverId, newId),
          like(configVersions.message, 'restored from server%'),
        ),
      );
    expect(restoredRows.length).toBe(ALLOWED_CONFIG_FILES.length - 1);
    expect(restoredRows.find((r) => r.filename === 'Rcon.cfg')).toBeUndefined();
  });

  it('returns 404 when from_archive_id is not soft-deleted', async () => {
    const live = await seedServer(h, { slug: 'live-archive-source' });
    const newId = uuidv7();
    await h.db.insert(servers).values({
      id: newId,
      displayName: 'Restored',
      slug: 'overlay-target-2',
      status: 'ready',
    });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${newId}/restore-configs`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { from_archive_id: live.id },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('archive_not_found');
  });
});
