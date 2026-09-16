import { createHash } from 'node:crypto';
import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { adminsCfgSyncOutbox, configVersions, serverSettings, servers } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES, PANEL_CONFIGS_ROOT, PANEL_SAVED_ROOT } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import { ADMINS_CFG_SYNC_GROUP, ADMINS_CFG_SYNC_STREAM_PREFIX } from './admins-cfg-sync.js';
import { purgeSidecarDir, removeSidecar } from './sidecar-lifecycle.js';

// Prefix of the per-server Admins.cfg sync-status key the config-sync worker
// publishes (mirrors the local const in `routes/admins-cfg.ts`). Dropped on
// delete so a stale `unreachable` alert cannot outlive the server.
const ADMINS_CFG_STATUS_KEY_PREFIX = 'admins-cfg:status:';

export interface DeleteResult {
  backup_marker_id: string | null;
  files_backed_up: number;
  files_attempted: number;
  container_removed: boolean;
  configs_dir_removed: boolean;
  saved_dir_removed: boolean;
  /** True when both sidecar engines' per-server config dirs are gone. */
  sidecar_dirs_removed: boolean;
  ufw_rules_removed: number;
  /** True when the per-server Redis sync queue cleanup ran (requires `redis`). */
  sync_queue_removed: boolean;
  /** Count of unapplied outbox rows completed as `server_removed` on delete. */
  sync_outbox_cancelled: number;
  errors: Array<{ phase: string; error: string }>;
}

export interface DeleteContext {
  db: DatabaseClient;
  bridge: Pick<
    BridgeClient,
    'fileRead' | 'containerStop' | 'containerRm' | 'directoryDelete' | 'ufwRule'
  >;
  log: Pick<FastifyBaseLogger, 'warn' | 'info' | 'error' | 'debug'>;
  actorPlayerId: string | null;
  actorIp: string | null;
  actorLabel: string;
  /**
   * Optional Redis handle used to tear down the per-server Admins.cfg sync
   * queue (SYNC-5). When omitted the queue cleanup is skipped and
   * {@link DeleteResult.sync_queue_removed} stays `false` — kept optional so
   * callers that do not touch the sync queue (archival helpers, unit fakes)
   * compile unchanged.
   */
  redis?: Pick<Redis, 'xgroup' | 'unlink' | 'del'>;
}

const NOT_FOUND_RE = /not_found|no such container/i;

