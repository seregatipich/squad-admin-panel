/** Versioned config writes (`config_versions` + bridge disk write) and the live reload push. */

import {
  type AdminsCfgSyncTransaction,
  type DatabaseClient,
  withAdminsCfgServerLock,
} from '@squad/db';
import { configVersions, serverCredentials, servers } from '@squad/db/schema';
import { type AllowedConfigFile, configFileClass, resolveRconHost } from '@squad/shared-config';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  assertRconCredentialsUnchanged,
  maskConfigSecrets,
  unmaskRconPassword,
} from '../config-secrets.js';
import { decryptString, deserialize } from '../crypto.js';
import { rconSendOnce } from '../rcon-send.js';
import { sendRconCommandViaWorker } from '../rcon-worker-command.js';
import { configPath, hex, sha256 } from './common.js';

/**
 * Thrown by {@link writeVersion} when the server does not exist or is
 * soft-deleted (#281): the bridge would recreate its config directory and the
 * history row would land on an archived server.
 */
export class ConfigServerNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('not_found');
    this.name = 'ConfigServerNotFoundError';
  }
}

/**
 * Runs `work` in a transaction holding a per-(server, file) advisory lock, so
 * two writes of one file cannot interleave their disk write and history
 * insert (#282). The lock is released at commit or rollback.
 */
