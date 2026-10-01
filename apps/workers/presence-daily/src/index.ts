import {
  accrueDailyBonuses,
  daysInWindow,
  recentCoplayWindow,
  recentPresenceWindow,
  recomputeCoplayForAllSessions,
  recomputeCoplayWindow,
  recomputeDailyPresence,
  recomputeServerDailyStats,
} from '@squad/db';
import type { Diag } from '@squad/diag';
import { createWorkerLog, runWorker } from '@squad/worker-kit';
import type postgres from 'postgres';

const log = createWorkerLog('presence-daily');

const COMPONENT = 'worker-presence-daily';
const TICK_INTERVAL_MS = 60 * 60 * 1000;

export interface PresenceTickDeps {
  sql: postgres.Sql;
  diag: Diag;
  now?: Date;
}

/**
 * Accrue economy bonuses for every day in the recent presence window.
 *
 * Each day runs in its own try so a failure on one day (typically "yesterday",
 * which is processed first) never blocks accrual for the others (#18). Every
 * failed day emits its own `economy_accrual.run_failed`; `economy_accrual.run_ok`
 * is emitted only when every day in the window succeeded.
 */
export async function runEconomyAccrual(deps: PresenceTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const now = deps.now ?? new Date();
  const window = recentPresenceWindow(now);
  let players = 0;
  let transactions = 0;
  let balanceDelta = 0;
  let shortfallForgiven = 0;
  let economyEnabled = false;
  let failedDays = 0;
  for (const day of daysInWindow(window.fromDay, window.toDay)) {
    try {
      const result = await accrueDailyBonuses(sql, { day, now });
      economyEnabled = economyEnabled || result.economyEnabled;
      players += result.playersAccrued;
      transactions += result.transactionsWritten;
      balanceDelta += result.balanceDelta;
      shortfallForgiven += result.shortfallForgiven;
    } catch (err) {
      failedDays += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, ...window, day }, 'economy accrual failed');
      await diag.emit({
        component: COMPONENT,
        kind: 'economy_accrual.run_failed',
        severity: 'error',
        message: `accrual failed for ${day}: ${message}`,
        payload: { ...window, day },
      });
    }
  }
  if (failedDays > 0) return;
  log.info(
    { ...window, economyEnabled, players, transactions, balanceDelta, shortfallForgiven },
    'economy accrual ok',
  );
  await diag.emit({
    component: COMPONENT,
    kind: 'economy_accrual.run_ok',
    severity: 'info',
    message: `accrued ${window.fromDay}..${window.toDay}`,
    payload: { ...window, economyEnabled, players, transactions, balanceDelta, shortfallForgiven },
  });
}

export async function runPresenceDailyTick(deps: PresenceTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const now = deps.now ?? new Date();
  const window = recentPresenceWindow(now);
  try {
    const rows = await recomputeDailyPresence(sql, { ...window, now });
    log.info({ ...window, rows }, 'presence daily recompute ok');
    await diag.emit({
      component: COMPONENT,
      kind: 'presence_daily.run_ok',
      severity: 'info',
      message: `recomputed ${window.fromDay}..${window.toDay}`,
      payload: { ...window, rows },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, ...window }, 'presence daily recompute failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'presence_daily.run_failed',
      severity: 'error',
      message: `recompute failed: ${message}`,
      payload: { ...window },
    });
  }

  // `server_daily_stats` has exactly one writer, and this is it. The rollup shares
  // presence's yesterday+today window because both read the same closed-and-open
  // sessions, and it runs after the presence recompute so a failure there cannot
  // leave the two tables describing different windows.
  try {
    const rows = await recomputeServerDailyStats(sql, { ...window, now });
    log.info({ ...window, rows }, 'server daily stats rollup ok');
    await diag.emit({
      component: COMPONENT,
      kind: 'server_daily_stats.run_ok',
      severity: 'info',
      message: `server daily stats recomputed ${window.fromDay}..${window.toDay}`,
      payload: { ...window, rows },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, ...window }, 'server daily stats rollup failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'server_daily_stats.run_failed',
      severity: 'error',
      message: `server daily stats recompute failed: ${message}`,
      payload: { ...window },
    });
  }

  const coplayWindow = recentCoplayWindow(now);
  try {
    const rows = await recomputeCoplayWindow(sql, { ...coplayWindow, now });
    log.info({ ...coplayWindow, rows }, 'coplay recompute ok');
    await diag.emit({
      component: COMPONENT,
      kind: 'coplay.run_ok',
      severity: 'info',
      message: `coplay recomputed ${coplayWindow.fromDay}..${coplayWindow.toDay}`,
      payload: { ...coplayWindow, rows },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, ...coplayWindow }, 'coplay recompute failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'coplay.run_failed',
      severity: 'error',
      message: `coplay recompute failed: ${message}`,
      payload: { ...coplayWindow },
    });
  }

  await runEconomyAccrual({ sql, diag, now });
}

/**
 * Full rebuild of the co-play graph across every day with session data
 * (ALT-3's "административная команда"). Not part of the regular hourly tick
 * — invoked once at startup when `COPLAY_FULL_REBUILD=1` is set, e.g.:
 * `docker compose run --rm -e COPLAY_FULL_REBUILD=1 worker-presence-daily`.
 * Deletes and rewrites every `player_coplay` bucket inside one transaction,
 * so it should be run one-shot, not by flipping the env var on the
 * long-running service.
 */
export async function runCoplayFullRebuild(deps: PresenceTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const now = deps.now ?? new Date();
  try {
    const rows = await recomputeCoplayForAllSessions(sql, now);
    log.info({ rows }, 'coplay full rebuild ok');
    await diag.emit({
      component: COMPONENT,
      kind: 'coplay.full_rebuild_ok',
      severity: 'info',
      message: `coplay full rebuild wrote ${rows} rows`,
      payload: { rows },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'coplay full rebuild failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'coplay.full_rebuild_failed',
      severity: 'error',
      message: `coplay full rebuild failed: ${message}`,
      payload: {},
    });
  }
}

runWorker({
  name: 'presence-daily',
  log,
  entrypoint: import.meta.url,
  postgres: { options: { max: 1 } },
  redis: { optional: true },
  heartbeatStatus: 'idle',
  setup: ({ sql, diag }) => ({
    beforeFirstTick: async () => {
      if (process.env.COPLAY_FULL_REBUILD === '1') {
        await runCoplayFullRebuild({ sql, diag });
      }
    },
    ticks: [
      {
        intervalMs: TICK_INTERVAL_MS,
        overlap: 'allow',
        failureMessage: 'presence tick failed',
        run: () => runPresenceDailyTick({ sql, diag }),
      },
    ],
  }),
});
