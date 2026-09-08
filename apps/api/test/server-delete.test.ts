import { relayAdminsCfgSyncOutbox } from '@squad/db';
import {
  adminsCfgSyncOutbox,
  configVersions,
  serverCredentials,
  serverSettings,
  servers,
} from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES } from '@squad/shared-config';
import { and, eq, isNull, like } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMINS_CFG_SYNC_GROUP,
  ADMINS_CFG_SYNC_STREAM_PREFIX,
} from '../src/lib/admins-cfg-sync.js';
import { softDeleteServer } from '../src/lib/server-delete.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type FakeBridge,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const ADMINS_CFG_STATUS_KEY_PREFIX = 'admins-cfg:status:';

async function seedConfigs(h: IntegrationHarness, serverId: string): Promise<void> {
  for (const file of ALLOWED_CONFIG_FILES) {
    h.bridge.files.set(
      `/var/lib/squad-panel/configs/${serverId}/ServerConfig/${file}`,
      Buffer.from(`# ${file}\nkey=value\n`, 'utf-8'),
    );
  }
}

const OWNER_STEAM_ID = testSteamId(900);

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
    status: 'running',
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

const silentLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('softDeleteServer (orchestrator)', () => {
  it('backs up all configs, removes container/dirs/ufw rules, and soft-deletes the row', async () => {
    const seeded = await seedServer(h, { slug: 'happy' });

    for (const file of ALLOWED_CONFIG_FILES) {
      h.bridge.files.set(
        `/var/lib/squad-panel/configs/${seeded.id}/ServerConfig/${file}`,
        Buffer.from(`# ${file}\nkey=value\n`, 'utf-8'),
      );
    }
    const directoryDelete = vi.fn(async () => ({ removed: true }));
    const ufwRule = vi.fn(async () => ({ output: '', status: 'ok' }));
    const containerStop = vi.fn(async () => ({ status: 'ok' }));
    const containerRm = vi.fn(async () => ({ status: 'ok' }));

    const bridge = {
      ...h.bridge,
      directoryDelete,
      ufwRule,
      containerStop,
      containerRm,
    };

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: bridge as unknown as FakeBridge & {
          directoryDelete: typeof directoryDelete;
        },
        log: silentLogger,
        // beforeEach always calls buildIntegrationApp with seedOwner, so
        // ownerPlayerId is defined for every test in this file.
        actorPlayerId: h.seed.ownerPlayerId as string,
        actorIp: '127.0.0.1',
        actorLabel: `player:${h.seed.ownerPlayerId}`,
      },
      seeded.id,
    );

    expect(result.files_backed_up).toBe(ALLOWED_CONFIG_FILES.length);
    expect(result.files_attempted).toBe(ALLOWED_CONFIG_FILES.length);
    expect(result.container_removed).toBe(true);
    expect(result.configs_dir_removed).toBe(true);
    expect(result.saved_dir_removed).toBe(true);
    expect(result.ufw_rules_removed).toBe(4);
    expect(result.errors).toEqual([]);
    expect(result.backup_marker_id).not.toBeNull();

    expect(directoryDelete).toHaveBeenCalledWith({
      path: `/var/lib/squad-panel/configs/${seeded.id}`,
    });
    expect(directoryDelete).toHaveBeenCalledWith({
      path: `/var/lib/squad-panel/saved/${seeded.id}`,
    });
    expect(containerRm).toHaveBeenCalledWith({ name: `squad-${seeded.id}` });
    // Both sidecar engines are torn down symmetrically, and their per-server
    // config dirs go with them — each holds a rendered config carrying the
    // server's plaintext RCON password.
    expect(containerRm).toHaveBeenCalledWith({ name: `rnsquadjs-${seeded.id}` });
    expect(containerRm).toHaveBeenCalledWith({ name: `squadjs2-${seeded.id}` });
    expect(directoryDelete).toHaveBeenCalledWith({
      path: `/run/squad-panel/rnsquadjs/${seeded.id}`,
    });
    expect(directoryDelete).toHaveBeenCalledWith({
      path: `/run/squad-panel/squadjs2/${seeded.id}`,
    });
    expect(result.sidecar_dirs_removed).toBe(true);
    expect(ufwRule).toHaveBeenCalledTimes(4);
    for (const call of ufwRule.mock.calls) {
      expect(call[0].action).toBe('remove');
    }

    const backupRows = await h.db
      .select()
      .from(configVersions)
      .where(
        and(
          eq(configVersions.serverId, seeded.id),
          like(configVersions.message, 'deletion-backup-marker%'),
        ),
      );
    expect(backupRows.length).toBe(ALLOWED_CONFIG_FILES.length);

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletionBackupMarkerId).toBe(result.backup_marker_id);
    expect(row?.deletedByPlayerId).toBe(h.seed.ownerPlayerId);
  });

  it('aborts deletion when bridge errors look like a transport issue (not missing dir)', async () => {
    const seeded = await seedServer(h, { slug: 'transport-broken' });
    const bridge = {
      ...h.bridge,
      fileRead: vi.fn(async () => {
        // Anything other than "no such file or directory" must be treated
        // as a real failure that blocks the delete — the existing safety
        // net for "bridge unreachable / permission denied / mid-flight crash".
        throw new Error('permission denied');
      }),
    };

    await expect(
      softDeleteServer(
        {
          db: h.db,
          bridge: bridge as unknown as FakeBridge,
          log: silentLogger,
          // beforeEach always calls buildIntegrationApp with seedOwner, so
          // ownerPlayerId is defined for every test in this file.
          actorPlayerId: h.seed.ownerPlayerId as string,
          actorIp: null,
          actorLabel: `player:${h.seed.ownerPlayerId}`,
        },
        seeded.id,
      ),
    ).rejects.toThrow(/no config files could be backed up.*transport issue/);

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).toBeNull();
  });

  it('soft-deletes a never-installed server (configs dir never existed)', async () => {
    const seeded = await seedServer(h, { slug: 'never-installed' });
    // Simulate the bridge's exact error shape when the host configs dir
    // does not exist — this is what an install that aborted before
    // seedConfigs leaves behind.
    const fileRead = vi.fn(async ({ path }: { path: string }) => {
      throw new Error(`stat: stat ${path}: no such file or directory`);
    });
    const directoryDelete = vi.fn(async () => ({ removed: false }));
    const ufwRule = vi.fn(async () => ({ output: '', status: 'ok' }));
    const containerStop = vi.fn(async () => {
      throw new Error('Error: No such container: squad-x');
    });
    const containerRm = vi.fn(async () => {
      throw new Error('Error: No such container: squad-x');
    });
    const bridge = { ...h.bridge, fileRead, directoryDelete, ufwRule, containerStop, containerRm };

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: bridge as unknown as FakeBridge,
        log: silentLogger,
        // beforeEach always calls buildIntegrationApp with seedOwner, so
        // ownerPlayerId is defined for every test in this file.
        actorPlayerId: h.seed.ownerPlayerId as string,
        actorIp: null,
        actorLabel: `player:${h.seed.ownerPlayerId}`,
      },
      seeded.id,
    );

    // Backup is skipped — no rows in config_versions for this server.
    expect(result.files_backed_up).toBe(0);
    expect(result.backup_marker_id).toBeNull();
    // ENOENT-shaped fileRead does NOT count as an error in `errors` —
    // it's the documented never-installed signal, not a failure.
    const fileReadErrors = result.errors.filter((e) => e.phase === 'config_backup');
    expect(fileReadErrors).toHaveLength(0);

    // Row is soft-deleted.
    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();

    // No config_versions inserted as backup markers.
    const versions = await h.db.query.configVersions.findMany({
      where: and(
        eq(configVersions.serverId, seeded.id),
        like(configVersions.message, 'deletion-backup-marker%'),
      ),
    });
    expect(versions).toHaveLength(0);
  });

  it('treats a mixed error set (some ENOENT, one transport) as bridge failure', async () => {
    const seeded = await seedServer(h, { slug: 'mixed-errors' });
    let callCount = 0;
    const fileRead = vi.fn(async ({ path }: { path: string }) => {
      callCount++;
      if (callCount === 5) {
        throw new Error('connect ECONNREFUSED /run/panel-host-bridge/bridge.sock');
      }
      throw new Error(`stat: stat ${path}: no such file or directory`);
    });
    const bridge = { ...h.bridge, fileRead };

    await expect(
      softDeleteServer(
        {
          db: h.db,
          bridge: bridge as unknown as FakeBridge,
          log: silentLogger,
          // beforeEach always calls buildIntegrationApp with seedOwner, so
          // ownerPlayerId is defined for every test in this file.
          actorPlayerId: h.seed.ownerPlayerId as string,
          actorIp: null,
          actorLabel: `player:${h.seed.ownerPlayerId}`,
        },
        seeded.id,
      ),
    ).rejects.toThrow(/transport issue/);

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).toBeNull();
  });

  it('records partial-failure errors but still soft-deletes the row', async () => {
    const seeded = await seedServer(h, { slug: 'partial-fail' });
    for (const file of ALLOWED_CONFIG_FILES) {
      h.bridge.files.set(
        `/var/lib/squad-panel/configs/${seeded.id}/ServerConfig/${file}`,
        Buffer.from('key=v\n', 'utf-8'),
      );
    }

    const bridge = {
      ...h.bridge,
      directoryDelete: vi.fn(async ({ path }: { path: string }) => {
        if (path.includes('/configs/')) throw new Error('EBUSY');
        return { removed: true };
      }),
      ufwRule: vi.fn(async () => ({ output: '', status: 'ok' })),
      containerStop: vi.fn(async () => ({ status: 'ok' })),
      containerRm: vi.fn(async () => ({ status: 'ok' })),
    };

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: bridge as unknown as FakeBridge,
        log: silentLogger,
        // beforeEach always calls buildIntegrationApp with seedOwner, so
        // ownerPlayerId is defined for every test in this file.
        actorPlayerId: h.seed.ownerPlayerId as string,
        actorIp: null,
        actorLabel: `player:${h.seed.ownerPlayerId}`,
      },
      seeded.id,
    );

    expect(result.configs_dir_removed).toBe(false);
    expect(result.saved_dir_removed).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.phase).toBe('configs_dir_delete');

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('treats container_stop "no such container" as success (idempotent)', async () => {
    const seeded = await seedServer(h, { slug: 'idem-container' });
    for (const file of ALLOWED_CONFIG_FILES) {
      h.bridge.files.set(
        `/var/lib/squad-panel/configs/${seeded.id}/ServerConfig/${file}`,
        Buffer.from('x=1\n', 'utf-8'),
      );
    }
    const bridge = {
      ...h.bridge,
      containerStop: vi.fn(async () => {
        throw new Error('No such container: squad-...');
      }),
      containerRm: vi.fn(async () => {
        throw new Error('No such container: squad-...');
      }),
      directoryDelete: vi.fn(async () => ({ removed: true })),
    };

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: bridge as unknown as FakeBridge,
        log: silentLogger,
        actorPlayerId: null,
        actorIp: null,
        actorLabel: 'system',
      },
      seeded.id,
    );

    expect(result.container_removed).toBe(true);
    expect(result.errors.find((e) => e.phase === 'container_stop')).toBeUndefined();
    expect(result.errors.find((e) => e.phase === 'container_rm')).toBeUndefined();
  });
});

