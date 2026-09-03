import type { BridgeClient } from '@squad/bridge-client';
import {
  type AdminsCfgSyncTransaction,
  type DatabaseClient,
  isVipLifecycleStrict,
  stripAdminsCfgManagedAuthority,
  withAdminsCfgServerLock,
} from '@squad/db';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { type AuditEntry, appendWorkerAuditInTransaction } from './audit.js';
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
  /** Legacy best-effort RCON outcome. Correlated outbox delivery confirms RCON
   *  in `delivery.ts`, so this is absent there even after a successful write. */
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

type LockedSyncContext = Omit<SyncContext, 'db'> & { db: AdminsCfgSyncTransaction };

export interface AdminsCfgServerLease {
  db: AdminsCfgSyncTransaction;
  sync(opts: SyncOptions): Promise<SyncResult>;
}

export interface SyncOptions {
  reason: string;
  actorPlayerId: string | null;
  forceWrite?: boolean;
  /** Explicit delivery intent; omitted keeps compatibility with old drift events. */
  mode?: 'active' | 'passive';
  /** Correlated delivery waits for an exact RCON result outside the file syncer. */
  requestReload?: boolean;
}

/**
 * Reconcile a single server's Admins.cfg against the DB-derived managed
 * segment. Idempotent. Reads via bridge.fileRead, splices the segment,
 * writes atomically via bridge.fileAtomicWrite only if the hash differs
 * (or forceWrite=true). Publishes status to Redis. On success, appends
 * audit_log row `admins_cfg.synced` (or `admins_cfg.force_synced`).
 */
async function syncServerAdminsCfgLocked(
  ctx: LockedSyncContext,
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
  const strict = await isVipLifecycleStrict(db);

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
  const unmanagedContent = strict ? stripAdminsCfgManagedAuthority(original) : original;
  const newContent = spliceManagedSegment(unmanagedContent, generated.body);

  const hashesMatch = currentHash === generated.hash;
  const authorityDrift = strict && newContent !== original;
  const hasDrift = !hashesMatch || authorityDrift;
  const isPassiveCheck =
    opts.mode === 'passive' || (opts.mode === undefined && opts.reason === 'drift_check');
  // Passive sweeps detect drift but do NOT auto-correct — the spec
  // (§2.7.6) wants the operator to be alerted with a Force-sync button
  // rather than have the worker silently overwrite manual edits. Active
  // mutations (role.update, player.role.assign, …) and explicit
  // force_sync requests still write.
  const needsWrite = opts.forceWrite || (!isPassiveCheck && hasDrift);

  if (!needsWrite) {
    if (hasDrift) {
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

  // Legacy events request the original best-effort reload here. New outbox
  // delivery defers it to delivery.ts, which waits for the exact result before
  // persisting applied_at.
  const reload =
    opts.requestReload === false ? undefined : await requestAdminsCfgReload(redis, serverId, log);

  try {
    await appendWorkerAuditInTransaction(db, {
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
        ...(reload ? { reload } : {}),
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
  db: AdminsCfgSyncTransaction,
  log: Logger,
  serverId: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    await appendWorkerAuditInTransaction(db, entry);
  } catch (err) {
    log.error({ serverId, err: (err as Error).message }, 'audit append failed (non-fatal)');
  }
}

/**
 * Hold the cross-process, per-server fence for every Admins.cfg observation and
 * side effect. The transaction deliberately remains open across bridge/RCON
 * I/O: releasing it before the atomic write or durable terminal state would
 * let a reclaimed or newer delivery publish an older snapshot last.
 */
export async function withAdminsCfgSyncLease<T>(
  ctx: SyncContext,
  serverId: string,
  work: (lease: AdminsCfgServerLease) => Promise<T>,
): Promise<T> {
  return withAdminsCfgServerLock(ctx.db, serverId, async (tx) => {
    const lockedCtx: LockedSyncContext = { ...ctx, db: tx };
    return work({
      db: tx,
      sync: (opts) => syncServerAdminsCfgLocked(lockedCtx, serverId, opts),
    });
  });
}

export async function syncServerAdminsCfg(
  ctx: SyncContext,
  serverId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  return withAdminsCfgSyncLease(ctx, serverId, (lease) => lease.sync(opts));
}
