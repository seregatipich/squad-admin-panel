import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { createDiag, type Diag } from '@squad/diag';
import {
  createGracefulShutdownController,
  type ShutdownSignalTarget,
  startHeartbeat,
} from '@squad/shared-config';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import postgres from 'postgres';
import { isMainEntrypoint } from './entrypoint.js';
import { guardAgainstOverlap } from './overlap.js';

/** Options handed to `postgres()`: four pooled connections, no prepared statements. */
const DEFAULT_POSTGRES_OPTIONS = { max: 4, prepare: false } as const;

/** How long `sql.end()` waits for in-flight queries during shutdown, in seconds. */
const POSTGRES_END_TIMEOUT_SECONDS = 5;

export type PostgresOptions = postgres.Options<Record<string, postgres.PostgresType>>;

/** What a worker needs from Postgres. */
export interface PostgresSpec {
  /**
   * `false` (default): an unset `DATABASE_URL` is fatal, exit code 1.
   * `true`: the worker runs without a pool and `ctx.sql` is `null`.
   */
  optional?: boolean;
  /** Passed to `postgres()`; defaults to `{ max: 4, prepare: false }`. */
  options?: PostgresOptions;
  /** Also build a Drizzle client over the pool as `ctx.db`. */
  drizzle?: boolean;
}

/** What a worker needs from Redis. */
export interface RedisSpec {
  /**
   * `false` (default): an unset `REDIS_URL` is fatal, exit code 1.
   * `true`: the worker runs without Redis: no heartbeat, a no-op `ctx.diag`,
   * and `ctx.redis` is `null`.
   */
  optional?: boolean;
}

type SqlOf<P extends PostgresSpec | undefined> = P extends undefined
  ? null
  : P extends { optional: true }
    ? postgres.Sql | null
    : postgres.Sql;

type DbOf<P extends PostgresSpec | undefined> = P extends { drizzle: true }
  ? P extends { optional: true }
    ? DatabaseClient | null
    : DatabaseClient
  : null;

type RedisOf<R extends RedisSpec | undefined> = R extends { optional: true } ? Redis | null : Redis;

/** The resources {@link runWorker} opened, handed to {@link WorkerSpec.setup}. */
export interface WorkerContext<
  P extends PostgresSpec | undefined = undefined,
  R extends RedisSpec | undefined = undefined,
> {
  /** The worker name, without the `worker-` prefix. */
  name: string;
  log: Logger;
  /** Publishes to the panel's diagnostic stream; a no-op when Redis is optional and unset. */
  diag: Diag;
  sql: SqlOf<P>;
  db: DbOf<P>;
  redis: RedisOf<R>;
}

/** One recurring pass of a worker. */
export interface TickJob {
  intervalMs: number;
  /** Runs one pass. A rejection is logged by the runner (see `failureMessage`). */
  run: () => Promise<void>;
  /** Logged at `error` level, with `{ err }`, when a pass rejects. */
  failureMessage: string;
  /**
   * What happens when the interval fires while the previous pass still runs:
   * `'skip'` drops the call silently (default), `{ warn }` drops it and logs
   * the message at `warn` level, `'allow'` lets passes overlap.
   */
  overlap?: 'skip' | 'allow' | { warn: string };
  /**
   * What a rejection of the startup pass does: `'fatal'` (default) aborts the
   * worker with exit code 1, `'log'` logs `failureMessage` and carries on.
   */
  firstRunFailure?: 'fatal' | 'log';
}

/** What {@link WorkerSpec.setup} returns. */
export interface WorkerPlan {
  /** Passes to run once at startup, in order, then repeat on their intervals. */
  ticks: TickJob[];
  /** Payload of the `<name>.started` diag event; defaults to `{ pid }`. */
  startedPayload?: Record<string, unknown>;
  /** Runs after the started event and before the first pass, e.g. a one-shot backfill. */
  beforeFirstTick?: () => Promise<void>;
}

export interface WorkerSpec<
  P extends PostgresSpec | undefined = undefined,
  R extends RedisSpec | undefined = undefined,
> {
  /**
   * The worker name without the `worker-` prefix. It becomes the heartbeat key
   * `worker:heartbeat:<name>`, the diag component `worker-<name>` and, with
   * dashes turned into underscores, the diag kind prefix (`role_expirer.started`).
   */
  name: string;
  /** The module-level logger from `createWorkerLog`, shared with the worker's own code. */
  log: Logger;
  /** The worker's `import.meta.url`; {@link runWorker} only starts when it is the entry script. */
  entrypoint: string;
  postgres?: P;
  redis?: R;
  /** Heartbeat status text, or a function evaluated on every beat; defaults to `'running'`. */
  heartbeatStatus?: string | (() => string);
  /** Emit `<name>.started` and `<name>.stopped` diag events; defaults to `true`. */
  lifecycleDiag?: boolean;
  /**
   * Builds the worker's passes from the opened resources. Runs synchronously,
   * before the shutdown handlers exist: keep slow work in
   * {@link WorkerPlan.beforeFirstTick}, where a signal is remembered rather
   * than killing the process.
   */
  setup: (ctx: WorkerContext<P, R>) => WorkerPlan;
}

/**
 * Process-level collaborators of {@link startWorker}, replaceable in tests.
 */
export interface WorkerRuntime {
  env: NodeJS.ProcessEnv;
  /** Ends the process; must not return in production. */
  exit: (code: number) => void;
  createRedis: (url: string, log: Logger) => Redis;
  createPostgres: (url: string, options: PostgresOptions) => postgres.Sql;
  createDatabase: (sql: postgres.Sql) => DatabaseClient;
  signalTarget?: ShutdownSignalTarget;
}

