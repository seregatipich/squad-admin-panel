import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { appendWorkerAudit } from './audit.js';
import { snapshotRolesAndAdmins } from './db-snapshot.js';
import { type AdminsCfgReloadOutcome, requestAdminsCfgReload } from './rcon-reload.js';
import {
  buildManagedSegment,
  findManagedSegment,
  hashSegment,
  spliceManagedSegment,
} from './segment.js';

export const ADMINS_CFG_STATUS_KEY_PREFIX = 'admins-cfg:status:';
export const ADMINS_CFG_STATUS_TTL_SECONDS = 86_400;

export interface SyncStatus {
  state: 'unknown' | 'in_sync' | 'drift' | 'unreachable' | 'syncing';
  last_synced_at: string | null;
  last_segment_hash: string | null;
  last_db_hash: string | null;
  groups_count?: number;
  admins_count?: number;
  error?: string | null;
  attempts?: number;
  /** ISO timestamp when this server first transitioned to `unreachable`
   *  in the current outage window. Cleared on the next successful sync.
   *  Spec §2.7.7 — UI shows a "X hours unreachable" alert when this is
   *  more than 1 hour ago. */
  unreachable_since?: string | null;
}

export interface SyncResult {
  serverId: string;
  state: 'wrote' | 'in_sync' | 'unreachable' | 'drift';
  expectedHash: string;
  actualHash: string | null;
  groupsCount: number;
  adminsCount: number;
  error?: string;
  /** Outcome of the post-write RCON `AdminReloadServerConfig` request. Present
   *  only on the successful-write branch (`state: 'wrote'`); absent on the
   *  no-write (`in_sync`/`drift`) and failure (`unreachable`) branches. */
  reload?: AdminsCfgReloadOutcome;
}

export function adminsCfgPath(serverId: string): string {
  return `/var/lib/squad-panel/configs/${serverId}/ServerConfig/Admins.cfg`;
}

