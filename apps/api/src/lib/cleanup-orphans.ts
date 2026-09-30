import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { servers } from '@squad/db/schema';
import {
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_CONTAINER_PREFIX,
} from '@squad/shared-config';
import type { FastifyBaseLogger } from 'fastify';
import { writeAuditEntry } from './audit.js';
import { sidecarConfigDir, sidecarContainerName } from './rnsquadjs.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIDECAR_CONTAINER_PREFIX = 'rnsquadjs-';

type OrphanKind = 'configs' | 'saved' | 'container' | 'sidecar_container' | 'sidecar_dir';

export interface CleanupResult {
  orphans_configs: string[];
  orphans_saved: string[];
  orphans_containers: string[];
  removed_configs: string[];
  removed_saved: string[];
  removed_containers: string[];
  /** `rnsquadjs-{uuid}` sidecar containers with no `servers` row. */
  orphans_sidecar_containers: string[];
  /** `/run/squad-panel/rnsquadjs/{uuid}` dirs (plaintext RCON password) with no `servers` row. */
  orphans_sidecar_dirs: string[];
  removed_sidecar_containers: string[];
  removed_sidecar_dirs: string[];
  errors: Array<{ kind: OrphanKind; uuid: string; error: string }>;
}

export interface CleanupContext {
  db: DatabaseClient;
  bridge: Pick<
    BridgeClient,
    'listPanelDirs' | 'directoryDelete' | 'listSquadContainers' | 'containerStop' | 'containerRm'
  >;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  /** Set to a player id to attribute audit rows; null for periodic sweep. */
  actorPlayerId: string | null;
  actorIp: string | null;
  /**
   * If true, only report what would be removed without calling
   * directoryDelete / containerStop. Used by GET endpoint and the
   * dry-run periodic sweep.
   */
  dryRun?: boolean;
}

/**
 * Inventories the two panel data roots, the RNSquadJS sidecar config root,
 * and every squad-* / rnsquadjs-* container, and removes any UUID-named
 * child directory or container whose UUID is **not** in the `servers`
 * table — a soft-deleted server keeps its row, and with it its data, because
 * the panel still needs it for restore.
 *
 * Containers are stopped+rm'd through the bridge's `container_stop` /
 * `container_rm` allowlists which strictly validate the `squad-{uuid}` /
 * `rnsquadjs-{uuid}` name regexes, so a corrupted DB query cannot broaden
 * the blast radius. A sidecar's config dir holds the server's plaintext
 * RCON password, so an orphaned one must not outlive its server.
 *
 * A bridge that predates sidecar listing omits the `sidecars` fields; the
 * sweep then treats the host as having no sidecars.
 *
 * Safe by construction:
 *   - Only the allowlisted roots are inspected (bridge enforces this).
 *   - Only directories / container names matching the strict UUID regex
 *     are considered eligible. Anything else is skipped silently.
 *   - The corresponding live `servers.id` is queried in a single
 *     statement before any deletion.
 */