const defaultRuntime: WorkerRuntime = {
  env: process.env,
  exit: (code) => process.exit(code),
  createRedis: (url, log) => {
    const redis = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
    });
    redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
    redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));
    return redis;
  },
  createPostgres: (url, options) => postgres(url, options),
  createDatabase: (sql) => drizzle(sql, { schema }) as DatabaseClient,
};

/**
 * Starts a worker when its module is the entry script, and does nothing when
 * the module is merely imported (by a test, for its exports).
 *
 * A startup failure is logged as `fatal` and exits with code 1.
 *
 * @param spec - The worker definition; see {@link WorkerSpec}.
 */
export function runWorker<
  const P extends PostgresSpec | undefined = undefined,
  const R extends RedisSpec | undefined = undefined,
>(spec: WorkerSpec<P, R>): void {
  if (!isMainEntrypoint(spec.entrypoint)) return;
  startWorker(spec).catch((err) => {
    spec.log.fatal({ err: (err as Error).message }, 'fatal');
    defaultRuntime.exit(1);
  });
}

/**
 * Opens the worker's resources, then runs its lifecycle:
 *
 * 1. connect Postgres, then Redis; a missing required URL is logged as
 *    `fatal` (`<VAR> is required`) and exits with code 1;
 * 2. start the heartbeat and create the diag emitter;
 * 3. call `spec.setup`;
 * 4. install the SIGINT/SIGTERM handlers, which clear the intervals, emit
 *    `<name>.stopped`, stop the heartbeat, close Postgres and quit Redis;
 * 5. emit `<name>.started`, run `beforeFirstTick`, run every pass once in
 *    order, and mark the worker ready (a signal received up to here runs the
 *    shutdown now and the intervals are never armed);
 * 6. arm one interval per pass.
 *
 * Exported for tests and for workers that supply their own entry check; use
 * {@link runWorker} in worker entry files.
 *
 * @param spec - The worker definition.
 * @param runtime - Overrides for the process-level collaborators.
 * @throws Whatever `spec.setup`, a diag emit or a startup pass with
 *   `firstRunFailure: 'fatal'` throws, and an `Error` after `runtime.exit` has
 *   been asked to end the process over a missing environment variable.
 */
export async function startWorker<
  const P extends PostgresSpec | undefined = undefined,
  const R extends RedisSpec | undefined = undefined,
>(spec: WorkerSpec<P, R>, runtime: Partial<WorkerRuntime> = {}): Promise<void> {
  const rt: WorkerRuntime = { ...defaultRuntime, ...runtime };
  const { log, name } = spec;
  const component = `worker-${name}`;
  const kindPrefix = name.replaceAll('-', '_');
  const lifecycleDiag = spec.lifecycleDiag ?? true;

  const failMissing = (variable: string): never => {
    log.fatal(`${variable} is required`);
    rt.exit(1);
    throw new Error(`${variable} is required`);
  };

  let sql: postgres.Sql | null = null;
  if (spec.postgres) {
    const url = rt.env.DATABASE_URL;
    if (url) sql = rt.createPostgres(url, spec.postgres.options ?? DEFAULT_POSTGRES_OPTIONS);
    else if (!spec.postgres.optional) failMissing('DATABASE_URL');
  }
  const db = sql && spec.postgres?.drizzle ? rt.createDatabase(sql) : null;

  let redis: Redis | null = null;
  const redisUrl = rt.env.REDIS_URL;
  if (redisUrl) redis = rt.createRedis(redisUrl, log);
  else if (!spec.redis?.optional) failMissing('REDIS_URL');

  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name,
        statusFn: () =>
          typeof spec.heartbeatStatus === 'function'
            ? spec.heartbeatStatus()
            : (spec.heartbeatStatus ?? 'running'),
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};
  const diag: Diag = redis ? createDiag({ redis, log }) : { async emit() {} };

  // The conditional context types follow `spec.postgres` / `spec.redis`, which
  // the compiler cannot narrow from these runtime values.
  const plan = spec.setup({ name, log, diag, sql, db, redis } as unknown as WorkerContext<P, R>);

  const timers: NodeJS.Timeout[] = [];
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      for (const timer of timers) clearInterval(timer);
      if (lifecycleDiag) {
        await diag.emit({
          component,
          kind: `${kindPrefix}.stopped`,
          severity: 'info',
          message: `${name} received ${sig}`,
          payload: { sig },
        });
      }
      stopHeartbeat();
      await sql?.end({ timeout: POSTGRES_END_TIMEOUT_SECONDS });
      await redis?.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
    exit: rt.exit,
    signalTarget: rt.signalTarget,
  });

  if (lifecycleDiag) {
    await diag.emit({
      component,
      kind: `${kindPrefix}.started`,
      severity: 'info',
      message: `${name} started`,
      payload: plan.startedPayload ?? { pid: process.pid },
    });
  }
  await plan.beforeFirstTick?.();

  const passes = plan.ticks.map((job) => {
    const overlap = job.overlap ?? 'skip';
    const run =
      overlap === 'allow'
        ? job.run
        : guardAgainstOverlap(
            job.run,
            typeof overlap === 'object' ? () => log.warn(overlap.warn) : undefined,
          );
    return { job, run };
  });

  for (const { job, run } of passes) {
    if (job.firstRunFailure === 'log') {
      await run().catch((err) => log.error({ err: (err as Error).message }, job.failureMessage));
    } else {
      await run();
    }
  }
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;

  for (const { job, run } of passes) {
    timers.push(
      setInterval(() => {
        run().catch((err) => log.error({ err: (err as Error).message }, job.failureMessage));
      }, job.intervalMs),
    );
  }
}
