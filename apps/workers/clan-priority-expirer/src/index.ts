import { createWorkerLog, runWorker } from '@squad/worker-kit';
import { positiveIntEnv } from './env.js';
import { createClanPriorityExpiryDeps, runClanPriorityExpiryTick } from './tick.js';

const log = createWorkerLog('clan-priority-expirer');

const TICK_INTERVAL_MS = positiveIntEnv('CLAN_PRIORITY_EXPIRER_INTERVAL_MS', 60_000);

runWorker({
  name: 'clan-priority-expirer',
  log,
  entrypoint: import.meta.url,
  postgres: { drizzle: true },
  setup: ({ db, diag }) => {
    const runtimeDeps = createClanPriorityExpiryDeps(db);
    return {
      ticks: [
        {
          intervalMs: TICK_INTERVAL_MS,
          // A tick can outlast the interval; overlapping passes could expire the same
          // clan twice and duplicate its audit and sync side effects.
          overlap: { warn: 'previous clan-priority-expirer tick still running; skipping' },
          failureMessage: 'clan-priority-expirer tick failed',
          run: async () => {
            const result = await runClanPriorityExpiryTick({ ...runtimeDeps, diag });
            log.info(result, 'clan-priority-expirer tick');
          },
        },
      ],
    };
  },
});
