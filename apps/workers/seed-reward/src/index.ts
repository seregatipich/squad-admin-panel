import { intervalMsFromEnv } from '@squad/shared-config';
import { createWorkerLog, runWorker } from '@squad/worker-kit';
import { createSeedRewardDeps, runSeedRewardTick } from './tick.js';

const log = createWorkerLog('seed-reward');

const TICK_INTERVAL_MS = intervalMsFromEnv(process.env.SEED_REWARD_INTERVAL_MS, 86_400_000);

runWorker({
  name: 'seed-reward',
  log,
  entrypoint: import.meta.url,
  postgres: { drizzle: true },
  setup: ({ db, redis, diag }) => {
    const runtimeDeps = createSeedRewardDeps(db, redis);
    return {
      ticks: [
        {
          intervalMs: TICK_INTERVAL_MS,
          overlap: 'allow',
          failureMessage: 'seed-reward tick failed',
          run: async () => {
            const result = await runSeedRewardTick({ ...runtimeDeps, diag });
            log.info(result, 'seed-reward tick');
          },
        },
      ],
    };
  },
});
