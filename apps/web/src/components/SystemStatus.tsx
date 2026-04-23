'use client';
import { useEffect, useState } from 'react';

interface ReadyCheck {
  status: 'ok' | 'degraded';
  checks: Record<string, string>;
}

interface BridgeStatus {
  connected: boolean;
  version?: string | null;
  round_trip_ms?: number;
  error?: string;
}

interface Worker {
  name: string;
  ts: string;
  pid: number;
  started_at: string;
  age_ms: number;
  status?: string;
}

interface WorkersResponse {
  items: Worker[];
}

const POLL_MS = 2500;
const WORKER_STALE_MS = 15_000; // > 2x heartbeat interval
const WORKER_OK_MS = 10_000;

export function SystemStatus() {
  const [ready, setReady] = useState<ReadyCheck | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [r1, r2, r3] = await Promise.allSettled([
        fetch('/ready', { cache: 'no-store' }).then(async (r) => ({
          ok: r.ok,
          data: (await r.json()) as ReadyCheck,
        })),
        fetch('/api/v1/host/bridge-status', {
          credentials: 'include',
          cache: 'no-store',
        }).then((r) => r.json() as Promise<BridgeStatus>),
        fetch('/api/v1/health/workers', {
          credentials: 'include',
          cache: 'no-store',
        }).then((r) => r.json() as Promise<WorkersResponse>),
      ]);
      if (cancelled) return;
      if (r1.status === 'fulfilled') setReady(r1.value.data);
      if (r2.status === 'fulfilled') setBridge(r2.value);
      else setBridge({ connected: false, error: (r2.reason as Error).message });
      if (r3.status === 'fulfilled') setWorkers(r3.value.items);
    }
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const rows = buildRows(ready, bridge, workers);

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Соединения</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <Row key={row.name} row={row} />
        ))}
      </div>
    </section>
  );
}

interface StatusRow {
  name: string;
  label: string;
  state: 'ok' | 'degraded' | 'down' | 'unknown';
  detail?: string;
  subtle?: string;
}

function buildRows(
  ready: ReadyCheck | null,
  bridge: BridgeStatus | null,
  workers: Worker[],
): StatusRow[] {
  const rows: StatusRow[] = [];

  const pgState = ready?.checks.postgres;
  rows.push({
    name: 'postgres',
    label: 'PostgreSQL',
    state: pgState === 'ok' ? 'ok' : pgState ? 'down' : 'unknown',
    detail: pgState === 'ok' ? 'healthy' : (pgState ?? 'не проверено'),
  });

  const redisState = ready?.checks.redis;
  rows.push({
    name: 'redis',
    label: 'Redis',
    state: redisState === 'ok' ? 'ok' : redisState ? 'down' : 'unknown',
    detail: redisState === 'ok' ? 'healthy' : (redisState ?? 'не проверено'),
  });

  rows.push({
    name: 'bridge',
    label: 'panel-host-bridge',
    state: bridge?.connected ? 'ok' : 'down',
    detail: bridge?.connected
      ? `v${bridge.version ?? '?'} • RTT ${bridge.round_trip_ms ?? '?'} ms`
      : (bridge?.error ?? 'unknown'),
  });

  const expected = ['rcon', 'log-ingest', 'audit-archiver', 'event-partition'];
  const byName = new Map(workers.map((w) => [w.name, w]));
  for (const name of expected) {
    const w = byName.get(name);
    if (!w) {
      rows.push({
        name: `worker-${name}`,
        label: `worker-${name}`,
        state: 'down',
        detail: 'нет heartbeat',
      });
      continue;
    }
    const state = w.age_ms > WORKER_STALE_MS ? 'down' : w.age_ms > WORKER_OK_MS ? 'degraded' : 'ok';
    rows.push({
      name: `worker-${name}`,
      label: `worker-${name}`,
      state,
      detail: w.status ?? 'alive',
      subtle: `${Math.round(w.age_ms / 1000)}s ago • pid ${w.pid}`,
    });
  }

  return rows;
}

function Row({ row }: { row: StatusRow }) {
  const color =
    row.state === 'ok'
      ? 'bg-emerald-500'
      : row.state === 'degraded'
        ? 'bg-amber-500'
        : row.state === 'down'
          ? 'bg-red-500'
          : 'bg-neutral-600';
  return (
    <div className="flex items-start gap-2 rounded border border-neutral-900 bg-neutral-900/50 p-2">
      <span className={`mt-1 inline-block h-2.5 w-2.5 rounded-full shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{row.label}</div>
        <div className="text-xs text-neutral-400 truncate">{row.detail}</div>
        {row.subtle ? (
          <div className="text-[10px] font-mono text-neutral-500 truncate">{row.subtle}</div>
        ) : null}
      </div>
    </div>
  );
}
