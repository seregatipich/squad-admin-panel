import { intervalMsFromEnv } from '@squad/shared-config';
import { createWorkerLog, runWorker } from '@squad/worker-kit';
import { createSteamRefreshDeps, runSteamRefreshTick } from './tick.js';

const log = createWorkerLog('steam-refresh');

const TICK_INTERVAL_MS = intervalMsFromEnv(process.env.STEAM_REFRESH_INTERVAL_MS, 60 * 60 * 1000);

runWorker({
  name: 'steam-refresh',
  log,
  entrypoint: import.meta.url,
  postgres: { drizzle: true },
  heartbeatStatus: () => (process.env.STEAM_API_KEY ? 'running' : 'disabled'),
  setup: ({ db, redis, diag }) => {
    const deps = createSteamRefreshDeps(db, redis, process.env.STEAM_API_KEY ?? '');
    return {
      startedPayload: {
        intervalMs: TICK_INTERVAL_MS,
        configured: Boolean(process.env.STEAM_API_KEY),
      },
      ticks: [
        {
          intervalMs: TICK_INTERVAL_MS,
          overlap: 'allow',
          failureMessage: 'steam-refresh tick failed',
          // A first-tick failure (e.g. a Steam outage) must not reject startup and
          // exit the process (#1027) — `restart: unless-stopped` would just crash-
          // loop it back into the same outage.
          firstRunFailure: 'log',
          run: async () => {
            const result = await runSteamRefreshTick({ ...deps, diag });
            log.info(result, 'steam-refresh tick');
          },
        },
      ],
    };
  },
});
