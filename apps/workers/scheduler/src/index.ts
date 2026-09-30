import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { createDiag, type Diag } from '@squad/diag';
import {
  createGracefulShutdownController,
  intervalMsFromEnv,
  startHeartbeat,
} from '@squad/shared-config';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';
import {
  createMapVoteDeps,
  createRotationProfileDeps,
  createRotationScheduleDeps,
  createScheduledTaskDeps,
  createSeasonFinalizeDeps,
  createSeedScheduleDeps,
  pruneScheduledTaskRuns,
} from './deps.js';
import { runMapVoteTick } from './map-vote-tick.js';
import {
  DEFAULT_ROTATION_PROFILE_APPLY_HOUR,
  runRotationProfileTick,
} from './rotation-profile-tick.js';
import { runRotationScheduleTick } from './rotation-schedule-tick.js';
import { runScheduledTaskTick } from './scheduled-task-tick.js';
import { runSeasonFinalizeTick } from './season-finalize-tick.js';
import { runSeedScheduleTick } from './seed-schedule-tick.js';
import { startTickLoop } from './tick-loop.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-scheduler' },
});

const TICK_INTERVAL_MS = intervalMsFromEnv(process.env.SCHEDULER_INTERVAL_MS, 30_000);

const RUN_PRUNE_INTERVAL_MS = 60 * 60_000;
const RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function rotationProfileApplyHour(): number {
  const value = Number(process.env.ROTATION_PROFILE_APPLY_HOUR);
  return Number.isInteger(value) && value >= 0 && value <= 23
    ? value
    : DEFAULT_ROTATION_PROFILE_APPLY_HOUR;
}

/**
 * `@squad/worker-scheduler`: hosts the seed schedule, one-off rotation
 * schedule, weekly rotation profile, scheduled task, map vote and season
 * finalize ticks. RCON changes are queued for worker-rcon; weekly profiles use
 * the host bridge to replace only the managed LayerRotation.cfg segment.
 */
async function main() {
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 4, prepare: false });
  const db = drizzle(sql, { schema }) as DatabaseClient;
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const diag: Diag = createDiag({ redis, log });
  const bridge = new BridgeClient({
    socketPath: process.env.PANEL_BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
    onLog: (message, meta) => log.info({ ...meta }, message),
  });
  let lastTickAt: string | null = null;
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'scheduler',
    statusFn: () => (lastTickAt ? `running (last tick ${lastTickAt})` : 'starting'),
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });
  const runtimeDeps = createSeedScheduleDeps(db, redis, bridge);
  const rotationScheduleDeps = createRotationScheduleDeps(db, redis);
  const rotationProfileDeps = createRotationProfileDeps(db, bridge);
  const scheduledTaskDeps = createScheduledTaskDeps(db, redis, bridge);
  const mapVoteDeps = createMapVoteDeps(db, redis);
  const seasonFinalizeDeps = createSeasonFinalizeDeps(db, redis);
  const profileApplyHour = rotationProfileApplyHour();

  let lastRunPruneAt = 0;

  /** Drops `scheduled_task_runs` rows past their retention, at most hourly (#1016). */
  async function pruneRunHistoryIfDue(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - lastRunPruneAt < RUN_PRUNE_INTERVAL_MS) return;
    lastRunPruneAt = nowMs;
    await pruneScheduledTaskRuns(db, new Date(nowMs - RUN_RETENTION_MS));
  }

  /**
   * Runs every scheduler tick concurrently. A tick that throws is logged under
   * its own name and does not hide the others' results or stall the heartbeat.
   */
  async function tick(): Promise<void> {
    const ticks = {
      seedSchedule: () => runSeedScheduleTick({ ...runtimeDeps, diag }),
      rotationSchedule: () => runRotationScheduleTick({ ...rotationScheduleDeps, diag }),
      rotationProfile: () =>
        runRotationProfileTick({ ...rotationProfileDeps, applyHour: profileApplyHour, diag }),
      scheduledTask: async () => {
        const result = await runScheduledTaskTick({ ...scheduledTaskDeps, diag });
        await pruneRunHistoryIfDue();
        return result;
      },
      mapVote: () => runMapVoteTick({ ...mapVoteDeps, diag }),
      seasonFinalize: () => runSeasonFinalizeTick({ ...seasonFinalizeDeps, diag }),
    };
    const names = Object.keys(ticks) as (keyof typeof ticks)[];
    const settled = await Promise.allSettled(names.map((name) => ticks[name]()));
    const results: Record<string, unknown> = {};
    settled.forEach((outcome, index) => {
      const name = names[index] as string;
      if (outcome.status === 'fulfilled') {
        results[name] = outcome.value;
        return;
      }
      const err = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      log.error({ err, tick: name }, 'scheduler tick failed');
    });
    lastTickAt = new Date().toISOString();
    log.info({ results }, 'scheduler tick');
  }

  // startTickLoop (#1000, #1015) skips an interval fire while a tick is
  // still running instead of starting a concurrent one, and lets shutdown
  // wait for the in-flight tick before closing the DB/bridge/Redis
  // connections out from under it.
  let tickLoop: ReturnType<typeof startTickLoop> | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      tickLoop?.stop();
      await tickLoop?.waitForCurrentTick();
      await diag.emit({
        component: 'worker-scheduler',
        kind: 'scheduler.stopped',
        severity: 'info',
        message: `worker-scheduler received ${sig}`,
        payload: { sig },
      });
      stopHeartbeat();
      await bridge.close();
      await sql.end({ timeout: 5 });
      await redis.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  // Connect eagerly for the log line and early failure signal, but do NOT die if
  // the bridge is not up: `BridgeClient` dials on demand (`packages/bridge-client
  // /src/client.ts` — `if (!this.socket) await this.connect()`), so every later
  // call reconnects on its own. Only the rotation-profile and scheduled-task
  // ticks need it; seed schedule, rotation schedule, map votes and season
  // finalize do not, and refusing to boot took those down too — the heartbeat
  // above never got published, so the worker looked dead rather than degraded.
  // `metrics-sampler` and `log-ingest` (the other bridge consumers) already boot
  // this way.
  await bridge
    .connect()
    .catch((err: Error) => log.warn({ err: err.message }, 'bridge not reachable at startup'));
  await diag.emit({
    component: 'worker-scheduler',
    kind: 'scheduler.started',
    severity: 'info',
    message: 'worker-scheduler started',
    payload: { pid: process.pid },
  });
  await tick();
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;
  tickLoop = startTickLoop({
    tick,
    intervalMs: TICK_INTERVAL_MS,
    onError: (err) => log.error({ err: err.message }, 'scheduler tick failed'),
  });
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
