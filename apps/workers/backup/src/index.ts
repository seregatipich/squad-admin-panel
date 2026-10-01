import { createWorkerLog, runWorker } from '@squad/worker-kit';

const log = createWorkerLog('backup');

runWorker({
  name: 'backup',
  log,
  entrypoint: import.meta.url,
  redis: { optional: true },
  heartbeatStatus: 'idle (P2)',
  lifecycleDiag: false,
  setup: () => {
    log.info(
      'worker-backup placeholder idle — not deployed; backups run in the restic compose service (profile backup)',
    );
    return { ticks: [] };
  },
});
