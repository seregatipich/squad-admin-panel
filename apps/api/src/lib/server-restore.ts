import { createHash } from 'node:crypto';
import type { BridgeClient } from '@squad/bridge-client';
import { type DatabaseClient, withAdminsCfgServerLock } from '@squad/db';
import { configVersions, servers } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES, PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, asc, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Files never overlaid from an archive: `Rcon.cfg` is rebuilt from the new
 * server's own credentials at install, and `License.cfg` is rendered only by
 * `syncLicenseCfg` from the new server's `server_credentials` (SRV-6, #45) —
 * restoring it would bypass that store, and legacy backup rows hold the old
 * server's license key in plaintext (#10).
 */
const SKIPPED_FILES = new Set<string>(['License.cfg', 'Rcon.cfg']);

export interface RestoreConfigsResult {
  archive_server_id: string;
  files_restored: number;
  files_skipped: string[];
  files_missing: string[];
  config_version_ids: string[];
  errors: Array<{ file: string; error: string }>;
}

export interface RestoreContext {
  db: DatabaseClient;
  bridge: Pick<BridgeClient, 'fileAtomicWrite'>;
  log: Pick<FastifyBaseLogger, 'warn' | 'info' | 'error' | 'debug'>;
  actorPlayerId: string | null;
  actorIp: string | null;
  actorLabel: string;
}

/**
 * Selects exactly the `config_versions` rows `softDeleteServer` wrote as the
 * server's deletion backup: the batch that shares the message and `created_at`
 * of `servers.deletion_backup_marker_id` (one multi-row INSERT, so one
 * transaction timestamp). Matching on the `deletion-backup-marker` message
 * prefix alone is not enough — any config:edit user can choose that message
 * for an ordinary version. A server without a marker has no backup.
 *
 * Use in a query `FROM config_versions` (the outer columns are referenced by
 * table name, so the subquery cannot rebind them).
 *
 * @param serverId - The archived server.
 * @param markerId - Its `servers.deletion_backup_marker_id`.
 */
export function deletionBackupRows(serverId: string, markerId: string | null): SQL {
  if (!markerId) return sql`false`;
  return and(
    eq(configVersions.serverId, serverId),
    sql`(config_versions.message, config_versions.created_at) = (
      SELECT marker.message, marker.created_at
      FROM config_versions marker
      WHERE marker.id = ${markerId} AND marker.server_id = ${serverId}
    )`,
  ) as SQL;
}

/**
 * Overlays an archived server's deletion backup onto `newServerId`'s
 * ServerConfig directory (except {@link SKIPPED_FILES}), recording a
 * `config_versions` row per restored file.
 */
export async function restoreConfigsFromArchive(
  ctx: RestoreContext,
  newServerId: string,
  archiveServerId: string,
): Promise<RestoreConfigsResult> {
  const archive = await ctx.db.query.servers.findFirst({
    columns: { deletionBackupMarkerId: true },
    where: eq(servers.id, archiveServerId),
  });
  const allBackup = await ctx.db
    .select()
    .from(configVersions)
    .where(deletionBackupRows(archiveServerId, archive?.deletionBackupMarkerId ?? null))
    .orderBy(asc(configVersions.createdAt));

  const byFile = new Map<string, (typeof allBackup)[number]>();
  for (const row of allBackup) byFile.set(row.filename, row);

  const result: RestoreConfigsResult = {
    archive_server_id: archiveServerId,
    files_restored: 0,
    files_skipped: [],
    files_missing: [],
    config_version_ids: [],
    errors: [],
  };

  const destDir = `${PANEL_CONFIGS_ROOT}/${newServerId}/ServerConfig`;
  const ts = new Date().toISOString();
  const message = `restored from server ${archiveServerId} backup ${ts}`;

  for (const filename of ALLOWED_CONFIG_FILES) {
    if (SKIPPED_FILES.has(filename)) {
      result.files_skipped.push(filename);
      continue;
    }
    const backup = byFile.get(filename);
    if (!backup) {
      result.files_missing.push(filename);
      continue;
    }
    const path = `${destDir}/${filename}`;
    try {
      const restoreFile = async (db: Pick<DatabaseClient, 'insert'>, content: string) => {
        await ctx.bridge.fileAtomicWrite({ path, content });
        const sha256 = createHash('sha256').update(content, 'utf8').digest();
        return db
          .insert(configVersions)
          .values({
            serverId: newServerId,
            filename,
            content,
            sha256,
            authorPlayerId: ctx.actorPlayerId,
            authorLabel: ctx.actorLabel,
            authorIp: ctx.actorIp,
            message,
          })
          .returning({ id: configVersions.id });
      };
      const inserted =
        filename === 'Admins.cfg'
          ? await withAdminsCfgServerLock(ctx.db, newServerId, (tx) =>
              restoreFile(tx, backup.content),
            )
          : await restoreFile(ctx.db, backup.content);
      if (inserted[0]) {
        result.config_version_ids.push(inserted[0].id);
        result.files_restored++;
      }
    } catch (err) {
      result.errors.push({ file: filename, error: (err as Error).message });
    }
  }
  return result;
}

export async function getArchivedServer(db: DatabaseClient, id: string) {
  return db.query.servers.findFirst({
    where: and(eq(servers.id, id), isNotNull(servers.deletedAt)),
  });
}
