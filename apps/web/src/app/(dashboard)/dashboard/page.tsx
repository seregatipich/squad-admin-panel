'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RestartBridgeButton } from '@/components/RestartBridgeButton';
import { SystemStatus } from '@/components/SystemStatus';
import {
  formatBytes,
  formatBytesPerSec,
  formatPercent,
  formatRelativeTime,
  formatUptime,
  ratio,
} from '@/lib/format';
import { computeHostHealth, type HealthLevel, thresholdTone } from '@/lib/host-health';

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
  uptime_seconds: number;
  docker_version: string;
  ip_addresses: string[];
}

interface HostMetrics {
  cpu_percent: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  net_rx_bytes_per_sec: number;
  net_tx_bytes_per_sec: number;
  load_avg_1m: number;
  load_avg_5m: number;
  load_avg_15m: number;
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

const HEALTH_LABEL: Record<HealthLevel, string> = {
  healthy: 'Здоровый',
  warning: 'Предупреждение',
  critical: 'Критично',
};
const HEALTH_TONE: Record<HealthLevel, 'emerald' | 'amber' | 'red'> = {
  healthy: 'emerald',
  warning: 'amber',
  critical: 'red',
};

export default function DashboardPage() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [recent, setRecent] = useState<AuditRow[]>([]);
  const [now, setNow] = useState(() => new Date());

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
      setNow(new Date());
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

  const health = computeHostHealth(info, metrics, bridge);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Дашборд</h1>

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
          title="Состояние хоста"
          value={HEALTH_LABEL[health.level]}
          hint={health.reasons[0] ?? (bridge?.connected ? 'все метрики в норме' : 'bridge оффлайн')}
          tone={HEALTH_TONE[health.level]}
        />
        <StatCard
          title="Alerts"
          value={alerts.length.toString()}
          hint={alerts[0] ?? 'Тревог нет'}
          tone={alerts.length ? 'amber' : 'neutral'}
        />
      </section>

      <SystemStatus />

      <HostBlock bridge={bridge} info={info} metrics={metrics} health={health} now={now} />

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

function HostBlock({
  bridge,
  info,
  metrics,
  health,
  now,
}: {
  bridge: BridgeStatus | null;
  info: HostInfo | null;
  metrics: HostMetrics | null;
  health: ReturnType<typeof computeHostHealth>;
  now: Date;
}) {
  const isLoading = info === null || metrics === null;
  const bridgeConnected = bridge?.connected === true;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h2 className="truncate text-xl font-semibold text-neutral-100">
              {info?.hostname ?? <span className="text-neutral-500">Хост</span>}
            </h2>
            <HealthPill level={health.level} />
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-neutral-400">
            {info ? (
              <>
                <span>
                  {info.os_name} {info.os_version}
                </span>
                <span className="font-mono">{info.arch}</span>
                <span>аптайм {formatUptime(info.uptime_seconds)}</span>
              </>
            ) : (
              <span className="italic text-neutral-500">загрузка…</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 text-xs text-neutral-400">
          <div className="flex items-center gap-3">
            <span>
              Bridge:{' '}
              {bridgeConnected ? (
                <span className="text-emerald-400">
                  connected{bridge?.version ? ` (v${bridge.version})` : ''}
                </span>
              ) : (
                <span className="text-red-400">недоступен</span>
              )}
            </span>
            <RestartBridgeButton
              disabled={!bridgeConnected}
              disabledReason="Сначала восстановите соединение."
            />
          </div>
          <span>
            Обновлено{' '}
            <span className="font-mono">
              {metrics?.sampled_at ? formatRelativeTime(metrics.sampled_at, now) : '—'}
            </span>
          </span>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <CpuCard info={info} metrics={metrics} />
            <RamCard metrics={metrics} />
            <DiskCard metrics={metrics} />
            <NetworkCard metrics={metrics} />
          </>
        )}
      </div>

      <SystemRow info={info} metrics={metrics} />
    </section>
  );
}