export async function cleanupOrphans(ctx: CleanupContext): Promise<CleanupResult> {
  const [{ configs, saved, sidecars: sidecarDirs }, { containers, sidecars: sidecarContainers }] =
    await Promise.all([
      ctx.bridge.listPanelDirs(),
      ctx.bridge.listSquadContainers().catch(() => ({ containers: [] as string[], sidecars: [] })),
    ]);
  const validConfigs = configs.filter((d) => UUID_RE.test(d));
  const validSaved = saved.filter((d) => UUID_RE.test(d));
  const validContainers = containers
    .map((name) => name.replace(SERVER_CONTAINER_PREFIX, ''))
    .filter((id) => UUID_RE.test(id));
  const validSidecarDirs = (sidecarDirs ?? []).filter((d) => UUID_RE.test(d));
  const validSidecarContainers = (sidecarContainers ?? [])
    .filter((name) => name.startsWith(SIDECAR_CONTAINER_PREFIX))
    .map((name) => name.slice(SIDECAR_CONTAINER_PREFIX.length))
    .filter((id) => UUID_RE.test(id));

  const known = await ctx.db.select({ id: servers.id }).from(servers);
  const knownIds = new Set(known.map((r) => r.id));

  const orphansConfigs = validConfigs.filter((d) => !knownIds.has(d));
  const orphansSaved = validSaved.filter((d) => !knownIds.has(d));
  const orphansContainers = validContainers.filter((id) => !knownIds.has(id));
  const orphansSidecarContainers = validSidecarContainers.filter((id) => !knownIds.has(id));
  const orphansSidecarDirs = validSidecarDirs.filter((id) => !knownIds.has(id));

  const result: CleanupResult = {
    orphans_configs: orphansConfigs,
    orphans_saved: orphansSaved,
    orphans_containers: orphansContainers,
    removed_configs: [],
    removed_saved: [],
    removed_containers: [],
    orphans_sidecar_containers: orphansSidecarContainers,
    orphans_sidecar_dirs: orphansSidecarDirs,
    removed_sidecar_containers: [],
    removed_sidecar_dirs: [],
    errors: [],
  };

  if (ctx.dryRun) return result;

  // Stop+rm orphan containers FIRST so they release the disk + RAM
  // they were holding before we wipe their saved/configs dirs.
  const removeContainer = async (
    uuid: string,
    name: string,
    kind: 'container' | 'sidecar_container',
    removed: string[],
  ): Promise<void> => {
    try {
      await ctx.bridge.containerStop({ name, timeout_sec: 10 }).catch(() => undefined);
      await ctx.bridge.containerRm({ name });
      removed.push(uuid);
      ctx.log.info({ uuid, kind }, 'orphan container removed');
    } catch (err) {
      const msg = (err as Error).message;
      // not_found is fine — container was already gone between list and rm.
      if (/not[_ ]?found|no such container/i.test(msg)) {
        removed.push(uuid);
        return;
      }
      ctx.log.warn({ uuid, kind, err: msg }, 'orphan container removal failed');
      result.errors.push({ kind, uuid, error: msg });
    }
  };
  for (const uuid of orphansContainers) {
    await removeContainer(
      uuid,
      `${SERVER_CONTAINER_PREFIX}${uuid}`,
      'container',
      result.removed_containers,
    );
  }
  for (const uuid of orphansSidecarContainers) {
    await removeContainer(
      uuid,
      sidecarContainerName(uuid),
      'sidecar_container',
      result.removed_sidecar_containers,
    );
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

  for (const uuid of orphansSidecarDirs) {
    try {
      const r = await ctx.bridge.directoryDelete({ path: sidecarConfigDir(uuid) });
      if (r.removed) {
        result.removed_sidecar_dirs.push(uuid);
        ctx.log.info({ uuid, kind: 'sidecar_dir' }, 'orphan dir removed');
      }
    } catch (err) {
      const msg = (err as Error).message;
      ctx.log.warn({ uuid, kind: 'sidecar_dir', err: msg }, 'orphan dir delete failed');
      result.errors.push({ kind: 'sidecar_dir', uuid, error: msg });
    }
  }

  if (
    result.removed_configs.length > 0 ||
    result.removed_saved.length > 0 ||
    result.removed_containers.length > 0 ||
    result.removed_sidecar_containers.length > 0 ||
    result.removed_sidecar_dirs.length > 0
  ) {
    await writeAuditEntry(ctx.db, {
      actor: ctx.actorPlayerId
        ? { kind: 'steam', playerId: ctx.actorPlayerId, tokenId: null }
        : { kind: 'system', label: 'periodic-orphan-sweep' },
      actorIp: ctx.actorIp,
      actionType: 'host.cleanup_orphans',
      targetType: 'host',
      targetId: 'localhost',
      context: {
        removed_configs: result.removed_configs,
        removed_saved: result.removed_saved,
        removed_containers: result.removed_containers,
        removed_sidecar_containers: result.removed_sidecar_containers,
        removed_sidecar_dirs: result.removed_sidecar_dirs,
        errors: result.errors,
      },
      statusCode: 200,
    });
  }

  return result;
}
