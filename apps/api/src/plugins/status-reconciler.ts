import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { servers } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import fp from 'fastify-plugin';
import type Redis from 'ioredis';
import type { LiveBus } from './live-bus.js';

/**
 * Periodically reconciles `servers.status` against what Docker actually
 * reports via container_inspect. Needed because:
 *
 *   - POST /start sets status='starting' but nothing updates it to 'running'
 *     once Squad finishes booting inside the container.
 *   - POST /stop sets status='stopping' but nothing updates it to 'stopped'.
 *   - Docker's `--restart unless-stopped` can resurrect a crashed container
 *     without the panel ever seeing it; status would otherwise go stale.
 *
 * Robustness invariants the production incident "сервер завис в Остановка"
 * forced into the design:
 *   - Bridge errors must NOT permanently mask a container's real state. We
 *     count consecutive failures per server and escalate the log line so a
 *     wedged reconciler is visible in journald.
 *   - Transient states older than `STUCK_AFTER_MS` are surfaced in
 *     `/api/v1/health/reconciler` so ops can trigger a manual reconcile.
 *   - The first tick fires on ready, not after `INTERVAL_MS`, so a freshly
 *     restarted API can resolve stuck rows immediately.
 */
export const RECONCILE_INTERVAL_MS = 4_000;
export const STUCK_AFTER_MS = 90_000;
export const TICK_BUDGET_MS = 12_000;
export const STALE_INSTALL_AFTER_MS = 30 * 60_000;

// Rows in these statuses are owned by docker — the reconciler reads
// container_inspect and writes back the docker-derived state. `installing`
// and `failed` are owned by other components (install-progress, operator)
// and are deliberately NOT in this set: a no-op container would otherwise
// flip a fresh `installing` row to `stopped` and mask a failed install.
export const TRANSIENT_STATES = new Set(['starting', 'stopping', 'running', 'stopped', 'ready']);

// Statuses the stuck-server health endpoint flags when older than
// STUCK_AFTER_MS. `installing` is special-cased here because the watchdog
// (separate code path) flips it to `failed` after STALE_INSTALL_AFTER_MS,
// but ops still want visibility on rows installing for >90s.
export const STUCK_CANDIDATE_STATES = new Set(['starting', 'stopping', 'installing']);

export type DockerStateLabel =
  | 'running'
  | 'created'
  | 'restarting'
  | 'paused'
  | 'removing'
  | 'exited'
  | 'dead'
  | 'not_found';

export function mapState(
  dockerState: string,
  running: boolean,
): { status: string | null; known: boolean } {
  if (running) return { status: 'running', known: true };
  const s = dockerState.trim().toLowerCase();
  switch (s) {
    case 'running':
      return { status: 'running', known: true };
    case 'restarting':
    case 'created':
      return { status: 'starting', known: true };
    case 'removing':
    case 'paused':
      return { status: 'stopping', known: true };
    case 'exited':
    case 'dead':
    case 'not_found':
      return { status: 'stopped', known: true };
    default:
      return { status: null, known: false };
  }
}

export interface ReconcilerStats {
  last_tick_at: string | null;
  last_tick_duration_ms: number | null;
  last_tick_servers_inspected: number;
  last_tick_budget_exceeded: boolean;
  consecutive_tick_errors: number;
  servers_in_transient: number;
  stuck_servers: Array<{ id: string; status: string; updated_at: string; age_ms: number }>;
  stale_installs_failed: number;
  bridge_failures_by_server: Record<string, number>;
}

export type ReconcileOnce = (serverId: string) => Promise<{
  inspected_state: string;
  inspected_running: boolean;
  previous_status: string;
  new_status: string;
  changed: boolean;
} | null>;

declare module 'fastify' {
  interface FastifyInstance {
    statusReconciler: {
      stats: () => Promise<ReconcilerStats>;
      reconcileOnce: ReconcileOnce;
      tickNow: () => Promise<void>;
    };
  }
}

