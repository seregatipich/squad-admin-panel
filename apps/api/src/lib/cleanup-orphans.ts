import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { servers } from '@squad/db/schema';
import {
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_CONTAINER_PREFIX,
} from '@squad/shared-config';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { writeAuditEntry } from './audit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CleanupResult {
  orphans_configs: string[];
  orphans_saved: string[];
  orphans_containers: string[];
  removed_configs: string[];
  removed_saved: string[];
  removed_containers: string[];
  errors: Array<{ kind: 'configs' | 'saved' | 'container'; uuid: string; error: string }>;
}

export interface CleanupContext {
  db: DatabaseClient;
  bridge: Pick<
    BridgeClient,
    'listPanelDirs' | 'directoryDelete' | 'listSquadContainers' | 'containerStop' | 'containerRm'
  >;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  /** Set to a steam id to attribute audit rows; null for periodic sweep. */
  actorSteamId64: bigint | null;
  actorIp: string | null;
  /**
   * If true, only report what would be removed without calling
   * directoryDelete / containerStop. Used by GET endpoint and the
   * dry-run periodic sweep.
   */
  dryRun?: boolean;
}

/**
 * Inventories the two panel data roots AND running squad-* containers,
 * and removes any UUID-named child directory or container whose UUID is
 * **not** in the `servers` table — including soft-deleted servers,
 * which the panel still needs for restore.
 *
 * Containers are stopped+rm'd through the bridge's `container_stop` /
 * `container_rm` allowlists which strictly validate the `squad-{uuid}`
 * name regex, so a corrupted DB query cannot broaden the blast radius.
 *
 * Safe by construction:
 *   - Only the two allowlisted roots are inspected (bridge enforces this).
 *   - Only directories / container names matching the strict UUID regex
 *     are considered eligible. Anything else is skipped silently.
 *   - The corresponding live `servers.id` is queried in a single
 *     statement before any deletion.
 */
export async function cleanupOrphans(ctx: CleanupContext): Promise<CleanupResult> {
  const [{ configs, saved }, { containers }] = await Promise.all([
    ctx.bridge.listPanelDirs(),
    ctx.bridge.listSquadContainers().catch(() => ({ containers: [] as string[] })),
  ]);
  const validConfigs = configs.filter((d) => UUID_RE.test(d));
  const validSaved = saved.filter((d) => UUID_RE.test(d));
  const validContainers = containers
    .map((name) => name.replace(SERVER_CONTAINER_PREFIX, ''))
    .filter((id) => UUID_RE.test(id));

  type Row = Record<string, unknown> & { id: string };
  const known = await ctx.db.execute<Row>(sql`SELECT id::text FROM servers`);
  const knownIds = new Set((known as unknown as Row[]).map((r) => r.id));

  const orphansConfigs = validConfigs.filter((d) => !knownIds.has(d));
  const orphansSaved = validSaved.filter((d) => !knownIds.has(d));
  const orphansContainers = validContainers.filter((id) => !knownIds.has(id));

  const result: CleanupResult = {
    orphans_configs: orphansConfigs,
    orphans_saved: orphansSaved,
    orphans_containers: orphansContainers,
    removed_configs: [],
    removed_saved: [],
    removed_containers: [],
    errors: [],
  };

  if (ctx.dryRun) return result;

  // Stop+rm orphan containers FIRST so they release the disk + RAM
  // they were holding before we wipe their saved/configs dirs.
  for (const uuid of orphansContainers) {
    const name = `${SERVER_CONTAINER_PREFIX}${uuid}`;
    try {
      await ctx.bridge.containerStop({ name, timeout_sec: 10 }).catch(() => undefined);
      await ctx.bridge.containerRm({ name });
      result.removed_containers.push(uuid);
      ctx.log.info({ uuid, kind: 'container' }, 'orphan container removed');
    } catch (err) {
      const msg = (err as Error).message;
      // not_found is fine — container was already gone between list and rm.
      if (/not[_ ]?found|no such container/i.test(msg)) {
        result.removed_containers.push(uuid);
        continue;
      }
      ctx.log.warn({ uuid, kind: 'container', err: msg }, 'orphan container removal failed');
      result.errors.push({ kind: 'container', uuid, error: msg });
    }
  }

  for (const uuid of orphansConfigs) {
    try {
      const r = await ctx.bridge.directoryDelete({ path: `${PANEL_CONFIGS_ROOT}/${uuid}` });
      if (r.removed) {
        result.removed_configs.push(uuid);
        ctx.log.info({ uuid, kind: 'configs' }, 'orphan dir removed');
      }
    } catch (err) {
      const msg = (err as Error).message;
      ctx.log.warn({ uuid, kind: 'configs', err: msg }, 'orphan dir delete failed');
      result.errors.push({ kind: 'configs', uuid, error: msg });
    }
  }
  for (const uuid of orphansSaved) {
    try {
      const r = await ctx.bridge.directoryDelete({ path: `${PANEL_SAVED_ROOT}/${uuid}` });
      if (r.removed) {
        result.removed_saved.push(uuid);
        ctx.log.info({ uuid, kind: 'saved' }, 'orphan dir removed');
      }
    } catch (err) {
      const msg = (err as Error).message;
      ctx.log.warn({ uuid, kind: 'saved', err: msg }, 'orphan dir delete failed');
      result.errors.push({ kind: 'saved', uuid, error: msg });
    }
  }

  if (
    result.removed_configs.length > 0 ||
    result.removed_saved.length > 0 ||
    result.removed_containers.length > 0
  ) {
    await writeAuditEntry(ctx.db, {
      actor: ctx.actorSteamId64
        ? { kind: 'steam', steamId64: ctx.actorSteamId64, tokenId: null }
        : { kind: 'system', label: 'periodic-orphan-sweep' },
      actorIp: ctx.actorIp,
      actionType: 'host.cleanup_orphans',
      targetType: 'host',
      targetId: 'localhost',
      context: {
        removed_configs: result.removed_configs,
        removed_saved: result.removed_saved,
        removed_containers: result.removed_containers,
        errors: result.errors,
      },
      statusCode: 200,
    });
  }

  // Drizzle import retained for type ergonomics
  void servers;

  return result;
}
