'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DepotUpdateModal } from '@/components/DepotUpdateModal';
import { DiskBreakdownModal } from '@/components/DiskBreakdownModal';
import { UpdateProgressModal } from '@/components/UpdateProgressModal';
import {
  Button,
  CardGrid,
  PageContainer,
  PageHeader,
  RefreshIcon,
  StatTile,
  type StatTileTone,
} from '@/components/ui';
import { computeHostHealth, type HealthLevel } from '@/lib/host-health';
import { AnalyticsPanel } from './analytics-panel';
import { buildConnectionRows, ConnectionsHealth } from './ConnectionsHealth';
import { HostBlock } from './HostBlock';
import { RecentActivity } from './RecentActivity';
import { ServersTable } from './ServersTable';
import { type ActivityFilter, HEALTH_LABEL, pluralize } from './shared';
import type {
  AuditRow,
  BridgeStatus,
  DiskBreakdown,
  HostInfo,
  HostMetrics,
  ReadyCheck,
  ServerRow,
  Worker,
} from './types';
import { VoteAnalyticsPanel } from './vote-analytics-panel';

const POLL_MS = 4000;

const HEALTH_TILE_TONE: Record<HealthLevel, StatTileTone> = {
  healthy: 'good',
  warning: 'warn',
  critical: 'crit',
  unknown: 'neutral',
};

// Memoized so the 4 s poll does not re-render the heavy charts while their
// `servers` prop is unchanged.
const MemoAnalyticsPanel = memo(AnalyticsPanel);
const MemoVoteAnalyticsPanel = memo(VoteAnalyticsPanel);