describe('DELETE /api/v1/servers/:id route', () => {
  it('returns 404 on a server that is already soft-deleted (idempotency)', async () => {
    const seeded = await seedServer(h, { slug: 'deleted-already' });
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, seeded.id));
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${seeded.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('soft-deletes a live server via inject and emits liveBus event', async () => {
    const seeded = await seedServer(h, { slug: 'route-happy' });
    for (const file of ALLOWED_CONFIG_FILES) {
      h.bridge.files.set(
        `/var/lib/squad-panel/configs/${seeded.id}/ServerConfig/${file}`,
        Buffer.from('k=v\n', 'utf-8'),
      );
    }
    const events: unknown[] = [];
    const off = h.app.liveBus.subscribe((evt) => events.push(evt));

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${seeded.id}`,
      headers: { cookie },
    });

    off();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; files_backed_up: number };
    expect(body.ok).toBe(true);
    expect(body.files_backed_up).toBe(ALLOWED_CONFIG_FILES.length);

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();

    expect(events.some((e) => (e as { type: string }).type === 'server.deleted')).toBe(true);
  });
});

describe('softDeleteServer — Redis sync-queue cleanup (SYNC-5)', () => {
  it('destroys the per-server stream, consumer group, and status key (happy path)', async () => {
    const seeded = await seedServer(h, { slug: 'sync-happy' });
    await seedConfigs(h, seeded.id);

    const streamKey = `${ADMINS_CFG_SYNC_STREAM_PREFIX}${seeded.id}`;
    const statusKey = `${ADMINS_CFG_STATUS_KEY_PREFIX}${seeded.id}`;
    await h.redis.xadd(streamKey, '*', 'event', JSON.stringify({ reason: 'role.create' }));
    await h.redis.xgroup('CREATE', streamKey, ADMINS_CFG_SYNC_GROUP, '0');
    await h.redis.set(statusKey, JSON.stringify({ state: 'in_sync' }));
    expect(await h.redis.exists(streamKey)).toBe(1);
    expect(await h.redis.exists(statusKey)).toBe(1);

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: h.bridge as unknown as FakeBridge,
        log: silentLogger,
        // beforeEach always calls buildIntegrationApp with seedOwner, so
        // ownerPlayerId is defined for every test in this file.
        actorPlayerId: h.seed.ownerPlayerId as string,
        actorIp: '127.0.0.1',
        actorLabel: `player:${h.seed.ownerPlayerId}`,
        redis: h.redis,
      },
      seeded.id,
    );

    expect(result.sync_queue_removed).toBe(true);
    expect(result.errors.filter((e) => e.phase === 'sync_queue_cleanup')).toHaveLength(0);
    expect(await h.redis.exists(streamKey)).toBe(0);
    expect(await h.redis.exists(statusKey)).toBe(0);

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('atomically completes every unapplied outbox row as server_removed', async () => {
    const seeded = await seedServer(h, { slug: 'sync-outbox' });
    await seedConfigs(h, seeded.id);

    const previouslyRelayedAt = new Date('2026-08-01T12:00:00.000Z');

    await h.db.insert(adminsCfgSyncOutbox).values([
      { serverId: seeded.id, payload: { reason: 'a' } },
      { serverId: seeded.id, payload: { reason: 'b' } },
      { serverId: seeded.id, payload: { reason: 'c' } },
      {
        serverId: seeded.id,
        payload: { reason: 'already-relayed' },
        relayedAt: previouslyRelayedAt,
        streamId: '1-0',
      },
    ]);

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: h.bridge as unknown as FakeBridge,
        log: silentLogger,
        // beforeEach always calls buildIntegrationApp with seedOwner, so
        // ownerPlayerId is defined for every test in this file.
        actorPlayerId: h.seed.ownerPlayerId as string,
        actorIp: null,
        actorLabel: `player:${h.seed.ownerPlayerId}`,
        redis: h.redis,
      },
      seeded.id,
    );

    expect(result.sync_outbox_cancelled).toBe(4);
    const completed = await h.db
      .select({
        appliedAt: adminsCfgSyncOutbox.appliedAt,
        relayedAt: adminsCfgSyncOutbox.relayedAt,
        reloadOutcome: adminsCfgSyncOutbox.reloadOutcome,
        lastError: adminsCfgSyncOutbox.lastError,
        streamId: adminsCfgSyncOutbox.streamId,
      })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.serverId, seeded.id));
    expect(completed).toHaveLength(4);
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appliedAt: expect.any(Date),
          reloadOutcome: 'server_removed',
          lastError: null,
        }),
      ]),
    );
    expect(completed.every((row) => row.appliedAt !== null)).toBe(true);
    expect(completed).toContainEqual(
      expect.objectContaining({ relayedAt: previouslyRelayedAt, streamId: '1-0' }),
    );
  });

  it('a row enqueued after the delete is NOT relayed to a resurrected stream (relay guard)', async () => {
    const seeded = await seedServer(h, { slug: 'sync-resurrect' });
    await seedConfigs(h, seeded.id);

    const streamKey = `${ADMINS_CFG_SYNC_STREAM_PREFIX}${seeded.id}`;
    await h.redis.xadd(streamKey, '*', 'event', JSON.stringify({ reason: 'role.create' }));
    await h.redis.xgroup('CREATE', streamKey, ADMINS_CFG_SYNC_GROUP, '0');

    await softDeleteServer(
      {
        db: h.db,
        bridge: h.bridge as unknown as FakeBridge,
        log: silentLogger,
        // beforeEach always calls buildIntegrationApp with seedOwner, so
        // ownerPlayerId is defined for every test in this file.
        actorPlayerId: h.seed.ownerPlayerId as string,
        actorIp: null,
        actorLabel: `player:${h.seed.ownerPlayerId}`,
        redis: h.redis,
      },
      seeded.id,
    );
    expect(await h.redis.exists(streamKey)).toBe(0);

    // A mutation racing the delete inserts a fresh pending row after cleanup.
    await h.db
      .insert(adminsCfgSyncOutbox)
      .values({ serverId: seeded.id, payload: { reason: 'race' } });

    const { relayed } = await relayAdminsCfgSyncOutbox(h.db, h.redis, {
      streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
    });
    expect(relayed).toBe(0);
    // The relay must NOT have recreated the deleted server's stream…
    expect(await h.redis.exists(streamKey)).toBe(0);
    // …yet it drained the orphan row so it never lingers pending forever.
    const stillPending = await h.db
      .select({ id: adminsCfgSyncOutbox.id })
      .from(adminsCfgSyncOutbox)
      .where(
        and(eq(adminsCfgSyncOutbox.serverId, seeded.id), isNull(adminsCfgSyncOutbox.relayedAt)),
      );
    expect(stillPending).toHaveLength(0);
  });

  it('is idempotent when the stream and group never existed', async () => {
    const seeded = await seedServer(h, { slug: 'sync-missing' });
    await seedConfigs(h, seeded.id);

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: h.bridge as unknown as FakeBridge,
        log: silentLogger,
        actorPlayerId: null,
        actorIp: null,
        actorLabel: 'system',
        redis: h.redis,
      },
      seeded.id,
    );

    expect(result.sync_queue_removed).toBe(true);
    expect(result.errors.filter((e) => e.phase === 'sync_queue_cleanup')).toHaveLength(0);
    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('completes with sync_queue_removed=false when no redis is supplied (compat)', async () => {
    const seeded = await seedServer(h, { slug: 'sync-nocompat' });
    await seedConfigs(h, seeded.id);

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: h.bridge as unknown as FakeBridge,
        log: silentLogger,
        actorPlayerId: null,
        actorIp: null,
        actorLabel: 'system',
      },
      seeded.id,
    );

    expect(result.sync_queue_removed).toBe(false);
    expect(result.sync_outbox_cancelled).toBe(0);
    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('records a sync_queue_cleanup error but still soft-deletes when redis fails', async () => {
    const seeded = await seedServer(h, { slug: 'sync-failure' });
    await seedConfigs(h, seeded.id);

    const redisStub = {
      xgroup: vi.fn(async () => 1),
      unlink: vi.fn(async () => {
        throw new Error('UNLINK boom');
      }),
      del: vi.fn(async () => {
        throw new Error('DEL boom');
      }),
    };

    const result = await softDeleteServer(
      {
        db: h.db,
        bridge: h.bridge as unknown as FakeBridge,
        log: silentLogger,
        actorPlayerId: null,
        actorIp: null,
        actorLabel: 'system',
        redis: redisStub as unknown as IntegrationHarness['redis'],
      },
      seeded.id,
    );

    expect(result.errors.some((e) => e.phase === 'sync_queue_cleanup')).toBe(true);
    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.deletedAt).not.toBeNull();
  });
});
