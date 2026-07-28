import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { createDiag, type Diag } from '@squad/diag';
import { createGracefulShutdownController, startHeartbeat } from '@squad/shared-config';
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
} from './deps.js';
import { runMapVoteTick } from './map-vote-tick.js';
import { runRotationProfileTick } from './rotation-profile-tick.js';
import { runRotationScheduleTick } from './rotation-schedule-tick.js';
import { runScheduledTaskTick } from './scheduled-task-tick.js';
import { runSeasonFinalizeTick } from './season-finalize-tick.js';
import { runSeedScheduleTick } from './seed-schedule-tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-scheduler' },
});

const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);
const DEFAULT_ROTATION_PROFILE_APPLY_HOUR = 4;

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
 * `@squad/worker-scheduler`: hosts the SEED-3 and ROT-4 scheduled ticks.
 * RCON changes are queued for worker-rcon; weekly profiles use the host
 * bridge to replace only the managed LayerRotation.cfg segment.
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
  const runtimeDeps = createSeedScheduleDeps(db, redis);
  const rotationScheduleDeps = createRotationScheduleDeps(db, redis);
  const rotationProfileDeps = createRotationProfileDeps(db, bridge);
  const scheduledTaskDeps = createScheduledTaskDeps(db, redis, bridge);
  const mapVoteDeps = createMapVoteDeps(db, redis);
  const seasonFinalizeDeps = createSeasonFinalizeDeps(db, redis);
  const profileApplyHour = rotationProfileApplyHour();

  async function tick(): Promise<void> {
    const [
      seedResult,
      rotationResult,
      profileResult,
      scheduledTaskResult,
      mapVoteResult,
      seasonFinalizeResult,
    ] = await Promise.all([
      runSeedScheduleTick({ ...runtimeDeps, diag }),
      runRotationScheduleTick({ ...rotationScheduleDeps, diag }),
      runRotationProfileTick({ ...rotationProfileDeps, applyHour: profileApplyHour, diag }),
      runScheduledTaskTick({ ...scheduledTaskDeps, diag }),
      runMapVoteTick({ ...mapVoteDeps, diag }),
      runSeasonFinalizeTick({ ...seasonFinalizeDeps, diag }),
    ]);
    lastTickAt = new Date().toISOString();
    log.info(
      {
        seedResult,
        rotationResult,
        profileResult,
        scheduledTaskResult,
        mapVoteResult,
        seasonFinalizeResult,
      },
      'scheduler tick',
    );
  }

  let interval: NodeJS.Timeout | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      if (interval) clearInterval(interval);
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
  interval = setInterval(() => {
    tick().catch((err) => log.error({ err: (err as Error).message }, 'seed-schedule tick failed'));
  }, TICK_INTERVAL_MS);
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
