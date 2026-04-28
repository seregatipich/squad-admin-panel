'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiskBreakdownModal } from '@/components/DiskBreakdownModal';
import { LiveIndicator } from '@/components/LiveIndicator';
import { MetricHistoryModal, type MetricKey } from '@/components/MetricHistoryModal';
import { RestartBridgeButton } from '@/components/RestartBridgeButton';
import { formatBytes, formatBytesPerSec, formatPercent, formatUptime, ratio } from '@/lib/format';
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
  last_poll_at: string | null;
}

interface AuditRow {
  id: string;
  created_at: string;
  actor_kind: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  status_code: number | null;
}

interface ReadyCheck {
  status: 'ok' | 'degraded';
  checks: Record<string, string>;
}

interface Worker {
  name: string;
  ts: string;
  pid: number;
  started_at: string;
  age_ms: number;
  status?: string;
}

interface DiskBreakdown {
  configs_bytes: number;
  saved_total_bytes: number;
  saved_per_server: { uuid: string; bytes: number }[];
  depot_volume_bytes: number;
  docker_volumes: { name: string; bytes: number }[];
  docker_images: { repository: string; tag: string; bytes: number }[];
  audit_archive_bytes: number;
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  computed_at: string;
  cache_age_seconds: number;
  panel_pct: number;
  other_pct: number;
}

const POLL_MS = 4000;
const WORKER_STALE_MS = 15_000;
const WORKER_OK_MS = 10_000;

const HEALTH_LABEL: Record<HealthLevel, string> = {
  healthy: 'Здоровый',
  warning: 'Предупреждение',
  critical: 'Критично',
};

type Tone = 'emerald' | 'amber' | 'red' | 'sky' | 'neutral';

const HEALTH_TONE: Record<HealthLevel, Tone> = {
  healthy: 'emerald',
  warning: 'amber',
  critical: 'red',
};

interface StatusStyle {
  label: string;
  tone: Tone;
}

const SERVER_STATUS: Record<string, StatusStyle> = {
  running: { label: 'Работает', tone: 'emerald' },
  starting: { label: 'Запускается', tone: 'amber' },
  stopping: { label: 'Остановка', tone: 'amber' },
  installing: { label: 'Установка', tone: 'amber' },
  ready: { label: 'Готов', tone: 'sky' },
  stopped: { label: 'Остановлен', tone: 'neutral' },
  pending: { label: 'Ожидает', tone: 'neutral' },
  failed: { label: 'Сбой', tone: 'red' },
};

const RCON_STATUS: Record<string, StatusStyle> = {
  connected: { label: 'Подключён', tone: 'emerald' },
  authenticating: { label: 'Аутентификация', tone: 'amber' },
  reconnecting: { label: 'Переподключение', tone: 'amber' },
  disconnected: { label: 'Отключён', tone: 'red' },
  failed: { label: 'Сбой', tone: 'red' },
  not_polled: { label: 'Не опрашивается', tone: 'neutral' },
};

const DOT: Record<Tone, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  sky: 'bg-sky-500',
  neutral: 'bg-neutral-600',
};

const TEXT: Record<Tone, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
  sky: 'text-sky-300',
  neutral: 'text-neutral-400',
};

const ACCENT_BORDER: Record<Tone, string> = {
  emerald: 'border-l-emerald-600',
  amber: 'border-l-amber-600',
  red: 'border-l-red-600',
  sky: 'border-l-sky-600',
  neutral: 'border-l-neutral-700',
};

const ACTIVITY_FILTERS = ['all', 'user', 'server', 'infra', 'errors'] as const;
type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

const ACTIVITY_FILTER_LABEL: Record<ActivityFilter, string> = {
  all: 'Всё',
  user: 'Пользователь',
  server: 'Серверы',
  infra: 'Инфра',
  errors: 'Ошибки',
};

