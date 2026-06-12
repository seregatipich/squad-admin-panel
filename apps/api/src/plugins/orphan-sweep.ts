import fp from 'fastify-plugin';
import { fireAutoPrune } from '../lib/auto-prune.js';
import { cleanupOrphans } from '../lib/cleanup-orphans.js';

const SWEEP_INTERVAL_MS = Number(process.env.HOST_ORPHAN_SWEEP_INTERVAL_MS ?? 5 * 60_000);
const DOCKER_PRUNE_INTERVAL_MS = Number(
  process.env.HOST_DOCKER_PRUNE_INTERVAL_MS ?? 24 * 60 * 60_000,
);
const BOOT_DELAY_MS = 30_000;

/**
 * Periodically removes host directories whose UUID is no longer in the
 * `servers` table, and runs `docker system prune -af` on a daily timer
 * so build cache + dangling images don't accumulate. Both operations go
 * through the bridge's existing allowlists, so a corrupted DB query
 * cannot broaden the blast radius.
 */
export default fp(async (app) => {
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

  const runDockerPrune = () => {
    fireAutoPrune(app, 'periodic', null, null);
  };

  // Boot delay so the bridge connection is warm before the first sweep.
  const bootTimer = setTimeout(() => {
    void runOrphanSweep();
    runDockerPrune();
    orphanTimer = setInterval(() => void runOrphanSweep(), SWEEP_INTERVAL_MS);
    pruneTimer = setInterval(runDockerPrune, DOCKER_PRUNE_INTERVAL_MS);
  }, BOOT_DELAY_MS);

  app.addHook('onClose', async () => {
    clearTimeout(bootTimer);
    if (orphanTimer) clearInterval(orphanTimer);
    if (pruneTimer) clearInterval(pruneTimer);
  });
});
