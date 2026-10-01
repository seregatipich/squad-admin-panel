import { createWorkerLog, runWorker } from '@squad/worker-kit';

const log = createWorkerLog('audit-archiver');

/**
 * Heartbeat status shown on the panel's system-status card. Says outright that
 * nothing is archived, so a live heartbeat is not mistaken for a working
 * audit-retention pipeline.
 */
export const AUDIT_ARCHIVER_HEARTBEAT_STATUS = 'архивация не реализована (P1)';

/**
 * Phase 0 stub. The archiver will export a verified hash-chain snapshot
 * of audit_log to restic on a daily schedule in Phase 1. For P0 it still
 * publishes a heartbeat so the panel's system-status card can see that
 * the worker is alive, not just its container running. It deliberately
 * emits no "run ok" diagnostics: nothing is archived yet, so reporting a
 * successful cycle would be a false signal.
 */
runWorker({
  name: 'audit-archiver',
  log,
  entrypoint: import.meta.url,
  redis: { optional: true },
  heartbeatStatus: AUDIT_ARCHIVER_HEARTBEAT_STATUS,
  setup: () => {
    log.info('worker-audit-archiver idle — Phase 1 functionality deferred');
    return { ticks: [] };
  },
});