export async function softDeleteServer(
  ctx: DeleteContext,
  serverId: string,
): Promise<DeleteResult> {
  const result: DeleteResult = {
    backup_marker_id: null,
    files_backed_up: 0,
    files_attempted: ALLOWED_CONFIG_FILES.length,
    container_removed: false,
    configs_dir_removed: false,
    saved_dir_removed: false,
    sidecar_dirs_removed: false,
    ufw_rules_removed: 0,
    sync_queue_removed: false,
    sync_outbox_cancelled: 0,
    errors: [],
  };

  // An external server (runtime='external') has nothing on this host: no
  // config tree to back up, no container, no data dirs, no UFW rules. Only
  // the row, its outbox and its Redis sync queue are torn down.
  const target = await ctx.db.query.servers.findFirst({
    where: eq(servers.id, serverId),
    columns: { runtime: true },
  });
  const external = target?.runtime === 'external';
  if (external) result.files_attempted = 0;

  let backupMarkerId: string | null = null;
  if (!external) {
    const configsDir = `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig`;
    type Backed = { filename: string; content: string; sha256: Buffer };
    const backed: Backed[] = [];
    let allMissing = true;
    for (const file of ALLOWED_CONFIG_FILES) {
      try {
        const { content } = await ctx.bridge.fileRead({ path: `${configsDir}/${file}` });
        const sha256 = createHash('sha256').update(content, 'utf8').digest();
        backed.push({ filename: file, content, sha256 });
        allMissing = false;
      } catch (err) {
        const msg = (err as Error).message;
        if (!/no such file or directory/i.test(msg)) {
          // Bridge actually failed (permissions, transport, etc.) — not a
          // never-installed signal. Keep the existing safety net.
          allMissing = false;
        }
        ctx.log.warn(
          { err: msg, file, serverId },
          'server-delete: config read failed (will not be backed up)',
        );
      }
    }
    // never-installed fast path: install was interrupted before seedConfigs
    // ran (status='failed'), so /var/lib/squad-panel/configs/<uuid> does not
    // exist. There is nothing to back up — proceed with the rest of the
    // teardown so the orphan row can be soft-deleted.
    if (backed.length === 0 && !allMissing) {
      throw new Error(
        `cannot delete server ${serverId}: no config files could be backed up (read 0/${ALLOWED_CONFIG_FILES.length}); bridge errors look like a transport issue, not a missing configs dir`,
      );
    }
    if (backed.length === 0) {
      ctx.log.info(
        { serverId },
        'server-delete: configs dir missing — never-installed server, skipping backup',
      );
    }

    if (backed.length > 0) {
      await ctx.db.transaction(async (tx) => {
        const message = `deletion-backup-marker ${new Date().toISOString()}`;
        const inserts = await tx
          .insert(configVersions)
          .values(
            backed.map((b) => ({
              serverId,
              filename: b.filename,
              content: b.content,
              sha256: b.sha256,
              authorPlayerId: ctx.actorPlayerId,
              authorLabel: ctx.actorLabel,
              authorIp: ctx.actorIp,
              message,
            })),
          )
          .returning({ id: configVersions.id });
        if (inserts.length > 0) backupMarkerId = inserts[0]?.id ?? null;
      });
    }
    result.backup_marker_id = backupMarkerId;
    result.files_backed_up = backed.length;

    const containerN = `squad-${serverId}`;
    try {
      await ctx.bridge.containerStop({ name: containerN, timeout_sec: 30 });
    } catch (err) {
      const msg = (err as Error).message;
      if (!NOT_FOUND_RE.test(msg)) {
        result.errors.push({ phase: 'container_stop', error: msg });
      }
    }
    try {
      await ctx.bridge.containerRm({ name: containerN });
      result.container_removed = true;
    } catch (err) {
      const msg = (err as Error).message;
      if (NOT_FOUND_RE.test(msg)) {
        result.container_removed = true;
      } else {
        result.errors.push({ phase: 'container_rm', error: msg });
      }
    }

    // Tear down the sidecar. It is best-effort: a missing or never-launched
    // sidecar must not block the server deletion.
    await removeSidecar(ctx.bridge, serverId);
    // Its config dir holds the rendered config with the server's plaintext RCON
    // password, so it must not outlive the server.
    result.sidecar_dirs_removed = await purgeSidecarDir(ctx.bridge, serverId);

    try {
      const r = await ctx.bridge.directoryDelete({ path: `${PANEL_CONFIGS_ROOT}/${serverId}` });
      result.configs_dir_removed = r.removed;
    } catch (err) {
      result.errors.push({ phase: 'configs_dir_delete', error: (err as Error).message });
    }
    try {
      const r = await ctx.bridge.directoryDelete({ path: `${PANEL_SAVED_ROOT}/${serverId}` });
      result.saved_dir_removed = r.removed;
    } catch (err) {
      result.errors.push({ phase: 'saved_dir_delete', error: (err as Error).message });
    }

    const settings = await ctx.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, serverId),
    });
    if (settings) {
      const shortId = serverId.slice(0, 8);
      const rules: Array<{ port: number; proto: 'udp' | 'tcp'; comment: string }> = [
        { port: settings.gamePort, proto: 'udp', comment: `squad-game-${shortId}` },
        { port: settings.queryPort, proto: 'udp', comment: `squad-query-${shortId}` },
        { port: settings.beaconPort, proto: 'udp', comment: `squad-beacon-${shortId}` },
        { port: settings.rconPort, proto: 'tcp', comment: `squad-rcon-${shortId}` },
      ];
      for (const r of rules) {
        try {
          await ctx.bridge.ufwRule({
            action: 'remove',
            port: r.port,
            proto: r.proto,
            comment: r.comment,
          });
          result.ufw_rules_removed++;
        } catch (err) {
          result.errors.push({ phase: `ufw_${r.proto}_${r.port}`, error: (err as Error).message });
        }
      }
    }
  }

  const removedAt = new Date();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(servers)
      .set({
        deletedAt: removedAt,
        deletedByPlayerId: ctx.actorPlayerId,
        deletionBackupMarkerId: backupMarkerId,
        updatedAt: removedAt,
      })
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

    const completed = await tx
      .update(adminsCfgSyncOutbox)
      .set({
        appliedAt: removedAt,
        reloadOutcome: 'server_removed',
        lastError: null,
      })
      .where(and(eq(adminsCfgSyncOutbox.serverId, serverId), isNull(adminsCfgSyncOutbox.appliedAt)))
      .returning({ id: adminsCfgSyncOutbox.id });
    await tx
      .update(adminsCfgSyncOutbox)
      .set({ relayedAt: removedAt })
      .where(
        and(eq(adminsCfgSyncOutbox.serverId, serverId), isNull(adminsCfgSyncOutbox.relayedAt)),
      );
    result.sync_outbox_cancelled = completed.length;
  });

  // Phase 6 — per-server Admins.cfg sync-queue cleanup (SYNC-5). Runs AFTER
  // the soft-delete UPDATE so the outbox relay's `deleted_at IS NULL` guard is
  // already in effect. Each step is best-effort: a Redis fault is recorded on
  // `result.errors` under `sync_queue_cleanup` and never aborts the delete —
  // the server row is already marked deleted and must not be resurrected.
  if (ctx.redis) {
    result.sync_queue_removed = true;
    const streamKey = `${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`;

    // (a) Destroy the consumer group. The idempotent no-op cases are swallowed:
    // a missing stream key (`requires the key to exist` / `no such key`) or a
    // missing group (`NOGROUP`) — both mean "never installed / already cleaned".
    try {
      await ctx.redis.xgroup('DESTROY', streamKey, ADMINS_CFG_SYNC_GROUP);
    } catch (err) {
      const msg = (err as Error).message;
      if (!/NOGROUP|no such key|requires the key to exist/i.test(msg)) {
        result.errors.push({ phase: 'sync_queue_cleanup', error: msg });
      }
    }

    // (b) Drop the stream itself. UNLINK reclaims memory off-thread; fall back
    // to DEL for clients/builds without UNLINK.
    try {
      await ctx.redis.unlink(streamKey);
    } catch {
      try {
        await ctx.redis.del(streamKey);
      } catch (err) {
        result.errors.push({ phase: 'sync_queue_cleanup', error: (err as Error).message });
      }
    }

    // (c) Drop the per-server sync-status key so no stale `unreachable` alert
    // lingers for a server that no longer exists.
    try {
      await ctx.redis.del(`${ADMINS_CFG_STATUS_KEY_PREFIX}${serverId}`);
    } catch (err) {
      result.errors.push({ phase: 'sync_queue_cleanup', error: (err as Error).message });
    }
  }

  return result;
}