export default function DashboardPage() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [serversError, setServersError] = useState<string | null>(null);
  const [recent, setRecent] = useState<AuditRow[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [ready, setReady] = useState<ReadyCheck | null>(null);
  const [readyError, setReadyError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [workersError, setWorkersError] = useState<string | null>(null);
  // Первый ответ ещё не пришёл: без этого флага пустой список неотличим от
  // загрузки, и оператор видит «Серверов нет» там, где идёт первый запрос (§8).
  const [loaded, setLoaded] = useState(false);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [diskBreakdown, setDiskBreakdown] = useState<DiskBreakdown | null>(null);
  const [diskModalOpen, setDiskModalOpen] = useState(false);
  const [depotModalOpen, setDepotModalOpen] = useState(false);
  const [depotProgressOpen, setDepotProgressOpen] = useState(false);

  /**
   * `host/info` is fetched separately from the hot poll below: on the bridge
   * it forks `docker --version` and rereads `/etc/os-release`/`/proc` on
   * every call (apps/bridge/internal/metrics/host.go), but its data (OS,
   * kernel, CPU, IP) is effectively static, so polling it every POLL_MS was
   * pure waste (DASH-546 / DASH-1334).
   */
  const loadInfo = useCallback(async () => {
    try {
      const value = await fetchJson<HostInfo>('/api/v1/host/info');
      setInfo(value);
      setInfoError(null);
    } catch (err) {
      setInfoError((err as Error).message);
    }
  }, []);

  // Guards against overlapping poll ticks: if the bridge is slow and one
  // load() is still in flight when the next tick fires, the late tick is
  // skipped instead of racing the in-flight one and letting whichever
  // request settles last win regardless of which is freshest (DASH-546).
  const loadInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    try {
      const results = await Promise.allSettled([
        fetchJson<BridgeStatus>('/api/v1/host/bridge-status'),
        fetchJson<HostMetrics>('/api/v1/host/metrics'),
        fetchJson<{ items: ServerRow[] }>('/api/v1/servers'),
        fetchJson<{ items: AuditRow[] }>('/api/v1/audit?page_size=25'),
        fetchJson<ReadyCheck>('/api/v1/health/dependencies'),
        fetchJson<{ items: Worker[] }>('/api/v1/health/workers'),
      ]);
      if (!mountedRef.current) return;
      setLoaded(true);
      if (results[0].status === 'fulfilled') setBridge(results[0].value);
      else setBridge({ connected: false, error: (results[0].reason as Error).message });

      // Every source below tracks its own error instead of silently keeping
      // whatever the last successful poll left behind: a bridge/API outage
      // or a 403 from a missing permission must not look like stale «healthy»
      // data (DASH-545).
      if (results[1].status === 'fulfilled') {
        setMetrics(results[1].value);
        setMetricsError(null);
      } else {
        setMetrics(null);
        setMetricsError((results[1].reason as Error).message);
      }

      if (results[2].status === 'fulfilled') {
        setServers(results[2].value.items);
        setServersError(null);
      } else {
        setServersError((results[2].reason as Error).message);
      }

      if (results[3].status === 'fulfilled') {
        setRecent(results[3].value.items);
        setAuditError(null);
      } else {
        setAuditError((results[3].reason as Error).message);
      }

      if (results[4].status === 'fulfilled') {
        setReady(results[4].value);
        setReadyError(null);
      } else {
        setReady(null);
        setReadyError((results[4].reason as Error).message);
      }

      if (results[5].status === 'fulfilled') {
        setWorkers(results[5].value.items);
        setWorkersError(null);
      } else {
        setWorkers([]);
        setWorkersError((results[5].reason as Error).message);
      }
    } finally {
      loadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadInfo();
    const tick = () => {
      // A hidden tab pauses the poll instead of hammering the bridge and the
      // API for a dashboard nobody is looking at (DASH-546 / DASH-1334).
      if (typeof document !== 'undefined' && document.hidden) return;
      void load().catch(() => {});
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      mountedRef.current = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [load, loadInfo]);

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
  if (bridge && !bridge.connected) alerts.push(`Bridge: ${bridge.error ?? 'нет соединения'}`);
  for (const s of servers) {
    if (s.status === 'failed') alerts.push(`${s.display_name}: сбой`);
    if (s.status === 'running' && s.rcon_state && s.rcon_state !== 'connected') {
      alerts.push(`${s.display_name}: RCON ${s.rcon_state}`);
    }
  }

  const health = computeHostHealth(info, metrics, bridge);
  // The 4 s poll replaces `servers` with an equal-by-content array; keying on
  // the id/name pairs keeps the analytics panels' `servers` prop referentially
  // stable, so the memoized panels do not re-render on every poll.
  const analyticsServersKey = servers.map((s) => `${s.id}\u0000${s.display_name}`).join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only when an id or name changes, not on every poll
  const analyticsServers = useMemo(
    () => servers.map((s) => ({ id: s.id, display_name: s.display_name })),
    [analyticsServersKey],
  );
  const connectionRows = useMemo(
    () => buildConnectionRows(ready, bridge, workers, readyError),
    [ready, bridge, workers, readyError],
  );
  const connectionsHealthy = connectionRows.filter((r) => r.state === 'good').length;

  return (
    <PageContainer>
      <PageHeader
        title="Дашборд"
        actions={
          <>
            <Button onClick={() => setDepotModalOpen(true)} title="Обновить Squad через SteamCMD">
              Обновить Squad
            </Button>
            <Button
              onClick={() => {
                void load();
                void loadInfo();
              }}
            >
              <RefreshIcon />
              Обновить
            </Button>
          </>
        }
      />

      <CardGrid cols={4}>
        <StatTile
          label="Серверы"
          value={servers.length.toString()}
          hint={`${runningCount} работает`}
          tone="accent"
        />
        <StatTile
          label="Игроков онлайн"
          value={playersOnline.toString()}
          hint={
            runningCount === 0
              ? 'сервера не запущены'
              : `на ${runningCount} ${pluralize(runningCount, 'сервере', 'серверах', 'серверах')}`
          }
          tone="good"
        />
        <StatTile
          label="Состояние хоста"
          value={HEALTH_LABEL[health.level]}
          hint={
            health.reasons[0] ??
            (health.level === 'unknown'
              ? 'метрики хоста недоступны'
              : bridge?.connected
                ? 'все метрики в норме'
                : 'Bridge оффлайн')
          }
          tone={HEALTH_TILE_TONE[health.level]}
        />
        <StatTile
          label="Тревоги"
          value={alerts.length.toString()}
          hint={alerts[0] ?? 'тревог нет'}
          tone={alerts.length ? 'warn' : 'neutral'}
        />
      </CardGrid>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <ServersTable
            servers={servers}
            loading={!loaded}
            error={serversError}
            onRefresh={() => void load()}
          />
        </div>
        <div className="lg:col-span-4">
          <HostBlock
            bridge={bridge}
            info={info}
            infoError={infoError}
            metrics={metrics}
            metricsError={metricsError}
            health={health}
            diskBreakdown={diskBreakdown}
            onDiskClick={() => setDiskModalOpen(true)}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <RecentActivity
            rows={recent}
            loading={!loaded}
            error={auditError}
            filter={activityFilter}
            onFilter={setActivityFilter}
          />
        </div>
        <div className="lg:col-span-4">
          <ConnectionsHealth
            rows={connectionRows}
            healthyCount={connectionsHealthy}
            totalCount={connectionRows.length}
            bridgeConnected={bridge?.connected ?? false}
            workersError={workersError}
          />
        </div>
      </div>

      <MemoAnalyticsPanel servers={analyticsServers} />

      <MemoVoteAnalyticsPanel servers={analyticsServers} />

      <DiskBreakdownModal
        open={diskModalOpen}
        onOpenChange={setDiskModalOpen}
        initialData={diskBreakdown}
        onRefresh={refreshDiskBreakdown}
      />

      <DepotUpdateModal
        open={depotModalOpen}
        onOpenChange={setDepotModalOpen}
        servers={servers.map((s) => ({
          id: s.id,
          display_name: s.display_name,
          status: s.status,
          player_count: s.player_count ?? 0,
        }))}
        onStart={async (serverIds) => {
          const r = await fetch('/api/v1/depot/update', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ server_ids: serverIds }),
          });
          if (!r.ok) {
            const body = (await r.json().catch(() => null)) as {
              error?: string;
              server_ids?: string[];
            } | null;
            // The depot is one volume shared by every server on the host, so
            // the API refuses unless every other live server is selected too
            // (#20 follow-up).
            if (body?.error === 'servers_running') {
              throw new Error(
                `Отметьте все запущенные серверы для остановки: не выбрано ${body.server_ids?.length ?? 0}.`,
              );
            }
            // The dialog shows this message, so carry the API's error code.
            throw new Error(body?.error ?? `HTTP ${r.status}`);
          }
          setDepotProgressOpen(true);
          void load();
        }}
      />

      <UpdateProgressModal
        open={depotProgressOpen}
        onOpenChange={setDepotProgressOpen}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление Squad"
        onDone={() => void load()}
      />
    </PageContainer>
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}