export default function DashboardPage() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [recent, setRecent] = useState<AuditRow[]>([]);
  const [ready, setReady] = useState<ReadyCheck | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [diskBreakdown, setDiskBreakdown] = useState<DiskBreakdown | null>(null);
  const [diskModalOpen, setDiskModalOpen] = useState(false);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchJson<BridgeStatus>('/api/v1/host/bridge-status'),
      fetchJson<HostInfo>('/api/v1/host/info'),
      fetchJson<HostMetrics>('/api/v1/host/metrics'),
      fetchJson<{ items: ServerRow[] }>('/api/v1/servers'),
      fetchJson<{ items: AuditRow[] }>('/api/v1/audit?page_size=25'),
      fetch('/ready', { cache: 'no-store' }).then((r) => r.json() as Promise<ReadyCheck>),
      fetchJson<{ items: Worker[] }>('/api/v1/health/workers'),
    ]);
    setLastUpdate(new Date());
    if (results[0].status === 'fulfilled') setBridge(results[0].value);
    else setBridge({ connected: false, error: (results[0].reason as Error).message });
    if (results[1].status === 'fulfilled') setInfo(results[1].value);
    if (results[2].status === 'fulfilled') setMetrics(results[2].value);
    if (results[3].status === 'fulfilled') setServers(results[3].value.items);
    if (results[4].status === 'fulfilled') setRecent(results[4].value.items);
    if (results[5].status === 'fulfilled') setReady(results[5].value);
    if (results[6].status === 'fulfilled') setWorkers(results[6].value.items);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch(() => {});
    const t = setInterval(() => {
      if (!cancelled) void load().catch(() => {});
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    async function loadDiskBreakdown() {
      try {
        const res = await fetch('/api/v1/host/disk-usage', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const payload = (await res.json()) as DiskBreakdown;
        if (!cancelled) setDiskBreakdown(payload);
      } catch {
        // tolerate transient errors — disk breakdown is auxiliary
      }
    }
    void loadDiskBreakdown();
    const t = setInterval(loadDiskBreakdown, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const refreshDiskBreakdown = useCallback(async (): Promise<DiskBreakdown | null> => {
    try {
      const res = await fetch('/api/v1/host/disk-usage?refresh=1', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as DiskBreakdown;
      setDiskBreakdown(payload);
      return payload;
    } catch {
      return null;
    }
  }, []);

  const runningCount = servers.filter((s) => s.status === 'running').length;
  const playersOnline = servers.reduce((acc, s) => acc + (s.player_count ?? 0), 0);

  const alerts: string[] = [];
  if (bridge && !bridge.connected) alerts.push(`bridge: ${bridge.error ?? 'disconnected'}`);
  for (const s of servers) {
    if (s.status === 'failed') alerts.push(`${s.display_name}: сбой`);
    if (s.status === 'running' && s.rcon_state && s.rcon_state !== 'connected') {
      alerts.push(`${s.display_name}: RCON ${s.rcon_state}`);
    }
  }

  const health = computeHostHealth(info, metrics, bridge);
  const connectionRows = useMemo(
    () => buildConnectionRows(ready, bridge, workers),
    [ready, bridge, workers],
  );
  const connectionsHealthy = connectionRows.filter((r) => r.tone === 'emerald').length;

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-900 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Дашборд</h1>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 hover:border-sky-700 hover:text-sky-300"
          title="Обновить сейчас"
        >
          ↻ Обновить
        </button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Серверы"
          value={servers.length.toString()}
          hint={`${runningCount} работает`}
          tone="sky"
        />
        <SummaryCard
          title="Игроков онлайн"
          value={playersOnline.toString()}
          hint={
            runningCount === 0
              ? 'сервера не запущены'
              : `на ${runningCount} ${pluralize(runningCount, 'сервере', 'серверах', 'серверах')}`
          }
          tone="emerald"
        />
        <SummaryCard
          title="Состояние хоста"
          value={HEALTH_LABEL[health.level]}
          hint={health.reasons[0] ?? (bridge?.connected ? 'все метрики в норме' : 'bridge оффлайн')}
          tone={HEALTH_TONE[health.level]}
        />
        <SummaryCard
          title="Тревоги"
          value={alerts.length.toString()}
          hint={alerts[0] ?? 'тревог нет'}
          tone={alerts.length ? 'amber' : 'neutral'}
        />
      </section>

      <section className="grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <ServersTable servers={servers} onRefresh={() => void load()} />
        </div>
        <div className="lg:col-span-4">
          <HostBlock
            bridge={bridge}
            info={info}
            metrics={metrics}
            health={health}
            lastUpdate={lastUpdate}
            diskBreakdown={diskBreakdown}
            onDiskClick={() => setDiskModalOpen(true)}
          />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <RecentActivity rows={recent} filter={activityFilter} onFilter={setActivityFilter} />
        </div>
        <div className="lg:col-span-4">
          <ConnectionsHealth
            rows={connectionRows}
            healthyCount={connectionsHealthy}
            totalCount={connectionRows.length}
            bridgeConnected={bridge?.connected ?? false}
          />
        </div>
      </section>

      <DiskBreakdownModal
        open={diskModalOpen}
        onOpenChange={setDiskModalOpen}
        initialData={diskBreakdown}
        onRefresh={refreshDiskBreakdown}
      />
    </div>
  );
}

function SummaryCard({
  title,
  value,
  hint,
  tone,
}: {
  title: string;
  value: string;
  hint?: string;
  tone: Tone;
}) {
  return (
    <div
      className={`flex h-full flex-col justify-between rounded border border-neutral-800 border-l-2 ${ACCENT_BORDER[tone]} bg-neutral-950 p-4`}
    >
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">{title}</div>
      <div className="text-3xl font-semibold tabular-nums leading-none mt-2 text-neutral-50">
        {value}
      </div>
      {hint ? (
        <div className={`text-xs mt-2 truncate ${TEXT[tone]}`} title={hint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function PaneHeader({
  title,
  count,
  right,
}: {
  title: string;
  count?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-900 px-4 py-2.5">
      <div className="flex items-baseline gap-2 min-w-0">
        <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-300">{title}</h2>
        {count ? <span className="text-[10px] text-neutral-500 font-mono">{count}</span> : null}
      </div>
      {right ? <div className="flex items-center gap-2 shrink-0">{right}</div> : null}
    </div>
  );
}

function ServersTable({ servers, onRefresh }: { servers: ServerRow[]; onRefresh: () => void }) {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <PaneHeader
        title="Серверы"
        count={servers.length === 0 ? undefined : `${servers.length}`}
        right={
          <>
            <Link
              href="/servers/new"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-sky-700 hover:text-sky-300"
            >
              + Создать
            </Link>
            <Link href="/servers" className="text-[11px] text-sky-400 hover:text-sky-300">
              все →
            </Link>
          </>
        }
      />
      {servers.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-neutral-500">
          Серверов нет.{' '}
          <Link href="/servers/new" className="text-sky-400 hover:text-sky-300">
            Установить первый
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                <Th>Имя</Th>
                <Th>Статус</Th>
                <Th className="text-right">Игроки</Th>
                <Th>RCON</Th>
                <Th>Последний опрос</Th>
                <Th>Карта / слой</Th>
                <Th className="text-right">CPU / RAM</Th>
                <Th className="text-right pr-3">Действия</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {servers.map((s) => (
                <ServerTableRow key={s.id} server={s} onAction={onRefresh} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`font-medium px-3 py-2 border-b border-neutral-900 ${className ?? ''}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-2.5 align-middle ${className ?? ''}`} title={title}>
      {children}
    </td>
  );
}

function ServerTableRow({ server, onAction }: { server: ServerRow; onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = SERVER_STATUS[server.status] ?? {
    label: server.status,
    tone: 'neutral' as Tone,
  };
  const rcon =
    server.status === 'running'
      ? (RCON_STATUS[server.rcon_state ?? 'not_polled'] ?? {
          label: server.rcon_state ?? 'неизвестно',
          tone: 'neutral' as Tone,
        })
      : { label: '—', tone: 'neutral' as Tone };
  const players = server.status === 'running' ? `${server.player_count ?? '—'}` : '—';

  async function restart() {
    if (busy) return;
    if (!confirm(`Перезапустить «${server.display_name}»? Игроки будут отключены.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/servers/${server.id}/restart`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) {
        setError(r.status === 403 ? 'нет прав' : `ошибка ${r.status}`);
      } else {
        onAction();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="hover:bg-neutral-900/40">
      <Td>
        <Link href={`/servers/${server.id}`} className="block min-w-0 group">
          <div className="font-medium truncate text-neutral-100 group-hover:text-sky-300">
            {server.display_name}
          </div>
          <div className="text-[10px] font-mono text-neutral-500 truncate">{server.slug}</div>
        </Link>
      </Td>
      <Td>
        <StatusDot tone={status.tone} label={status.label} />
      </Td>
      <Td className="text-right tabular-nums font-mono text-neutral-200">{players}</Td>
      <Td>
        <StatusDot tone={rcon.tone} label={rcon.label} />
      </Td>
      <Td className="text-neutral-400 text-xs">
        {server.last_poll_at ? (
          <RelativeTime ts={server.last_poll_at} />
        ) : (
          <span className="text-neutral-600">—</span>
        )}
      </Td>
      <Td className="text-neutral-500 text-xs italic">не выбрано</Td>
      <Td className="text-right tabular-nums font-mono text-neutral-500 text-xs">— / —</Td>
      <Td className="text-right pr-3">
        <div className="inline-flex items-center gap-1">
          <Link
            href={`/servers/${server.id}`}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-sky-700 hover:text-sky-300"
          >
            Открыть
          </Link>
          <button
            type="button"
            onClick={restart}
            disabled={busy || server.status !== 'running'}
            title={
              server.status !== 'running'
                ? 'Доступно только для работающих серверов'
                : 'Перезапустить контейнер'
            }
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-amber-700 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-300"
          >
            {busy ? '…' : 'Перезапуск'}
          </button>
          <Link
            href={`/servers/${server.id}`}
            title="Подробнее"
            className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          >
            ⋯
          </Link>
        </div>
        {error ? <div className="text-[10px] text-red-400 mt-1 text-right">{error}</div> : null}
      </Td>
    </tr>
  );
}

function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
      <span className={`text-xs ${TEXT[tone]}`}>{label}</span>
    </span>
  );
}

function RelativeTime({ ts }: { ts: string }) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const date = new Date(ts);
  const ageSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (!Number.isFinite(date.getTime())) return <span className="text-neutral-600">—</span>;
  let label: string;
  if (ageSec < 60) label = `${ageSec}с назад`;
  else if (ageSec < 3600) label = `${Math.floor(ageSec / 60)}м назад`;
  else if (ageSec < 86_400) label = `${Math.floor(ageSec / 3600)}ч назад`;
  else label = `${Math.floor(ageSec / 86_400)}д назад`;
  return (
    <span className="font-mono" title={date.toLocaleString()}>
      {label}
    </span>
  );
}

function HostBlock({
  bridge,
  info,
  metrics,
  health,
  lastUpdate,
  diskBreakdown,
  onDiskClick,
}: {
  bridge: BridgeStatus | null;
  info: HostInfo | null;
  metrics: HostMetrics | null;
  health: ReturnType<typeof computeHostHealth>;
  lastUpdate: Date | null;
  diskBreakdown: DiskBreakdown | null;
  onDiskClick: () => void;
}) {
  const isLoading = info === null || metrics === null;
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);
  const bridgeConnected = bridge?.connected === true;

  return (
    <section className="flex h-full flex-col rounded border border-neutral-800 bg-neutral-950">
      <PaneHeader
        title="Хост"
        right={
          <span className={`text-[11px] ${TEXT[HEALTH_TONE[health.level]]}`}>
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle ${DOT[HEALTH_TONE[health.level]]}`}
            />
            {HEALTH_LABEL[health.level]}
          </span>
        }
      />
      <div className="px-4 pt-3 pb-2 flex flex-col gap-1 border-b border-neutral-900">
        <div className="text-base font-semibold text-neutral-100 truncate">
          {info?.hostname ?? <span className="text-neutral-600">—</span>}
        </div>
        <div className="text-[11px] text-neutral-400 truncate">
          {info ? (
            <>
              {info.os_name} {info.os_version} · <span className="font-mono">{info.arch}</span> ·
              аптайм {formatUptime(info.uptime_seconds)}
            </>
          ) : (
            <span className="italic text-neutral-600">загрузка…</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-400 mt-1">
          <span>
            Bridge:{' '}
            {bridgeConnected ? (
              <span className="text-emerald-300">
                подключён{bridge?.version ? ` (v${bridge.version})` : ''}
              </span>
            ) : (
              <span className="text-red-300">недоступен</span>
            )}
          </span>
          <LiveIndicator
            lastUpdate={metrics?.sampled_at ? new Date(metrics.sampled_at) : lastUpdate}
          />
          <RestartBridgeButton
            disabled={!bridgeConnected}
            disabledReason="Сначала восстановите соединение."
          />
        </div>
      </div>

      <div className="px-4 py-3 grid gap-3 sm:grid-cols-2">
        {isLoading ? (
          <>
            <SkeletonResource />
            <SkeletonResource />
            <SkeletonResource />
            <SkeletonResource />
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpenMetric('cpu')}
              className="text-left transition hover:ring-2 hover:ring-emerald-700/40 rounded-xl"
              aria-label="Открыть график CPU за 24 часа"
            >
              <CpuCard info={info} metrics={metrics} />
            </button>
            <button
              type="button"
              onClick={() => setOpenMetric('ram')}
              className="text-left transition hover:ring-2 hover:ring-blue-700/40 rounded-xl"
              aria-label="Открыть график RAM за 24 часа"
            >
              <RamCard metrics={metrics} />
            </button>
            <button
              type="button"
              onClick={onDiskClick}
              data-testid="disk-card"
              className="text-left transition hover:ring-2 hover:ring-purple-700/40 rounded-xl"
              aria-label="Открыть детализацию диска"
            >
              <DiskCard metrics={metrics} diskBreakdown={diskBreakdown} />
            </button>
            <button
              type="button"
              onClick={() => setOpenMetric('net')}
              className="text-left transition hover:ring-2 hover:ring-amber-700/40 rounded-xl"
              aria-label="Открыть график сети за 24 часа"
            >
              <NetworkCard metrics={metrics} />
            </button>
          </>
        )}
      </div>

      <SystemRow info={info} metrics={metrics} />
      {metrics ? (
        <MetricHistoryModal
          open={openMetric !== null}
          onClose={() => setOpenMetric(null)}
          metric={openMetric ?? 'cpu'}
          ramTotalBytes={metrics.ram_total_bytes}
          diskTotalBytes={metrics.disk_total_bytes}
        />
      ) : null}
    </section>
  );
}

function CpuCard({ info, metrics }: { info: HostInfo; metrics: HostMetrics }) {
  const pct = Math.max(0, Math.min(100, metrics.cpu_percent));
  const tone = thresholdTone(pct / 100, 0.8, 0.95);
  const cpuLabel = info.cpu_model && info.cpu_model !== 'unknown' ? info.cpu_model : null;
  return (
    <ResourceCard
      title="CPU"
      mainValue={`${metrics.cpu_percent.toFixed(1)}%`}
      sub={
        cpuLabel ? (
          <span className="truncate" title={cpuLabel}>
            {cpuLabel} · {info.cpu_cores} ядер
          </span>
        ) : (
          <span className="text-neutral-600">{info.cpu_cores} ядер</span>
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
        title="RAM"
        mainValue="N/A"
        sub={<span className="text-neutral-600">данных нет</span>}
      />
    );
  }
  const r = ratio(metrics.ram_used_bytes, total);
  const tone = thresholdTone(r, 0.7, 0.85);
  return (
    <ResourceCard
      title="RAM"
      mainValue={formatPercent(metrics.ram_used_bytes, total)}
      sub={
        <span className="font-mono">
          {formatBytes(metrics.ram_used_bytes)} / {formatBytes(total)}
        </span>
      }
      progressPct={r * 100}
      progressTone={tone}
    />
  );
}

function DiskCard({
  metrics,
  diskBreakdown,
}: {
  metrics: HostMetrics;
  diskBreakdown: DiskBreakdown | null;
}) {
  const total = metrics.disk_total_bytes;
  if (total <= 0) {
    return (
      <ResourceCard
        title="Диск"
        mainValue="N/A"
        sub={<span className="text-neutral-600">данных нет</span>}
      />
    );
  }
  const r = ratio(metrics.disk_used_bytes, total);
  const usedPct = r * 100;
  const tone = thresholdTone(r, 0.75, 0.9);
  const panelPct = diskBreakdown ? Math.min(diskBreakdown.panel_pct, usedPct) : 0;
  const otherPct = diskBreakdown ? Math.max(0, usedPct - panelPct) : 0;
  const splitSegments = diskBreakdown
    ? [
        { widthPct: panelPct, className: 'bg-purple-500' },
        { widthPct: otherPct, className: 'bg-purple-300' },
      ]
    : undefined;
  const legend = diskBreakdown
    ? [
        { label: 'Панель', pct: panelPct, swatchClassName: 'bg-purple-500' },
        { label: 'Прочее', pct: otherPct, swatchClassName: 'bg-purple-300' },
      ]
    : undefined;
  return (
    <ResourceCard
      title="Диск"
      mainValue={formatPercent(metrics.disk_used_bytes, total)}
      sub={
        <span className="font-mono">
          {formatBytes(metrics.disk_used_bytes)} / {formatBytes(total)}
        </span>
      }
      progressPct={usedPct}
      progressTone={tone}
      progressSegments={splitSegments}
      progressLegend={legend}
    />
  );
}

function NetworkCard({ metrics }: { metrics: HostMetrics }) {
  return (
    <div className="rounded border border-neutral-900 bg-neutral-950 p-3 flex flex-col justify-between min-h-[110px]">
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Сеть</div>
      <div className="flex justify-between items-baseline gap-3 mt-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase text-neutral-500">RX</div>
          <div className="text-base font-semibold tabular-nums font-mono text-neutral-100 truncate">
            {formatBytesPerSec(metrics.net_rx_bytes_per_sec)}
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-[10px] uppercase text-neutral-500">TX</div>
          <div className="text-base font-semibold tabular-nums font-mono text-neutral-100 truncate">
            {formatBytesPerSec(metrics.net_tx_bytes_per_sec)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResourceCard({
  title,
  mainValue,
  sub,
  progressPct,
  progressTone,
  progressSegments,
  progressLegend,
}: {
  title: string;
  mainValue: string;
  sub: React.ReactNode;
  progressPct?: number;
  progressTone?: 'emerald' | 'amber' | 'red';
  progressSegments?: { widthPct: number; className: string }[];
  progressLegend?: { label: string; pct: number; swatchClassName: string }[];
}) {
  const fill: Record<string, string> = {
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  };
  return (
    <div className="rounded border border-neutral-900 bg-neutral-950 p-3 flex flex-col gap-2 min-h-[110px]">
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">{title}</div>
      <div className="text-2xl font-semibold tabular-nums leading-none text-neutral-50">
        {mainValue}
      </div>
      <div className="text-[11px] text-neutral-400 truncate">{sub}</div>
      {progressPct !== undefined && progressTone ? (
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-900 mt-auto">
          {progressSegments && progressSegments.length > 0 ? (
            progressSegments.map((seg) => (
              <div
                key={seg.className}
                className={`h-1.5 ${seg.className}`}
                style={{ width: `${Math.max(0, Math.min(100, seg.widthPct))}%` }}
              />
            ))
          ) : (
            <div
              className={`h-1.5 ${fill[progressTone]}`}
              style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
            />
          )}
        </div>
      ) : null}
      {progressLegend && progressLegend.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-neutral-400">
          {progressLegend.map((entry) => (
            <span key={entry.label} className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-sm ${entry.swatchClassName}`} />
              <span>
                {entry.label}{' '}
                <span className="font-mono tabular-nums">{entry.pct.toFixed(1)}%</span>
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SkeletonResource() {
  return (
    <div className="rounded border border-neutral-900 bg-neutral-950 p-3 flex flex-col gap-2 min-h-[110px] animate-pulse">
      <div className="h-2.5 w-12 rounded bg-neutral-900" />
      <div className="h-6 w-20 rounded bg-neutral-900" />
      <div className="h-2.5 w-28 rounded bg-neutral-900" />
      <div className="h-1.5 rounded-full bg-neutral-900 mt-auto" />
    </div>
  );
}

function SystemRow({ info, metrics }: { info: HostInfo | null; metrics: HostMetrics | null }) {
  const ip = info && info.ip_addresses.length > 0 ? info.ip_addresses.join(', ') : 'нет данных';
  const docker = info && info.docker_version !== '' ? info.docker_version : 'нет данных';
  const kernel = info?.kernel ?? 'нет данных';
  const load = metrics
    ? `${metrics.load_avg_1m.toFixed(2)} / ${metrics.load_avg_5m.toFixed(2)} / ${metrics.load_avg_15m.toFixed(2)}`
    : 'нет данных';

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 py-3 border-t border-neutral-900 text-[11px]">
      <SystemCell label="Ядро" value={kernel} />
      <SystemCell label="Docker" value={docker} />
      <SystemCell label="IP" value={ip} />
      <SystemCell label="Load avg" value={load} />
    </dl>
  );
}

function SystemCell({ label, value }: { label: string; value: string }) {
  const isMissing = value === 'нет данных';
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <dt className="text-neutral-500 uppercase tracking-[0.16em] text-[9px] shrink-0">{label}</dt>
      <dd
        className={`truncate font-mono ${isMissing ? 'text-neutral-600 italic' : 'text-neutral-200'}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function RecentActivity({
  rows,
  filter,
  onFilter,
}: {
  rows: AuditRow[];
  filter: ActivityFilter;
  onFilter: (f: ActivityFilter) => void;
}) {
  const filtered = useMemo(
    () => rows.filter((r) => matchesActivityFilter(r, filter)),
    [rows, filter],
  );
  return (
    <section className="flex flex-col rounded border border-neutral-800 bg-neutral-950 max-h-[380px]">
      <PaneHeader
        title="Последние действия"
        count={`${filtered.length}/${rows.length}`}
        right={
          <Link href="/audit" className="text-[11px] text-sky-400 hover:text-sky-300">
            журнал →
          </Link>
        }
      />
      <div className="flex items-center gap-1 px-3 py-2 border-b border-neutral-900 overflow-x-auto">
        {ACTIVITY_FILTERS.map((f) => {
          const active = f === filter;
          return (
            <button
              key={f}
              type="button"
              onClick={() => onFilter(f)}
              className={`rounded px-2 py-0.5 text-[11px] border whitespace-nowrap ${
                active
                  ? 'border-sky-700 bg-sky-950/50 text-sky-200'
                  : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
              }`}
            >
              {ACTIVITY_FILTER_LABEL[f]}
            </button>
          );
        })}
      </div>
      {filtered.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-neutral-500">
          {rows.length === 0 ? 'пока пусто' : 'под фильтр ничего не подходит'}
        </div>
      ) : (
        <div className="overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-950 z-10">
              <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                <Th>Время</Th>
                <Th>Кто</Th>
                <Th>Событие</Th>
                <Th>Цель</Th>
                <Th className="text-right pr-3">Тип</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {filtered.map((ev) => (
                <ActivityRow key={ev.id} ev={ev} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ActivityRow({ ev }: { ev: AuditRow }) {
  const severity = severityFromStatus(ev.status_code);
  const time = new Date(ev.created_at);
  const targetLabel = ev.target_type
    ? `${ev.target_type}${ev.target_id ? ` · ${ev.target_id.slice(0, 8)}` : ''}`
    : '—';
  return (
    <tr className="hover:bg-neutral-900/40">
      <Td className="text-[11px] text-neutral-400 font-mono whitespace-nowrap">
        {time.toLocaleTimeString()}
      </Td>
      <Td className="text-xs text-neutral-300 capitalize">{ev.actor_kind}</Td>
      <Td>
        <span className="font-mono text-xs text-neutral-100">{ev.action_type}</span>
      </Td>
      <Td className="text-xs text-neutral-400 font-mono truncate max-w-[160px]" title={targetLabel}>
        {targetLabel}
      </Td>
      <Td className="text-right pr-3">
        <SeverityBadge severity={severity} statusCode={ev.status_code} />
      </Td>
    </tr>
  );
}

function SeverityBadge({
  severity,
  statusCode,
}: {
  severity: 'info' | 'warning' | 'critical';
  statusCode: number | null;
}) {
  const tone: Tone = severity === 'critical' ? 'red' : severity === 'warning' ? 'amber' : 'neutral';
  const label = severity === 'critical' ? 'критично' : severity === 'warning' ? 'предупр.' : 'инфо';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-neutral-900 bg-neutral-900/60 px-1.5 py-0.5 text-[10px] ${TEXT[tone]}`}
      title={statusCode != null ? `HTTP ${statusCode}` : 'нет статуса'}
    >
      <span className={`h-1 w-1 rounded-full ${DOT[tone]}`} />
      {label}
    </span>
  );
}

function severityFromStatus(code: number | null): 'info' | 'warning' | 'critical' {
  if (code == null) return 'info';
  if (code >= 500) return 'critical';
  if (code >= 400) return 'warning';
  return 'info';
}

function matchesActivityFilter(row: AuditRow, filter: ActivityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errors') return typeof row.status_code === 'number' && row.status_code >= 400;
  if (filter === 'user') {
    return row.actor_kind === 'user' || /^(auth|session|user)\./.test(row.action_type);
  }
  if (filter === 'server') return /^server\./.test(row.action_type);
  if (filter === 'infra') return /^(host|config|depot|bridge)\./.test(row.action_type);
  return true;
}

interface ConnectionRow {
  key: string;
  group: 'core' | 'workers';
  name: string;
  state: string;
  detail?: string;
  tone: Tone;
}

function buildConnectionRows(
  ready: ReadyCheck | null,
  bridge: BridgeStatus | null,
  workers: Worker[],
): ConnectionRow[] {
  const rows: ConnectionRow[] = [];

  const pgState = ready?.checks.postgres;
  rows.push({
    key: 'postgres',
    group: 'core',
    name: 'PostgreSQL',
    state: pgState === 'ok' ? 'здоров' : pgState ? 'недоступен' : 'нет данных',
    tone: pgState === 'ok' ? 'emerald' : pgState ? 'red' : 'neutral',
  });

  const redisState = ready?.checks.redis;
  rows.push({
    key: 'redis',
    group: 'core',
    name: 'Redis',
    state: redisState === 'ok' ? 'здоров' : redisState ? 'недоступен' : 'нет данных',
    tone: redisState === 'ok' ? 'emerald' : redisState ? 'red' : 'neutral',
  });

  rows.push({
    key: 'bridge',
    group: 'core',
    name: 'panel-host-bridge',
    state: bridge?.connected ? 'подключён' : (bridge?.error ?? 'отключён'),
    detail: bridge?.connected
      ? `RTT ${bridge.round_trip_ms ?? '?'} мс${bridge.version ? ` · v${bridge.version}` : ''}`
      : undefined,
    tone: bridge?.connected ? 'emerald' : 'red',
  });

  const expected = ['rcon', 'log-ingest', 'audit-archiver', 'event-partition'];
  const byName = new Map(workers.map((w) => [w.name, w]));
  for (const name of expected) {
    const w = byName.get(name);
    if (!w) {
      rows.push({
        key: `worker-${name}`,
        group: 'workers',
        name: `worker-${name}`,
        state: 'нет heartbeat',
        tone: 'red',
      });
      continue;
    }
    const tone: Tone =
      w.age_ms > WORKER_STALE_MS ? 'red' : w.age_ms > WORKER_OK_MS ? 'amber' : 'emerald';
    rows.push({
      key: `worker-${name}`,
      group: 'workers',
      name: `worker-${name}`,
      state: w.status ?? 'жив',
      detail: `${Math.round(w.age_ms / 1000)}с назад · pid ${w.pid}`,
      tone,
    });
  }

  return rows;
}

function ConnectionsHealth({
  rows,
  healthyCount,
  totalCount,
  bridgeConnected,
}: {
  rows: ConnectionRow[];
  healthyCount: number;
  totalCount: number;
  bridgeConnected: boolean;
}) {
  const summaryTone: Tone =
    healthyCount === totalCount ? 'emerald' : healthyCount > 0 ? 'amber' : 'red';
  const core = rows.filter((r) => r.group === 'core');
  const workers = rows.filter((r) => r.group === 'workers');

  return (
    <section className="flex h-full flex-col rounded border border-neutral-800 bg-neutral-950">
      <PaneHeader
        title="Соединения"
        right={
          <span className={`text-[11px] tabular-nums ${TEXT[summaryTone]}`}>
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle ${DOT[summaryTone]}`}
            />
            {healthyCount} / {totalCount} здоровы
          </span>
        }
      />
      <div className="px-4 py-3 space-y-4 text-sm">
        <ConnectionGroup label="Core" rows={core} />
        <ConnectionGroup
          label="Workers"
          rows={workers}
          actionDisabledReason={!bridgeConnected ? 'bridge оффлайн' : undefined}
        />
      </div>
    </section>
  );
}

function ConnectionGroup({
  label,
  rows,
  actionDisabledReason,
}: {
  label: string;
  rows: ConnectionRow[];
  actionDisabledReason?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 mb-2">{label}</div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <ConnectionItem key={r.key} row={r} disabledReason={actionDisabledReason} />
        ))}
      </ul>
    </div>
  );
}

function ConnectionItem({ row, disabledReason }: { row: ConnectionRow; disabledReason?: string }) {
  return (
    <li
      className={`flex items-center gap-2 rounded border border-neutral-900 border-l-2 ${ACCENT_BORDER[row.tone]} bg-neutral-900/40 px-2.5 py-1.5`}
    >
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${DOT[row.tone]}`} />
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-xs font-medium text-neutral-200 truncate">{row.name}</span>
        <span className={`text-[11px] truncate ${TEXT[row.tone]}`}>{row.state}</span>
      </div>
      {row.detail ? (
        <span
          className="text-[10px] font-mono text-neutral-500 whitespace-nowrap"
          title={row.detail}
        >
          {row.detail}
        </span>
      ) : null}
      {row.group === 'workers' ? (
        <span
          className="text-[10px] text-neutral-600"
          title={disabledReason ?? 'Перезапуск workers выполняется через docker compose'}
        >
          ⋯
        </span>
      ) : null}
    </li>
  );
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const lastDigit = abs % 10;
  if (abs >= 11 && abs <= 14) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}