function HealthPill({ level }: { level: HealthLevel }) {
  const tones: Record<HealthLevel, string> = {
    healthy: 'border-emerald-700/60 bg-emerald-900/30 text-emerald-300',
    warning: 'border-amber-700/60 bg-amber-900/30 text-amber-300',
    critical: 'border-red-700/60 bg-red-900/30 text-red-300',
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-widest ${tones[level]}`}
    >
      {HEALTH_LABEL[level]}
    </span>
  );
}

function CpuCard({ info, metrics }: { info: HostInfo; metrics: HostMetrics }) {
  const pct = Math.max(0, Math.min(100, metrics.cpu_percent));
  const tone = thresholdTone(pct / 100, 0.8, 0.95);
  const cpuLabel = info.cpu_model && info.cpu_model !== 'unknown' ? info.cpu_model : null;
  return (
    <ResourceCard
      title="Процессор"
      mainValue={`${metrics.cpu_percent.toFixed(1)}%`}
      sub={
        cpuLabel ? (
          <span className="truncate" title={cpuLabel}>
            {cpuLabel} • {info.cpu_cores} ядер
          </span>
        ) : (
          <span className="italic text-neutral-500">неизвестно • {info.cpu_cores} ядер</span>
        )
      }
      progressPct={pct}
      progressTone={tone}
    />
  );
}

function RamCard({ metrics }: { metrics: HostMetrics }) {
  const total = metrics.ram_total_bytes;
  if (total <= 0) {
    return (
      <ResourceCard
        title="Память"
        mainValue="—"
        sub={<span className="italic text-neutral-500">данных нет</span>}
      />
    );
  }
  const r = ratio(metrics.ram_used_bytes, total);
  const tone = thresholdTone(r, 0.7, 0.85);
  return (
    <ResourceCard
      title="Память"
      mainValue={formatPercent(metrics.ram_used_bytes, total)}
      sub={
        <span>
          {formatBytes(metrics.ram_used_bytes)} / {formatBytes(total)}
        </span>
      }
      progressPct={r * 100}
      progressTone={tone}
    />
  );
}

function DiskCard({ metrics }: { metrics: HostMetrics }) {
  const total = metrics.disk_total_bytes;
  if (total <= 0) {
    return (
      <ResourceCard
        title="Диск"
        mainValue="—"
        sub={<span className="italic text-neutral-500">данных нет</span>}
      />
    );
  }
  const r = ratio(metrics.disk_used_bytes, total);
  const tone = thresholdTone(r, 0.75, 0.9);
  return (
    <ResourceCard
      title="Диск"
      mainValue={formatPercent(metrics.disk_used_bytes, total)}
      sub={
        <span>
          {formatBytes(metrics.disk_used_bytes)} / {formatBytes(total)}
        </span>
      }
      progressPct={r * 100}
      progressTone={tone}
    />
  );
}

function NetworkCard({ metrics }: { metrics: HostMetrics }) {
  return (
    <ResourceCard
      title="Сеть"
      mainValue={formatBytesPerSec(metrics.net_rx_bytes_per_sec)}
      mainLabel="RX"
      sub={
        <span>
          TX <span className="font-mono">{formatBytesPerSec(metrics.net_tx_bytes_per_sec)}</span>
        </span>
      }
    />
  );
}

function ResourceCard({
  title,
  mainValue,
  mainLabel,
  sub,
  progressPct,
  progressTone,
}: {
  title: string;
  mainValue: string;
  mainLabel?: string;
  sub: React.ReactNode;
  progressPct?: number;
  progressTone?: 'emerald' | 'amber' | 'red';
}) {
  const fill: Record<string, string> = {
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-widest text-neutral-500">{title}</span>
        {mainLabel ? (
          <span className="text-[10px] uppercase tracking-widest text-neutral-500">
            {mainLabel}
          </span>
        ) : null}
      </div>
      <div className="text-2xl font-semibold tabular-nums text-neutral-100">{mainValue}</div>
      <div className="text-xs text-neutral-400 truncate">{sub}</div>
      {progressPct !== undefined && progressTone ? (
        <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-2 rounded-full ${fill[progressTone]}`}
            style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-3 animate-pulse">
      <div className="h-3 w-20 rounded bg-zinc-800" />
      <div className="h-7 w-24 rounded bg-zinc-800" />
      <div className="h-3 w-32 rounded bg-zinc-800" />
      <div className="h-2 rounded-full bg-zinc-800" />
    </div>
  );
}

function SystemRow({ info, metrics }: { info: HostInfo | null; metrics: HostMetrics | null }) {
  const ip = info && info.ip_addresses.length > 0 ? info.ip_addresses.join(', ') : '—';
  const docker = info && info.docker_version !== '' ? info.docker_version : '—';
  const kernel = info?.kernel ?? '—';
  const arch = info?.arch ?? '—';
  const load = metrics
    ? `${metrics.load_avg_1m.toFixed(2)} / ${metrics.load_avg_5m.toFixed(2)} / ${metrics.load_avg_15m.toFixed(2)}`
    : '—';

  return (
    <div className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <SystemCell label="Ядро" value={kernel} mono />
      <SystemCell label="Архитектура" value={arch} mono />
      <SystemCell label="Docker" value={docker} mono />
      <SystemCell label="IP" value={ip} mono />
      <SystemCell label="Средняя загрузка" value={load} mono />
    </div>
  );
}

function SystemCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const isMissing = value === '—';
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-neutral-500 uppercase tracking-widest text-[10px] shrink-0">
        {label}
      </span>
      <span
        className={`truncate ${mono ? 'font-mono' : ''} ${isMissing ? 'text-neutral-600' : 'text-neutral-200'}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
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
