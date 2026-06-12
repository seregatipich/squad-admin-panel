import { createHash } from 'node:crypto';
import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { configVersions, serverSettings, servers } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES, PANEL_CONFIGS_ROOT, PANEL_SAVED_ROOT } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

export interface DeleteResult {
  backup_marker_id: string | null;
  files_backed_up: number;
  files_attempted: number;
  container_removed: boolean;
  configs_dir_removed: boolean;
  saved_dir_removed: boolean;
  ufw_rules_removed: number;
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
    ufw_rules_removed: 0,
    errors: [],
  };

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

  let backupMarkerId: string | null = null;
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

  await ctx.db
    .update(servers)
    .set({
      deletedAt: new Date(),
      deletedByPlayerId: ctx.actorPlayerId,
      deletionBackupMarkerId: backupMarkerId,
      updatedAt: new Date(),
    })
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

  return result;
}
