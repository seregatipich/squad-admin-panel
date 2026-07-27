import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { createDiag, type Diag } from '@squad/diag';
import { startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-presence-daily' },
});

const COMPONENT = 'worker-presence-daily';
const TICK_INTERVAL_MS = 60 * 60 * 1000;

export interface PresenceTickDeps {
  sql: postgres.Sql;
  diag: Diag;
  now?: Date;
}

export async function runEconomyAccrual(deps: PresenceTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const now = deps.now ?? new Date();
  const window = recentPresenceWindow(now);
  try {
    let players = 0;
    let transactions = 0;
    let balanceDelta = 0;
    let economyEnabled = false;
    for (const day of daysInWindow(window.fromDay, window.toDay)) {
      const result = await accrueDailyBonuses(sql, { day, now });
      economyEnabled = economyEnabled || result.economyEnabled;
      players += result.playersAccrued;
      transactions += result.transactionsWritten;
      balanceDelta += result.balanceDelta;
    }
    log.info(
      { ...window, economyEnabled, players, transactions, balanceDelta },
      'economy accrual ok',
    );
    await diag.emit({
      component: COMPONENT,
      kind: 'economy_accrual.run_ok',
      severity: 'info',
      message: `accrued ${window.fromDay}..${window.toDay}`,
      payload: { ...window, economyEnabled, players, transactions, balanceDelta },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, ...window }, 'economy accrual failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'economy_accrual.run_failed',
      severity: 'error',
      message: `accrual failed: ${message}`,
      payload: { ...window },
    });
  }
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log.fatal('DATABASE_URL is required');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : null;
  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name: 'presence-daily',
        statusFn: () => 'idle',
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  const diag: Diag = redis ? createDiag({ redis, log }) : { async emit() {} };

  await diag.emit({
    component: COMPONENT,
    kind: 'presence_daily.started',
    severity: 'info',
    message: 'presence-daily started',
    payload: { pid: process.pid },
  });

  if (process.env.COPLAY_FULL_REBUILD === '1') {
    await runCoplayFullRebuild({ sql, diag });
  }

  await runPresenceDailyTick({ sql, diag });
  const interval = setInterval(() => {
    runPresenceDailyTick({ sql, diag }).catch((err) =>
      log.error({ err: (err as Error).message }, 'presence tick failed'),
    );
  }, TICK_INTERVAL_MS);

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    clearInterval(interval);
    await diag.emit({
      component: COMPONENT,
      kind: 'presence_daily.stopped',
      severity: 'info',
      message: `presence-daily received ${sig}`,
      payload: { sig },
    });
    stopHeartbeat();
    await sql.end({ timeout: 5 });
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