async function readPreviousStatus(redis: Redis, serverId: string): Promise<SyncStatus | null> {
  const raw = await redis.get(`${ADMINS_CFG_STATUS_KEY_PREFIX}${serverId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncStatus;
  } catch {
    return null;
  }
}

async function publishStatus(redis: Redis, serverId: string, status: SyncStatus): Promise<void> {
  // §2.7.7 — preserve `unreachable_since` across consecutive failed
  // attempts so the UI can compute outage duration. Reset on any
  // non-unreachable transition.
  const next: SyncStatus = { ...status };
  if (status.state === 'unreachable') {
    if (!next.unreachable_since) {
      const prev = await readPreviousStatus(redis, serverId);
      next.unreachable_since =
        prev?.state === 'unreachable' && prev.unreachable_since
          ? prev.unreachable_since
          : new Date().toISOString();
    }
  } else {
    next.unreachable_since = null;
  }
  await redis.set(
    `${ADMINS_CFG_STATUS_KEY_PREFIX}${serverId}`,
    JSON.stringify(next),
    'EX',
    ADMINS_CFG_STATUS_TTL_SECONDS,
  );
}

export interface SyncContext {
  db: DatabaseClient;
  redis: Redis;
  bridge: BridgeClient;
  log: Logger;
}

export interface SyncOptions {
  reason: string;
  actorPlayerId: string | null;
  forceWrite?: boolean;
}

/**
 * Reconcile a single server's Admins.cfg against the DB-derived managed
 * segment. Idempotent. Reads via bridge.fileRead, splices the segment,
 * writes atomically via bridge.fileAtomicWrite only if the hash differs
 * (or forceWrite=true). Publishes status to Redis. On success, appends
 * audit_log row `admins_cfg.synced` (or `admins_cfg.force_synced`).
 */
export async function syncServerAdminsCfg(
  ctx: SyncContext,
  serverId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const { db, redis, bridge, log } = ctx;
  const path = adminsCfgPath(serverId);
  await publishStatus(redis, serverId, {
    state: 'syncing',
    last_synced_at: null,
    last_segment_hash: null,
    last_db_hash: null,
  });

  const snapshot = await snapshotRolesAndAdmins(db);
  const generated = buildManagedSegment(snapshot);

  let original: string;
  try {
    const result = await bridge.fileRead({ path });
    original = result.content ?? '';
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e.code === 'not_found' ||
      e.code === 'no_such_file' ||
      e.message?.toLowerCase().includes('no such file') ||
      e.message?.toLowerCase().includes('not_found')
    ) {
      original = '';
    } else {
      const msg = e.message ?? String(err);
      log.warn({ serverId, err: msg }, 'admins.cfg read failed');
      await publishStatus(redis, serverId, {
        state: 'unreachable',
        last_synced_at: null,
        last_segment_hash: null,
        last_db_hash: generated.hash,
        error: msg,
      });
      // Spec §2.7.7 — "audit пишет failed sync attempts".
      await safeAppendAudit(db, log, serverId, {
        actorPlayerId: opts.actorPlayerId,
        actionType: 'admins_cfg.sync_failed',
        targetType: 'server',
        targetId: serverId,
        before: null,
        after: null,
        context: {
          reason: opts.reason,
          phase: 'file_read',
          error: msg,
          groups_count: generated.groupsCount,
          admins_count: generated.adminsCount,
        },
      });
      return {
        serverId,
        state: 'unreachable',
        expectedHash: generated.hash,
        actualHash: null,
        groupsCount: generated.groupsCount,
        adminsCount: generated.adminsCount,
        error: msg,
      };
    }
  }

  const located = findManagedSegment(original);
  const currentHash = located ? hashSegment(located.segment) : null;
  const newContent = spliceManagedSegment(original, generated.body);

  const hashesMatch = currentHash === generated.hash;
  const isPassiveCheck = opts.reason === 'drift_check';
  // Passive sweeps detect drift but do NOT auto-correct — the spec
  // (§2.7.6) wants the operator to be alerted with a Force-sync button
  // rather than have the worker silently overwrite manual edits. Active
  // mutations (role.update, player.role.assign, …) and explicit
  // force_sync requests still write.
  const needsWrite = opts.forceWrite || (!isPassiveCheck && !hashesMatch);

  if (!needsWrite) {
    if (!hashesMatch && located !== null) {
      // Drift — file's managed segment diverges from the DB. Surface it
      // in the UI banner; do not write.
      await publishStatus(redis, serverId, {
        state: 'drift',
        last_synced_at: null,
        last_segment_hash: currentHash,
        last_db_hash: generated.hash,
        groups_count: generated.groupsCount,
        admins_count: generated.adminsCount,
      });
      log.warn(
        { serverId, expected: generated.hash, actual: currentHash },
        'admins.cfg drift detected — awaiting force-sync',
      );
      return {
        serverId,
        state: 'drift',
        expectedHash: generated.hash,
        actualHash: currentHash,
        groupsCount: generated.groupsCount,
        adminsCount: generated.adminsCount,
      };
    }
    await publishStatus(redis, serverId, {
      state: 'in_sync',
      last_synced_at: new Date().toISOString(),
      last_segment_hash: generated.hash,
      last_db_hash: generated.hash,
      groups_count: generated.groupsCount,
      admins_count: generated.adminsCount,
    });
    return {
      serverId,
      state: 'in_sync',
      expectedHash: generated.hash,
      actualHash: currentHash,
      groupsCount: generated.groupsCount,
      adminsCount: generated.adminsCount,
    };
  }

  try {
    await bridge.fileAtomicWrite({ path, content: newContent });
  } catch (err) {
    const msg = (err as Error).message;
    log.warn({ serverId, err: msg }, 'admins.cfg atomic write failed');
    await publishStatus(redis, serverId, {
      state: 'unreachable',
      last_synced_at: null,
      last_segment_hash: currentHash,
      last_db_hash: generated.hash,
      error: msg,
    });
    await safeAppendAudit(db, log, serverId, {
      actorPlayerId: opts.actorPlayerId,
      actionType: 'admins_cfg.sync_failed',
      targetType: 'server',
      targetId: serverId,
      before: { segment_hash: currentHash },
      after: null,
      context: {
        reason: opts.reason,
        phase: 'file_atomic_write',
        error: msg,
        groups_count: generated.groupsCount,
        admins_count: generated.adminsCount,
      },
    });
    return {
      serverId,
      state: 'unreachable',
      expectedHash: generated.hash,
      actualHash: currentHash,
      groupsCount: generated.groupsCount,
      adminsCount: generated.adminsCount,
      error: msg,
    };
  }

  await publishStatus(redis, serverId, {
    state: 'in_sync',
    last_synced_at: new Date().toISOString(),
    last_segment_hash: generated.hash,
    last_db_hash: generated.hash,
    groups_count: generated.groupsCount,
    admins_count: generated.adminsCount,
  });

  // SYNC-3 correction №1: Squad does NOT passively re-read Admins.cfg — the
  // panel must issue an RCON `AdminReloadServerConfig` so the freshly-written
  // permissions take effect without a container restart. Best-effort and gated
  // on a connected RCON listener; never blocks or fails the sync itself.
  const reload = await requestAdminsCfgReload(redis, serverId, log);

  try {
    await appendWorkerAudit(db, {
      actorPlayerId: opts.actorPlayerId,
      actionType: opts.forceWrite ? 'admins_cfg.force_synced' : 'admins_cfg.synced',
      targetType: 'server',
      targetId: serverId,
      before: { segment_hash: currentHash },
      after: { segment_hash: generated.hash },
      context: {
        reason: opts.reason,
        groups_count: generated.groupsCount,
        admins_count: generated.adminsCount,
        reload,
      },
    });
  } catch (err) {
    log.error({ serverId, err: (err as Error).message }, 'audit append failed (non-fatal)');
  }

  return {
    serverId,
    state: 'wrote',
    expectedHash: generated.hash,
    actualHash: currentHash,
    groupsCount: generated.groupsCount,
    adminsCount: generated.adminsCount,
    reload,
  };
}

async function safeAppendAudit(
  db: DatabaseClient,
  log: Logger,
  serverId: string,
  entry: Parameters<typeof appendWorkerAudit>[1],
): Promise<void> {
  try {
    await appendWorkerAudit(db, entry);
  } catch (err) {
    log.error({ serverId, err: (err as Error).message }, 'audit append failed (non-fatal)');
  }
}
