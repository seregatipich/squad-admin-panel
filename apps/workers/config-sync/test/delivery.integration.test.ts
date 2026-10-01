import {
  createDatabaseClient,
  markAdminsCfgSyncApplied,
  relayAdminsCfgSyncOutbox,
} from '@squad/db';
import {
  adminsCfgSyncOutbox,
  clanMembers,
  clans,
  players,
  roleSquadPermissions,
  roles,
  servers,
} from '@squad/db/schema';
import { BEGIN_MARKER, END_MARKER } from '@squad/shared-config/admins-config';
import { rconCommandResultKey } from '@squad/shared-types';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import { createIsolatedPackageTestDatabase } from '../../../../packages/db/test/helpers/isolated-database.js';
import {
  ADMINS_CFG_SYNC_GROUP,
  type AdminsCfgSyncEvent,
  handleAdminsCfgSyncEntry,
} from '../src/delivery.js';
import { confirmAdminsCfgReload } from '../src/rcon-reload.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const STREAM_PREFIX = 'events:admins-cfg-sync:';

let isolated: Awaited<ReturnType<typeof createIsolatedPackageTestDatabase>>;
let db: ReturnType<typeof createDatabaseClient>;
let redis: Redis;
let serverId: string;
let ownedRedisKeys = new Set<string>();