interface TickDeps {
  db: DatabaseClient;
  bridge: Pick<BridgeClient, 'containerInspect'>;
  liveBus?: LiveBus;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  redis: Pick<Redis, 'get'>;
  diag: Pick<Diag, 'emit'>;
  bridgeFailures: Map<string, number>;
  state: {
    lastTickAt: number | null;
    lastTickDurationMs: number | null;
    lastInspected: number;
    lastBudgetExceeded: boolean;
    staleInstallsFailed: number;
  };
}

async function reconcileServer(deps: TickDeps, row: { id: string; status: string }): Promise<void> {
  const { db, bridge, liveBus, log, bridgeFailures } = deps;
  let res: Awaited<ReturnType<BridgeClient['containerInspect']>>;
  try {
    res = await bridge.containerInspect({ name: `squad-${row.id}` });
    bridgeFailures.delete(row.id);
  } catch (err) {
    const next = (bridgeFailures.get(row.id) ?? 0) + 1;
    bridgeFailures.set(row.id, next);
    const message = (err as Error).message;
    if (next === 1) {
      log.debug({ err: message, serverId: row.id }, 'reconciler: inspect failed');
    } else if (next === 5 || next === 30 || next % 60 === 0) {
      log.warn(
        { err: message, serverId: row.id, consecutiveFailures: next },
        'reconciler: inspect persistently failing',
      );
    }
    return;
  }
  const mapped = mapState(res.state, res.running);
  if (!mapped.known) {
    log.warn(
      { serverId: row.id, raw: res.state, running: res.running },
      'reconciler: unknown docker state — leaving DB status untouched',
    );
    return;
  }
  if (!mapped.status || mapped.status === row.status) return;
  await db
    .update(servers)
    .set({
      status: mapped.status,
      updatedAt: new Date(),
      containerId: res.pid ? String(res.pid) : null,
    })
    .where(eq(servers.id, row.id));
  log.info(
    {
      serverId: row.id,
      from: row.status,
      to: mapped.status,
      raw: res.state,
      running: res.running,
    },
    'reconciler: status updated',
  );
  liveBus?.publish({
    type: 'server.status',
    ts: new Date().toISOString(),
    data: { server_id: row.id, status: mapped.status, source: 'reconciler' },
  });
  if (row.status === 'running' && mapped.status === 'stopped') {
    await emitContainerExitDiag(deps, row.id, res);
  }
}

async function emitContainerExitDiag(
  deps: TickDeps,
  serverId: string,
  res: Awaited<ReturnType<BridgeClient['containerInspect']>>,
): Promise<void> {
  const { redis, diag, log } = deps;
  let wasRequested = false;
  try {
    wasRequested = (await redis.get(`stop:requested:${serverId}`)) !== null;
  } catch (err) {
    log.warn(
      { err: (err as Error).message, serverId },
      'reconciler: failed to read stop fence; treating exit as unexpected',
    );
  }
  const exitCode = res.exit_code ?? -1;
  const oomKilled = !!res.oom_killed;
  const errorString = res.error ?? '';
  const signal = errorString === '' ? null : errorString;
  await diag.emit({
    component: 'reconciler',
    kind: wasRequested ? 'container.exited' : 'container.unexpected_exit',
    severity: exitCode === 0 ? 'info' : 'error',
    serverId,
    message: `container exited (code=${exitCode}${oomKilled ? ', oom' : ''})`,
    payload: {
      exit_code: exitCode,
      oom_killed: oomKilled,
      signal,
      finished_at: res.finished_at || null,
      started_at: res.started_at || null,
    },
  });
  if (wasRequested) {
    await diag.emit({
      component: 'reconciler',
      kind: 'server.stop.reconciler_confirmed',
      severity: 'info',
      serverId,
      message: 'stop request confirmed by reconciler',
      payload: { exit_code: exitCode },
    });
  }
}

