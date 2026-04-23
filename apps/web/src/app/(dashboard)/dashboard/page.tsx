'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SystemStatus } from '@/components/SystemStatus';

interface BridgeStatus {
  connected: boolean;
  version?: string | null;
  hostname?: string | null;
  round_trip_ms?: number;
  error?: string;
}

interface HostInfo {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel: string;
  arch: string;
  cpu_model: string;
  cpu_cores: number;
  ram_total_bytes: number;
}

interface HostMetrics {
  cpu_percent: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  net_rx_bytes_per_sec: number;
  net_tx_bytes_per_sec: number;
  sampled_at: string;
}

interface ServerRow {
  id: string;
  display_name: string;
  slug: string;
  status: string;
  player_count: number | null;
  rcon_state: string | null;
}

interface AuditRow {
  id: string;
  created_at: string;
  actor_kind: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
}

const POLL_MS = 4000;

export default function DashboardPage() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [recent, setRecent] = useState<AuditRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const results = await Promise.allSettled([
        fetchJson<BridgeStatus>('/api/v1/host/bridge-status'),
        fetchJson<HostInfo>('/api/v1/host/info'),
        fetchJson<HostMetrics>('/api/v1/host/metrics'),
        fetchJson<{ items: ServerRow[] }>('/api/v1/servers'),
        fetchJson<{ items: AuditRow[] }>('/api/v1/audit?page_size=10'),
      ]);
      if (cancelled) return;
      if (results[0].status === 'fulfilled') setBridge(results[0].value);
      else setBridge({ connected: false, error: (results[0].reason as Error).message });
      if (results[1].status === 'fulfilled') setInfo(results[1].value);
      if (results[2].status === 'fulfilled') setMetrics(results[2].value);
      if (results[3].status === 'fulfilled') setServers(results[3].value.items);
      if (results[4].status === 'fulfilled') setRecent(results[4].value.items);
    }
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const runningCount = servers.filter((s) => s.status === 'running').length;
  const playersOnline = servers.reduce((acc, s) => acc + (s.player_count ?? 0), 0);
  const alerts: string[] = [];
  if (bridge && !bridge.connected) alerts.push(`bridge: ${bridge.error ?? 'disconnected'}`);
  for (const s of servers) {
    if (s.status === 'failed') alerts.push(`${s.display_name}: failed`);
    if (s.status === 'running' && s.rcon_state && s.rcon_state !== 'connected') {
      alerts.push(`${s.display_name}: RCON ${s.rcon_state}`);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Дашборд</h1>

      {/* 4 stat cards — §1H Screen 3 */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Серверы"
          value={servers.length.toString()}
          hint={`${runningCount} running`}
          tone="sky"
        />
        <StatCard
          title="Игроков онлайн"
          value={playersOnline.toString()}
          hint={runningCount === 0 ? 'сервера не запущены' : `на ${runningCount} серверах`}
          tone="emerald"
        />
        <StatCard
          title="Bridge"
          value={bridge?.connected ? 'connected' : 'offline'}
          hint={bridge?.version ? `v ${bridge.version}` : (bridge?.error ?? '—')}
          tone={bridge?.connected ? 'emerald' : 'red'}
        />
        <StatCard
          title="Alerts"
          value={alerts.length.toString()}
          hint={alerts[0] ?? 'всё чисто'}
          tone={alerts.length ? 'amber' : 'neutral'}
        />
      </section>

      {/* Live system status — every connector with its own dot */}
      <SystemStatus />

      {/* Host info */}
      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Хост</h2>
          {info ? (
            <span className="text-xs font-mono text-neutral-500">{info.hostname}</span>
          ) : null}
        </div>
        {info && metrics ? (
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Cell label="OS" value={`${info.os_name} ${info.os_version}`} />
            <Cell label="Kernel" value={info.kernel} mono />
            <Cell label="Arch" value={info.arch} mono />
            <Cell label="CPU" value={`${info.cpu_model} × ${info.cpu_cores}`} />
            <Cell label="CPU %" value={`${metrics.cpu_percent.toFixed(1)}%`} />
            <Cell
              label="RAM"
              value={`${fmtBytes(metrics.ram_used_bytes)} / ${fmtBytes(metrics.ram_total_bytes)} (${pct(metrics.ram_used_bytes, metrics.ram_total_bytes)})`}
            />
            <Cell
              label="Disk"
              value={`${fmtBytes(metrics.disk_used_bytes)} / ${fmtBytes(metrics.disk_total_bytes)} (${pct(metrics.disk_used_bytes, metrics.disk_total_bytes)})`}
            />
            <Cell label="Net rx" value={`${fmtBytes(metrics.net_rx_bytes_per_sec)}/s`} />
            <Cell label="Net tx" value={`${fmtBytes(metrics.net_tx_bytes_per_sec)}/s`} />
          </div>
        ) : (
          <div className="text-neutral-500 text-sm">Загрузка данных хоста…</div>
        )}
      </section>

      {/* Quick server cards */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Серверы</h2>
          <Link href="/servers" className="text-xs text-sky-400 hover:text-sky-300">
            все →
          </Link>
        </div>
        {servers.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-4 text-center text-neutral-500 text-sm">
            Нет серверов.{' '}
            <Link href="/servers/new" className="text-sky-400 hover:text-sky-300">
              Установить
            </Link>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {servers.map((s) => (
              <Link
                key={s.id}
                href={`/servers/${s.id}`}
                className="rounded border border-neutral-800 bg-neutral-950 p-3 space-y-1 hover:border-sky-800"
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm">{s.display_name}</div>
                  <StatusPill status={s.status} />
                </div>
                <div className="text-xs text-neutral-500 font-mono">{s.slug}</div>
                <div className="flex items-center gap-3 text-xs pt-1">
                  <span
                    className={
                      s.rcon_state === 'connected' ? 'text-emerald-400' : 'text-neutral-500'
                    }
                  >
                    rcon: {s.rcon_state ?? '—'}
                  </span>
                  <span className="text-neutral-400">
                    {s.player_count ?? '—'} {s.player_count === 1 ? 'player' : 'players'}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent events (last 10 audit rows) */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Последние действия</h2>
          <Link href="/audit" className="text-xs text-sky-400 hover:text-sky-300">
            журнал →
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-center text-neutral-500 text-sm">
            Пока пусто.
          </div>
        ) : (
          <ul className="rounded border border-neutral-800 bg-neutral-950 divide-y divide-neutral-900">
            {recent.map((ev) => (
              <li key={ev.id} className="flex items-center gap-3 p-2 text-xs">
                <span className="text-neutral-500 w-32 font-mono">
                  {new Date(ev.created_at).toLocaleTimeString()}
                </span>
                <span className="font-mono">{ev.action_type}</span>
                <span className="text-neutral-500">
                  {ev.target_type ?? ''}
                  {ev.target_id ? ` • ${ev.target_id.slice(0, 12)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function pct(used: number, total: number): string {
  if (!total) return '—';
  return `${((used / total) * 100).toFixed(0)}%`;
}

function StatCard({
  title,
  value,
  hint,
  tone,
}: {
  title: string;
  value: string;
  hint?: string;
  tone: 'sky' | 'emerald' | 'amber' | 'red' | 'neutral';
}) {
  const tones: Record<string, string> = {
    sky: 'border-sky-900/50',
    emerald: 'border-emerald-900/50',
    amber: 'border-amber-900/50',
    red: 'border-red-900/50',
    neutral: 'border-neutral-800',
  };
  return (
    <div className={`rounded border ${tones[tone]} bg-neutral-950 p-4`}>
      <div className="text-xs uppercase tracking-widest text-neutral-500">{title}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {hint ? <div className="text-xs text-neutral-500 mt-1">{hint}</div> : null}
    </div>
  );
}

function Cell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-neutral-500 text-xs uppercase tracking-widest w-16">{label}</span>
      <span className={mono ? 'font-mono text-xs' : 'text-sm'}>{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tones: Record<string, string> = {
    running: 'bg-emerald-900/40 text-emerald-300',
    starting: 'bg-amber-900/40 text-amber-300',
    stopping: 'bg-amber-900/40 text-amber-300',
    installing: 'bg-amber-900/40 text-amber-300',
    ready: 'bg-sky-900/40 text-sky-300',
    stopped: 'bg-neutral-800 text-neutral-300',
    failed: 'bg-red-900/40 text-red-300',
    pending: 'bg-neutral-800 text-neutral-300',
  };
  return (
    <span
      className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-widest font-mono ${tones[status] ?? 'bg-neutral-800'}`}
    >
      {status}
    </span>
  );
}
