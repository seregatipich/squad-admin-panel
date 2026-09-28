import fp from 'fastify-plugin';
import { fireAutoPrune } from '../lib/auto-prune.js';
import { cleanupOrphans } from '../lib/cleanup-orphans.js';

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DOCKER_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const BOOT_DELAY_MS = 30_000;

export interface OrphanSweepOptions {
  /** Orphan-sweep period; `HOST_ORPHAN_SWEEP_INTERVAL_MS`, validated in `AppConfig`. */
  sweepIntervalMs?: number;
  /** Docker prune period; `HOST_DOCKER_PRUNE_INTERVAL_MS`, validated in `AppConfig`. */
  dockerPruneIntervalMs?: number;
}

/**
 * Periodically removes host directories whose UUID is no longer in the
 * `servers` table, and runs `docker system prune -af` on a daily timer
 * so build cache + dangling images don't accumulate. Both operations go
 * through the bridge's existing allowlists, so a corrupted DB query
 * cannot broaden the blast radius. The prune is skipped (warn log, no
 * audit row) on ticks where the bridge does not answer a ping.
 */
export default fp<OrphanSweepOptions>(async (app, opts) => {
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const dockerPruneIntervalMs = opts.dockerPruneIntervalMs ?? DEFAULT_DOCKER_PRUNE_INTERVAL_MS;
  let orphanTimer: NodeJS.Timeout | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;

  const runOrphanSweep = async () => {
    try {
      const result = await cleanupOrphans({
        db: app.db,
        bridge: app.bridge,
        log: app.log,
        actorPlayerId: null,
        actorIp: null,
      });
      const removed = result.removed_configs.length + result.removed_saved.length;
      if (removed > 0 || result.errors.length > 0) {
        app.log.info(
          {
            removed_configs: result.removed_configs.length,
            removed_saved: result.removed_saved.length,
            errors: result.errors.length,
          },
          'orphan sweep',
        );
      }
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'orphan sweep failed');
    }
  };

  // A scheduled prune that cannot even reach the bridge would only add a
  // 502 audit row per API boot; the outage is already surfaced by the
  // bridge heartbeat, so log and wait for the next tick instead.
  const runDockerPrune = async () => {
    try {
      await app.bridge.ping();
    } catch (err) {
      app.log.warn(
        { err: (err as Error).message },
        'periodic docker prune skipped: bridge unreachable',
      );
      return;
    }
    fireAutoPrune(app, 'periodic', null, null);
  };

  // Boot delay so the bridge connection is warm before the first sweep.
  const bootTimer = setTimeout(() => {
    void runOrphanSweep();
    void runDockerPrune();
    orphanTimer = setInterval(() => void runOrphanSweep(), sweepIntervalMs);
    pruneTimer = setInterval(() => void runDockerPrune(), dockerPruneIntervalMs);
  }, BOOT_DELAY_MS);

  app.addHook('onClose', async () => {
    clearTimeout(bootTimer);
    if (orphanTimer) clearInterval(orphanTimer);
    if (pruneTimer) clearInterval(pruneTimer);
  });
});
