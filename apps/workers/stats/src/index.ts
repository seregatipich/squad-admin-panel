import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reconcileDossierAggregates } from '@squad/db';
import { createDiag, type Diag } from '@squad/diag';
import { startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-stats' } });

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

async function main() {
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : null;
  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name: 'stats',
        statusFn: () => 'idle',
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  const diag: Diag = redis ? createDiag({ redis, log }) : { async emit() {} };

  const url = process.env.DATABASE_URL;
  const sql = url ? postgres(url, { max: 1 }) : null;
  let interval: NodeJS.Timeout | null = null;

  if (sql) {
    log.info('worker-stats started — dossier reconcile guard active');
    await runStatsReconcileTick({ sql, diag });
    interval = setInterval(() => {
      runStatsReconcileTick({ sql, diag }).catch((err) =>
        log.error({ err: (err as Error).message }, 'dossier reconcile tick failed'),
      );
    }, RECONCILE_INTERVAL_MS);
  } else {
    log.info('worker-stats idle — DATABASE_URL unset, dossier reconcile disabled');
  }

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    if (interval) clearInterval(interval);
    stopHeartbeat();
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function isMainEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  main().catch((err) => {
    log.fatal({ err: (err as Error).message }, 'fatal');
    process.exit(1);
  });
}