export default fp(async (app) => {
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let consecutiveTickErrors = 0;
  const bridgeFailures = new Map<string, number>();
  const tickState: TickDeps['state'] = {
    lastTickAt: null,
    lastTickDurationMs: null,
    lastInspected: 0,
    lastBudgetExceeded: false,
    staleInstallsFailed: 0,
  };

  function deps(): TickDeps {
    return {
      db: app.db,
      bridge: app.bridge,
      liveBus: app.liveBus,
      log: app.log,
      redis: app.redis,
      diag: app.diag,
      bridgeFailures,
      state: tickState,
    };
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    const t0 = Date.now();
    try {
      const rows = await app.db
        .select({ id: servers.id, status: servers.status })
        .from(servers)
        .where(
          and(inArray(servers.status, Array.from(TRANSIENT_STATES)), isNull(servers.deletedAt)),
        );
      tickState.lastInspected = rows.length;
      // Trim per-server bridge-failure counters for rows that are no longer
      // in a transient state (dropped from the loop) — otherwise the map
      // grows unbounded across the API process lifetime.
      const transientIds = new Set(rows.map((r) => r.id));
      for (const id of bridgeFailures.keys()) {
        if (!transientIds.has(id)) bridgeFailures.delete(id);
      }
      // Per-server inspect runs in parallel under a single tick budget.
      // Each individual containerInspect already has a 10 s timeout in
      // the BridgeClient; this enforces an upper bound on the tick as a
      // whole so a few hung calls don't push the next tick past a useful
      // SLA. The next interval will reschedule any unfinished servers.
      let budgetExceeded = false;
      const budget = new Promise<'budget'>((resolve) =>
        setTimeout(() => {
          budgetExceeded = true;
          resolve('budget');
        }, TICK_BUDGET_MS),
      );
      const work = Promise.allSettled(
        rows.map((row) =>
          reconcileServer(deps(), row).catch((err) => {
            app.log.warn(
              { err: (err as Error).message, serverId: row.id },
              'reconciler: per-server tick failed',
            );
          }),
        ),
      );
      await Promise.race([work, budget]);
      tickState.lastBudgetExceeded = budgetExceeded;
      if (budgetExceeded) {
        app.log.warn(
          { rows: rows.length, budgetMs: TICK_BUDGET_MS },
          'reconciler: tick budget exceeded — some servers will retry next tick',
        );
      }
      await failStaleInstalls();
      consecutiveTickErrors = 0;
    } catch (err) {
      consecutiveTickErrors++;
      app.log.error(
        { err: (err as Error).message, consecutiveTickErrors },
        'reconciler: tick failed',
      );
    } finally {
      tickState.lastTickAt = Date.now();
      tickState.lastTickDurationMs = Date.now() - t0;
      inFlight = false;
    }
  }

  // Install owners (apps/api/src/routes/server-install.ts) flip 'installing' →
  // 'running'/'failed' inside their own pipeline. If the API process dies
  // mid-install — or the WebSocket caller disconnects without the pipeline
  // catching the exit — the row is stuck on 'installing' forever.
  // The watchdog flips long-stale 'installing' rows to 'failed' so the UI
  // doesn't lie. The threshold is generous (30 min) because depot_update
  // alone takes ~25 min on first install.
  async function failStaleInstalls() {
    const cutoff = new Date(Date.now() - STALE_INSTALL_AFTER_MS);
    const stale = await app.db
      .select({ id: servers.id, updatedAt: servers.updatedAt })
      .from(servers)
      .where(and(eq(servers.status, 'installing'), isNull(servers.deletedAt)));
    for (const row of stale) {
      const updatedAt = row.updatedAt ?? new Date();
      if (new Date(updatedAt).getTime() > cutoff.getTime()) continue;
      await app.db
        .update(servers)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(servers.id, row.id));
      tickState.staleInstallsFailed++;
      app.log.warn(
        { serverId: row.id, ageMs: Date.now() - new Date(updatedAt).getTime() },
        "reconciler: stale install flipped 'installing' → 'failed'",
      );
      app.liveBus?.publish({
        type: 'server.status',
        ts: new Date().toISOString(),
        data: { server_id: row.id, status: 'failed', source: 'reconciler' },
      });
    }
  }

  async function reconcileOnce(serverId: string) {
    const row = await app.db.query.servers.findFirst({
      where: and(eq(servers.id, serverId), isNull(servers.deletedAt)),
      columns: { id: true, status: true },
    });
    if (!row) return null;
    let inspected: Awaited<ReturnType<BridgeClient['containerInspect']>>;
    try {
      inspected = await app.bridge.containerInspect({ name: `squad-${serverId}` });
      bridgeFailures.delete(serverId);
    } catch (err) {
      const next = (bridgeFailures.get(serverId) ?? 0) + 1;
      bridgeFailures.set(serverId, next);
      throw err;
    }
    const mapped = mapState(inspected.state, inspected.running);
    if (!mapped.known || !mapped.status) {
      return {
        inspected_state: inspected.state,
        inspected_running: inspected.running,
        previous_status: row.status,
        new_status: row.status,
        changed: false,
      };
    }
    const changed = mapped.status !== row.status;
    if (changed) {
      await app.db
        .update(servers)
        .set({
          status: mapped.status,
          updatedAt: new Date(),
          containerId: inspected.pid ? String(inspected.pid) : null,
        })
        .where(eq(servers.id, serverId));
      app.liveBus?.publish({
        type: 'server.status',
        ts: new Date().toISOString(),
        data: { server_id: serverId, status: mapped.status, source: 'reconciler' },
      });
      if (row.status === 'running' && mapped.status === 'stopped') {
        await emitContainerExitDiag(deps(), serverId, inspected);
      }
    }
    return {
      inspected_state: inspected.state,
      inspected_running: inspected.running,
      previous_status: row.status,
      new_status: mapped.status,
      changed,
    };
  }

  async function stats(): Promise<ReconcilerStats> {
    const candidates = await app.db
      .select({
        id: servers.id,
        status: servers.status,
        updatedAt: servers.updatedAt,
      })
      .from(servers)
      .where(
        and(inArray(servers.status, Array.from(STUCK_CANDIDATE_STATES)), isNull(servers.deletedAt)),
      );
    const now = Date.now();
    const stuck = candidates
      .map((c) => {
        const updatedAt = c.updatedAt ?? new Date();
        const age = now - new Date(updatedAt).getTime();
        return {
          id: c.id,
          status: c.status,
          updated_at: new Date(updatedAt).toISOString(),
          age_ms: age,
        };
      })
      .filter((c) => c.age_ms >= STUCK_AFTER_MS)
      .sort((a, b) => b.age_ms - a.age_ms);
    return {
      last_tick_at: tickState.lastTickAt ? new Date(tickState.lastTickAt).toISOString() : null,
      last_tick_duration_ms: tickState.lastTickDurationMs,
      last_tick_servers_inspected: tickState.lastInspected,
      last_tick_budget_exceeded: tickState.lastBudgetExceeded,
      consecutive_tick_errors: consecutiveTickErrors,
      servers_in_transient: tickState.lastInspected,
      stuck_servers: stuck,
      stale_installs_failed: tickState.staleInstallsFailed,
      bridge_failures_by_server: Object.fromEntries(bridgeFailures),
    };
  }

  app.decorate('statusReconciler', {
    stats,
    reconcileOnce,
    tickNow: tick,
  });

  app.addHook('onReady', async () => {
    // Surface the boot-time state so an api restart immediately tells
    // operations how many rows the reconciler is about to converge.
    const transientCount = await app.db
      .select({ id: servers.id })
      .from(servers)
      .where(and(inArray(servers.status, Array.from(TRANSIENT_STATES)), isNull(servers.deletedAt)));
    app.log.info(
      { rows: transientCount.length, intervalMs: RECONCILE_INTERVAL_MS },
      'reconciler: ready — running initial recovery tick',
    );
    // Run an immediate tick so a fresh process resolves any rows already in
    // a transient state at boot, then schedule the recurring loop.
    void tick().catch((err) =>
      app.log.error({ err: (err as Error).message }, 'reconciler: initial tick'),
    );
    timer = setInterval(() => {
      void tick().catch((err) =>
        app.log.error({ err: (err as Error).message }, 'reconciler: tick'),
      );
    }, RECONCILE_INTERVAL_MS);
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
});
