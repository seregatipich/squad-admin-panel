import { reconcileDossierAggregates } from '@squad/db';
import type { Diag } from '@squad/diag';
import { createWorkerLog, runWorker } from '@squad/worker-kit';
import type postgres from 'postgres';

const log = createWorkerLog('stats');

const COMPONENT = 'worker-stats';
// DOSSIER-2 (#189): guard against events missed during downtime. Runs nightly and
// only inspects the last 48 h of combat_events (see RECONCILE_WINDOW_HOURS), which
// bounds the scan and never false-positives on aged-out partitions. Report-only —
// it never rebuilds the aggregates (which would erase multi-year history once
// combat_events partitions age out); it alerts so an operator can repair.
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RECONCILE_WINDOW_HOURS = 48;

export interface StatsReconcileDeps {
  sql: postgres.Sql;
  diag: Diag;
}

/**
 * Runs one dossier-reconcile pass: recompute the expected per-weapon/per-vehicle
 * aggregates from the `combat_events` of the last {@link RECONCILE_WINDOW_HOURS}
 * hours and compare them with the stored tables. Emits `dossier_reconcile.run_ok`
 * when consistent, or a `dossier_reconcile.drift_detected` warning carrying the
 * per-table drift counts.
 */
export async function runStatsReconcileTick(deps: StatsReconcileDeps): Promise<void> {
  const { sql, diag } = deps;
  try {
    const { discrepancies } = await reconcileDossierAggregates(sql, {
      windowHours: RECONCILE_WINDOW_HOURS,
    });
    if (discrepancies.total > 0) {
      log.warn({ discrepancies }, 'dossier aggregates drifted from combat_events');
      await diag.emit({
        component: COMPONENT,
        kind: 'dossier_reconcile.drift_detected',
        severity: 'warn',
        message: `dossier aggregates drifted on ${discrepancies.total} key(s)`,
        payload: { ...discrepancies },
      });
      return;
    }
    log.info('dossier aggregates reconcile ok');
    await diag.emit({
      component: COMPONENT,
      kind: 'dossier_reconcile.run_ok',
      severity: 'info',
      message: 'dossier aggregates consistent with combat_events',
      payload: { ...discrepancies },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'dossier reconcile failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'dossier_reconcile.run_failed',
      severity: 'error',
      message: `dossier reconcile failed: ${message}`,
      payload: {},
    });
  }
}

runWorker({
  name: 'stats',
  log,
  entrypoint: import.meta.url,
  postgres: { optional: true, options: { max: 1 } },
  redis: { optional: true },
  heartbeatStatus: 'idle',
  lifecycleDiag: false,
  setup: ({ sql, diag }) => {
    if (!sql) {
      log.info('worker-stats idle — DATABASE_URL unset, dossier reconcile disabled');
      return { ticks: [] };
    }
    log.info('worker-stats started — dossier reconcile guard active');
    return {
      ticks: [
        {
          intervalMs: RECONCILE_INTERVAL_MS,
          overlap: 'allow',
          failureMessage: 'dossier reconcile tick failed',
          run: () => runStatsReconcileTick({ sql, diag }),
        },
      ],
    };
  },
});