function ownRedisKey(key: string): string {
  ownedRedisKeys.add(key);
  return key;
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function bridge() {
  return {
    fileRead: vi.fn().mockResolvedValue({ content: '' }),
    fileAtomicWrite: vi.fn().mockResolvedValue({ written: true }),
  } as never;
}

async function relayedEntry(correlationId?: string) {
  const payload: AdminsCfgSyncEvent = {
    reason: 'vip.lifecycle.assigned',
    actor_player_id: null,
    request_id: `delivery-${uuidv7()}`,
  };
  const [row] = await db
    .insert(adminsCfgSyncOutbox)
    .values({ serverId, payload, correlationId })
    .returning({ id: adminsCfgSyncOutbox.id });
  if (!row) throw new Error('outbox fixture was not inserted');
  await relayAdminsCfgSyncOutbox(db, redis, { streamPrefix: STREAM_PREFIX });
  const streamName = `${STREAM_PREFIX}${serverId}`;
  ownRedisKey(streamName);
  try {
    await redis.xgroup('CREATE', streamName, ADMINS_CFG_SYNC_GROUP, '0', 'MKSTREAM');
  } catch (error) {
    if (!(error as Error).message.includes('BUSYGROUP')) throw error;
  }
  const read = (await redis.xreadgroup(
    'GROUP',
    ADMINS_CFG_SYNC_GROUP,
    `integration-${uuidv7()}`,
    'COUNT',
    1,
    'STREAMS',
    streamName,
    '>',
  )) as Array<[string, Array<[string, string[]]>]>;
  const [streamId, fields] = read[0]?.[1][0] ?? [];
  if (!streamId || !fields) throw new Error('relayed stream entry was not read');
  const eventIndex = fields.indexOf('event');
  return {
    outboxId: row.id,
    entry: {
      serverId,
      streamName,
      streamId,
      event: JSON.parse(fields[eventIndex + 1] ?? '{}') as AdminsCfgSyncEvent,
    },
  };
}

async function respondToNextReload(outboxId: string, overrides: Record<string, unknown> = {}) {
  const stream = `rcon:commands:${serverId}`;
  let requestId: string | null = null;
  for (let attempt = 0; attempt < 1_000 && !requestId; attempt++) {
    const entries = await redis.xrange(stream, '-', '+');
    for (const [, fields] of entries) {
      const requestIndex = fields.indexOf('request');
      if (requestIndex < 0) continue;
      const request = JSON.parse(fields[requestIndex + 1] ?? '{}') as { request_id?: string };
      if (request.request_id?.startsWith(`admins-cfg-sync:${outboxId}:`)) {
        requestId = request.request_id;
        break;
      }
    }
    if (!requestId) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!requestId) throw new Error('reload request was not enqueued');
  await redis.set(
    ownRedisKey(rconCommandResultKey(requestId)),
    JSON.stringify({
      ok: true,
      server_id: serverId,
      request_id: requestId,
      command: 'AdminReloadServerConfig',
      response: 'ok',
      completed_at: new Date().toISOString(),
      duration_ms: 1,
      ...overrides,
    }),
  );
  return requestId;
}

describeIfDbAndRedis('config-sync durable delivery with PostgreSQL and Redis', () => {
  beforeAll(async () => {
    if (!DATABASE_URL || !REDIS_URL) throw new Error('integration infrastructure is required');
    isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'config_sync_delivery');
    db = createDatabaseClient(isolated.url);
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  }, 120_000);

  afterAll(async () => {
    await redis?.quit().catch(() => undefined);
    await isolated?.drop();
  });

  beforeEach(async () => {
    await db.delete(adminsCfgSyncOutbox);
    serverId = uuidv7();
    ownedRedisKeys = new Set([
      `${STREAM_PREFIX}${serverId}`,
      `rcon:commands:${serverId}`,
      `admins-cfg:status:${serverId}`,
    ]);
    await db.insert(servers).values({
      id: serverId,
      displayName: `delivery-${serverId}`,
      slug: `delivery-${serverId}`,
      status: 'running',
    });
  });

  afterEach(async () => {
    if (ownedRedisKeys.size > 0) await redis.del(...ownedRedisKeys);
  });

  it('persists confirmation before atomically ACKing and deleting the exact entry', async () => {
    const { outboxId, entry } = await relayedEntry('evt-confirmed');
    const fakeBridge = bridge();
    const responder = respondToNextReload(outboxId);

    await expect(
      handleAdminsCfgSyncEntry({ db, redis, bridge: fakeBridge, log: logger() }, entry),
    ).resolves.toBe('completed');
    await responder;

    const [stored] = await db
      .select({
        appliedAt: adminsCfgSyncOutbox.appliedAt,
        reloadOutcome: adminsCfgSyncOutbox.reloadOutcome,
      })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.id, outboxId));
    expect(stored).toMatchObject({ appliedAt: expect.any(Date), reloadOutcome: 'confirmed' });
    expect(fakeBridge.fileAtomicWrite).toHaveBeenCalledOnce();
    expect(await redis.xlen(entry.streamName)).toBe(0);
    expect(await redis.xpending(entry.streamName, ADMINS_CFG_SYNC_GROUP)).toEqual([
      0,
      null,
      null,
      null,
    ]);
  });

  it('round-trips the deterministic reload request and exact result through Redis', async () => {
    const outboxId = uuidv7();
    const confirmation = confirmAdminsCfgReload(redis, serverId, outboxId, logger(), {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    });

    let request: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100 && !request; attempt++) {
      const entries = await redis.xrange(`rcon:commands:${serverId}`, '-', '+');
      const fields = entries[0]?.[1];
      const index = fields?.indexOf('request') ?? -1;
      if (fields && index >= 0) request = JSON.parse(fields[index + 1] ?? '{}');
      if (!request) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(request).toMatchObject({
      command: 'AdminReloadServerConfig',
      args: [],
    });
    const requestId = request?.request_id as string;
    expect(requestId).toMatch(new RegExp(`^admins-cfg-sync:${outboxId}:`));

    await redis.set(
      ownRedisKey(rconCommandResultKey(requestId)),
      JSON.stringify({
        ok: true,
        server_id: serverId,
        request_id: requestId,
        command: 'AdminReloadServerConfig',
        response: 'ok',
        completed_at: new Date().toISOString(),
        duration_ms: 1,
      }),
    );
    await expect(confirmation).resolves.toBe('confirmed');
  });

  it('replays an applied row as cleanup only after a crash before ACK', async () => {
    const { outboxId, entry } = await relayedEntry('evt-replay');
    await markAdminsCfgSyncApplied(db, outboxId, 'confirmed');
    const fakeBridge = bridge();

    await handleAdminsCfgSyncEntry({ db, redis, bridge: fakeBridge, log: logger() }, entry);

    expect(fakeBridge.fileRead).not.toHaveBeenCalled();
    expect(fakeBridge.fileAtomicWrite).not.toHaveBeenCalled();
    expect(await redis.xlen(entry.streamName)).toBe(0);
  });

  it('keeps an invalid RCON result durable but unacked for reclaim', async () => {
    const { outboxId, entry } = await relayedEntry('evt-invalid');
    const responder = respondToNextReload(outboxId, { server_id: uuidv7() });

    await expect(
      handleAdminsCfgSyncEntry({ db, redis, bridge: bridge(), log: logger() }, entry),
    ).resolves.toBe('retry');
    await responder;

    const [stored] = await db
      .select()
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.id, outboxId));
    expect(stored).toMatchObject({
      appliedAt: null,
      lastError: 'invalid_result',
      reloadOutcome: 'invalid_result',
    });
    expect(await redis.xlen(entry.streamName)).toBe(1);
    expect((await redis.xpending(entry.streamName, ADMINS_CFG_SYNC_GROUP))[0]).toBe(1);
  });

  it('marks stable stopped delivery file_ready_for_restart without RCON', async () => {
    await db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, serverId));
    const { outboxId, entry } = await relayedEntry('evt-stopped');

    await handleAdminsCfgSyncEntry({ db, redis, bridge: bridge(), log: logger() }, entry);

    const [stored] = await db
      .select({ reloadOutcome: adminsCfgSyncOutbox.reloadOutcome })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.id, outboxId));
    expect(stored?.reloadOutcome).toBe('file_ready_for_restart');
    expect(await redis.xlen(entry.streamName)).toBe(0);
    expect(await redis.xlen(`rcon:commands:${serverId}`)).toBe(0);
  });

  it('marks a server removed after relay as terminal success without RCON', async () => {
    const { outboxId, entry } = await relayedEntry('evt-removed');
    await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverId));

    await handleAdminsCfgSyncEntry({ db, redis, bridge: bridge(), log: logger() }, entry);

    const [stored] = await db
      .select({
        appliedAt: adminsCfgSyncOutbox.appliedAt,
        reloadOutcome: adminsCfgSyncOutbox.reloadOutcome,
      })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.id, outboxId));
    expect(stored).toMatchObject({
      appliedAt: expect.any(Date),
      reloadOutcome: 'server_removed',
    });
    expect(await redis.xlen(entry.streamName)).toBe(0);
    expect(await redis.xlen(`rcon:commands:${serverId}`)).toBe(0);
  });

  it('serializes concurrent deliveries through the final atomic write per server', async () => {
    await db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, serverId));
    const roleId = uuidv7();
    const playerId = uuidv7();
    const eosId = `race-${uuidv7().replaceAll('-', '')}`;
    await db.insert(roles).values({ id: roleId, name: `race-${roleId}` });
    await db.insert(players).values({
      id: playerId,
      canonicalName: 'Config sync race',
      canonicalNameNormalized: 'config sync race',
      eosId,
      roleId,
    });

    let fileContent = '';
    let writeCount = 0;
    let releaseFirstWrite!: () => void;
    let reportFirstWrite!: () => void;
    let reportSecondWrite!: () => void;
    const firstWriteEntered = new Promise<void>((resolve) => {
      reportFirstWrite = resolve;
    });
    const secondWriteEntered = new Promise<void>((resolve) => {
      reportSecondWrite = resolve;
    });
    const firstWriteRelease = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const racedBridge = {
      fileRead: vi.fn().mockImplementation(async () => ({ content: fileContent })),
      fileAtomicWrite: vi.fn().mockImplementation(async ({ content }: { content: string }) => {
        writeCount += 1;
        if (writeCount === 1) {
          reportFirstWrite();
          await firstWriteRelease;
        } else if (writeCount === 2) {
          reportSecondWrite();
        }
        fileContent = content;
        return { written: true };
      }),
    } as never;

    const first = await relayedEntry();
    const firstDelivery = handleAdminsCfgSyncEntry(
      { db, redis, bridge: racedBridge, log: logger() },
      first.entry,
    );
    await firstWriteEntered;

    await db.update(players).set({ roleId: null }).where(eq(players.id, playerId));
    const second = await relayedEntry();
    const secondDelivery = handleAdminsCfgSyncEntry(
      { db, redis, bridge: racedBridge, log: logger() },
      second.entry,
    );

    const secondWroteBeforeRelease = await Promise.race([
      secondWriteEntered.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseFirstWrite();
    await Promise.all([firstDelivery, secondDelivery]);

    expect(secondWroteBeforeRelease).toBe(false);
    expect(fileContent).not.toContain(eosId);
  });
  it('writes hostile role names, comments and clan names without changing the file structure (issue #11)', async () => {
    await db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, serverId));
    const suffix = uuidv7().replaceAll('-', '');
    const hex = (seed: string) => `${seed}${suffix}`.slice(0, 32);
    const injectedEos = hex('0002ffff');
    const hostileRoleId = uuidv7();
    const safeRoleId = uuidv7();
    const clanId = uuidv7();
    const hostileRoleMember = uuidv7();
    const commentedMember = uuidv7();
    const clanMember = uuidv7();
    const hostileRoleName = `X:ban\r\nAdmin=${injectedEos}:X`;
    const safeRoleName = `Safe ${suffix.slice(0, 8)}`;
    await db.insert(roles).values([
      { id: hostileRoleId, name: hostileRoleName },
      { id: safeRoleId, name: safeRoleName },
    ]);
    await db.insert(roleSquadPermissions).values([
      { roleId: hostileRoleId, squadPermissionKey: 'kick' },
      { roleId: safeRoleId, squadPermissionKey: 'kick' },
    ]);
    await db.insert(players).values([
      {
        id: hostileRoleMember,
        canonicalName: 'Hostile role member',
        canonicalNameNormalized: 'hostile role member',
        eosId: hex('0002aaaa'),
        roleId: hostileRoleId,
      },
      {
        id: commentedMember,
        canonicalName: 'Commented member',
        canonicalNameNormalized: 'commented member',
        eosId: hex('0002bbbb'),
        roleId: safeRoleId,
        roleComment: `x\r\nAdmin=${injectedEos}:Owner\r\n${END_MARKER}`,
      },
      {
        id: clanMember,
        canonicalName: 'Clan member',
        canonicalNameNormalized: 'clan member',
        eosId: hex('0002cccc'),
      },
    ]);
    await db.insert(clans).values({
      id: clanId,
      name: `C\u2028${END_MARKER}`,
    });
    await db
      .insert(clanMembers)
      .values({ clanId, playerId: clanMember, memberRole: 'leader', hasPriority: true });

    let fileContent = 'ServerAdmin=keep\r\n';
    const fileBridge = {
      fileRead: vi.fn().mockImplementation(async () => ({ content: fileContent })),
      fileAtomicWrite: vi.fn().mockImplementation(async ({ content }: { content: string }) => {
        fileContent = content;
        return { written: true };
      }),
    } as never;

    try {
      const first = await relayedEntry();
      await handleAdminsCfgSyncEntry({ db, redis, bridge: fileBridge, log: logger() }, first.entry);

      const lines = fileContent.split('\r\n');
      expect(lines.filter((line) => line.includes(BEGIN_MARKER))).toHaveLength(1);
      expect(lines.filter((line) => line.includes(END_MARKER))).toHaveLength(1);
      expect(lines.some((line) => line.startsWith(`Admin=${injectedEos}`))).toBe(false);
      expect(fileContent).not.toContain(hex('0002aaaa'));
      expect(fileContent.replaceAll('\r\n', '')).not.toMatch(/[\r\n\u2028\u2029]/u);
      expect(lines).toContain(`Group=${safeRoleName}:kick`);
      expect(lines.filter((line) => line.startsWith('Admin='))).toEqual([
        expect.stringMatching(new RegExp(`^Admin=${hex('0002bbbb')}:${safeRoleName} // x `)),
        expect.stringMatching(
          new RegExp(`^Admin=${hex('0002cccc')}:ClanPriority // clan:C /SQUAD-PANEL END$`),
        ),
      ]);

      await db
        .update(players)
        .set({ roleId: null, roleComment: null })
        .where(inArray(players.id, [hostileRoleMember, commentedMember]));
      await db
        .update(clanMembers)
        .set({ hasPriority: false })
        .where(eq(clanMembers.clanId, clanId));
      const second = await relayedEntry();
      await handleAdminsCfgSyncEntry(
        { db, redis, bridge: fileBridge, log: logger() },
        second.entry,
      );

      expect(fileContent.split('\r\n').filter((line) => line.startsWith('Admin='))).toEqual([]);
      expect(fileContent).not.toContain(injectedEos);
      expect(fileContent.endsWith(`${END_MARKER}\r\n\r\nServerAdmin=keep\r\n`)).toBe(true);
    } finally {
      await db.delete(clans).where(eq(clans.id, clanId));
      await db
        .delete(players)
        .where(inArray(players.id, [hostileRoleMember, commentedMember, clanMember]));
      await db.delete(roles).where(inArray(roles.id, [hostileRoleId, safeRoleId]));
    }
  });
});
