import { createHash } from 'node:crypto';
import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { configVersions, servers } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES, PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, asc, eq, isNotNull, like } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

const SKIPPED_FILES = new Set<string>(['Rcon.cfg']);

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

export async function restoreConfigsFromArchive(
  ctx: RestoreContext,
  newServerId: string,
  archiveServerId: string,
): Promise<RestoreConfigsResult> {
  const allBackup = await ctx.db
    .select()
    .from(configVersions)
    .where(
      and(
        eq(configVersions.serverId, archiveServerId),
        like(configVersions.message, 'deletion-backup-marker%'),
      ),
    )
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
      await ctx.bridge.fileAtomicWrite({ path, content: backup.content });
    } catch (err) {
      result.errors.push({ file: filename, error: (err as Error).message });
      continue;
    }
    const sha256 = createHash('sha256').update(backup.content, 'utf8').digest();
    const inserted = await ctx.db
      .insert(configVersions)
      .values({
        serverId: newServerId,
        filename,
        content: backup.content,
        sha256,
        authorPlayerId: ctx.actorPlayerId,
        authorLabel: ctx.actorLabel,
        authorIp: ctx.actorIp,
        message,
      })
      .returning({ id: configVersions.id });
    if (inserted[0]) {
      result.config_version_ids.push(inserted[0].id);
      result.files_restored++;
    }
  }
  return result;
}

export async function getArchivedServer(db: DatabaseClient, id: string) {
  return db.query.servers.findFirst({
    where: and(eq(servers.id, id), isNotNull(servers.deletedAt)),
  });
}
