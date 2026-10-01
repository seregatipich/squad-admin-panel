import { createWorkerLog, runWorker } from '@squad/worker-kit';
import { createClanGuardDeps } from './deps.js';
import { positiveIntEnv } from './env.js';
import { runClanGuardTick } from './tick.js';

const log = createWorkerLog('clan-guard');

const TICK_INTERVAL_MS = positiveIntEnv('CLAN_GUARD_INTERVAL_MS', 120_000);

runWorker({
  name: 'clan-guard',
  log,
  entrypoint: import.meta.url,
  postgres: { drizzle: true },
  setup: ({ db, redis, diag }) => {
    const runtimeDeps = createClanGuardDeps(db, redis);
    return {
      ticks: [
        {
          intervalMs: TICK_INTERVAL_MS,
          // A tick can outlast the interval; overlapping passes would both miss the
          // other's warn and send duplicate AdminWarn commands and ledger rows.
          overlap: { warn: 'previous clan-guard tick still running; skipping' },
          failureMessage: 'clan-guard tick failed',
          run: async () => {
            const result = await runClanGuardTick({ ...runtimeDeps, diag });
            log.info(result, 'clan-guard tick');
          },
        },
      ],
    };
  },
});