async function withConfigFileLock<T>(
  db: DatabaseClient,
  serverId: string,
  name: AllowedConfigFile,
  work: (tx: AdminsCfgSyncTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('config-write:' || ${serverId} || ':' || ${name}, 0))`,
    );
    return work(tx);
  });
}

/**
 * Writes a new config version: dedups against the current tip by sha256,
 * otherwise inserts a `config_versions` row and persists the bytes via
 * `bridge.fileAtomicWrite`, then best-effort pushes the change live via
 * `AdminReloadServerConfig`.
 *
 * The existence check, the tip read, the insert and the disk write run in one
 * transaction under a per-(server, file) advisory lock — `Admins.cfg` uses the
 * server-wide fence it shares with config-sync delivery — so concurrent
 * writers of a file are serialized and the DB tip always describes the bytes
 * on disk (#282). The insert precedes the disk write: a failed write rolls the
 * row back instead of leaving history that never reached the disk. The reload
 * runs after commit, outside the lock.
 *
 * When the content matches the DB tip no history row is inserted, but the file
 * on disk is still converged to the intended content: if it has drifted
 * out-of-band (e.g. hand-edited over SSH) — or `opts.force` is set — the write
 * is re-applied and the server reloaded, so "revert"-to-tip actually repairs
 * drift (CFG-2, #64). Such a response carries `unchanged: true` (no new
 * history) alongside `disk_repaired` and, when a write happened, the `reload`
 * outcome.
 *
 * `Rcon.cfg` (#10, #280): a masked `Password=` line is replaced with the
 * panel's password before the disk write, the stored history row carries the
 * masked rendering, and its `sha256` is the digest of the bytes on disk. The
 * resulting `Password=`/`Port=` must match `server_credentials`.
 *
 * Exported for reuse by the rotation editor (ROT-2, #145), which writes
 * `LayerRotation.cfg` through the same versioned-history pathway as the CFG-1
 * Monaco editor, and by the unban flow, which rewrites `Bans.cfg`.
 *
 * @throws {ConfigServerNotFoundError} 404 when the server is unknown or deleted.
 * @throws {RconPasswordUnavailableError} 422 when a masked `Rcon.cfg` has no
 *   real password to fill in.
 * @throws {RconCredentialsManagedError} 422 when an `Rcon.cfg` write would move
 *   `Password=` or `Port=` away from `server_credentials`.
 */
export async function writeVersion(
  app: FastifyInstance,
  serverId: string,
  name: AllowedConfigFile,
  content: string,
  message: string | null,
  authorPlayerId: string | null,
  authorIp: string | null,
  opts?: { force?: boolean },
) {
  // #10: `content` may carry the masked RCON password (editor round-trip or a
  // masked history row). The disk gets the real bytes and the sha describes
  // them (drift and dedup compare disk digests); the history row keeps only
  // the masked rendering. Resolved before the lock: it reads other rows.
  let diskContent = content;
  if (name === 'Rcon.cfg') {
    diskContent = await unmaskRconPassword(app, serverId, content);
    await assertRconCredentialsUnchanged(app, serverId, diskContent);
  }
  const persist = (tx: AdminsCfgSyncTransaction) =>
    persistVersion(app, tx, serverId, name, diskContent, message, authorPlayerId, authorIp, opts);
  const { response, wroteDisk } =
    name === 'Admins.cfg'
      ? await withAdminsCfgServerLock(app.db, serverId, persist)
      : await withConfigFileLock(app.db, serverId, name, persist);
  if (!wroteDisk) return response;

  // Push the change live, but only for hot-reload files
  // (Admins/Bans/RemoteAdmin/RemoteBan): those are the files Squad re-reads
  // from disk when AdminReloadServerConfig fires. `rotation` files apply on
  // the next match and `requires_restart` files need a container restart, so
  // firing RCON for them is misleading — the UI surfaces `not_hot_reload` and
  // (for requires_restart) offers a restart button instead (CFG-1, #63).
  // Best-effort: skip gracefully if the server isn't running or has no RCON
  // credentials yet, and surface the outcome so the UI can guide the operator.
  const reload: ReloadOutcome =
    configFileClass(name) === 'hot_reload'
      ? await reloadServerConfig(app, serverId)
      : { applied: false, reason: 'not_hot_reload' };
  return { ...response, reload };
}

async function persistVersion(
  app: FastifyInstance,
  db: Pick<DatabaseClient, 'select' | 'insert'>,
  serverId: string,
  name: AllowedConfigFile,
  diskContent: string,
  message: string | null,
  authorPlayerId: string | null,
  authorIp: string | null,
  opts?: { force?: boolean },
) {
  const live = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .limit(1);
  if (live.length === 0) throw new ConfigServerNotFoundError();

  // read previous for parent_version_id linkage (best-effort)
  const prev = await db
    .select({ id: configVersions.id, sha: configVersions.sha256 })
    .from(configVersions)
    .where(and(eq(configVersions.serverId, serverId), eq(configVersions.filename, name)))
    .orderBy(desc(configVersions.createdAt))
    .limit(1);
  const prevRow = prev[0];
  const newSha = sha256(diskContent);
  if (prevRow && Buffer.from(prevRow.sha).equals(newSha)) {
    // History is unchanged, so we insert no new `config_versions` row. But the
    // file on disk may have drifted out-of-band (e.g. hand-edited over SSH)
    // while the DB tip stayed put. A "revert" to the tip must still converge
    // the disk back to the intended content — otherwise the drift silently
    // survives. Read the current on-disk bytes and repair only if they differ
    // (or the caller forces the write); treat a failing/absent read as "disk
    // unknown" and repair by writing, so a bridge read error never turns a
    // repair into a 500.
    let diskInSync = false;
    try {
      const onDisk = await app.bridge.fileRead({ path: configPath(serverId, name) });
      diskInSync = sha256(onDisk.content).equals(newSha);
    } catch {
      diskInSync = false;
    }
    const wroteDisk = Boolean(opts?.force) || !diskInSync;
    if (wroteDisk) {
      await app.bridge.fileAtomicWrite({ path: configPath(serverId, name), content: diskContent });
    }
    return {
      wroteDisk,
      response: {
        ok: true,
        unchanged: true,
        disk_repaired: !diskInSync,
        previous_sha256: hex(prevRow.sha),
        sha256: hex(newSha),
        behavior: configFileClass(name),
      },
    };
  }
  const inserted = await db
    .insert(configVersions)
    .values({
      serverId,
      filename: name,
      content: maskConfigSecrets(name, diskContent),
      sha256: newSha,
      parentVersionId: prevRow?.id ?? null,
      authorPlayerId,
      authorLabel: authorPlayerId ? null : 'system',
      authorIp,
      message,
    })
    .returning({ id: configVersions.id, createdAt: configVersions.createdAt });
  await app.bridge.fileAtomicWrite({ path: configPath(serverId, name), content: diskContent });
  return {
    wroteDisk: true,
    response: {
      ok: true,
      unchanged: false,
      version_id: inserted[0]?.id,
      previous_sha256: prevRow ? hex(prevRow.sha) : null,
      sha256: hex(newSha),
      created_at: inserted[0]?.createdAt,
      behavior: configFileClass(name),
    },
  };
}

export type ReloadOutcome =
  | {
      applied: true;
      via: 'rcon' | 'worker-rcon';
      command: string;
      response: string;
      request_id?: string;
    }
  | {
      applied: false;
      reason: 'not_running' | 'no_credentials' | 'rcon_failed' | 'not_hot_reload';
      detail?: string;
    };

/**
 * Exported so POST /restore can trigger the same push. Never throws — a
 * failing reload is not a failed write.
 */
export async function reloadServerConfig(
  app: FastifyInstance,
  serverId: string,
): Promise<ReloadOutcome> {
  const row = await app.db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), isNull(servers.deletedAt)),
  });
  if (!row || (row.status !== 'running' && row.status !== 'starting')) {
    return { applied: false, reason: 'not_running', detail: row?.status ?? 'unknown' };
  }
  const command = 'AdminReloadServerConfig';
  const viaWorker = await sendRconCommandViaWorker(app.redis, {
    serverId,
    command,
    timeoutMs: 4000,
  });
  if (viaWorker.attempted) {
    if (viaWorker.ok) {
      return {
        applied: true,
        via: 'worker-rcon',
        command,
        response: viaWorker.response,
        request_id: viaWorker.requestId,
      };
    }
    return {
      applied: false,
      reason: 'rcon_failed',
      detail: viaWorker.detail ?? viaWorker.reason,
    };
  }
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });
  if (!creds?.rconPasswordEncrypted) {
    return { applied: false, reason: 'no_credentials' };
  }
  try {
    const password = decryptString(
      app.encryptionKey,
      deserialize(Buffer.from(creds.rconPasswordEncrypted)),
    );
    const response = await rconSendOnce({
      host: resolveRconHost(creds.rconHost),
      port: creds.rconPort,
      password,
      command,
      connectTimeoutMs: 2_000,
      commandTimeoutMs: 4_000,
    });
    return { applied: true, via: 'rcon', command, response };
  } catch (err) {
    return {
      applied: false,
      reason: 'rcon_failed',
      detail: (err as Error).message,
    };
  }
}
