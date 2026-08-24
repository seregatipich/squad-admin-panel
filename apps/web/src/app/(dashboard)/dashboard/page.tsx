'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DepotUpdateModal } from '@/components/DepotUpdateModal';
import { DiskBreakdownModal } from '@/components/DiskBreakdownModal';
import { DockerPruneButton } from '@/components/DockerPruneButton';
import { LiveIndicator } from '@/components/LiveIndicator';
import { MetricHistoryModal, type MetricKey } from '@/components/MetricHistoryModal';
import { RestartBridgeButton } from '@/components/RestartBridgeButton';
import { UpdateProgressModal } from '@/components/UpdateProgressModal';
import {
  AlertDialog,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  DateTime,
  EmptyState,
  formatClock,
  InlineBanner,
  PageContainer,
  PageHeader,
  PlusIcon,
  RefreshIcon,
  type RelativeLabels,
  SegmentedControl,
  Skeleton,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  StatTile,
  type StatTileTone,
  StatusBadge,
  StatusDot,
  type StatusState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { formatBytes, formatBytesPerSec, formatPercent, formatUptime, ratio } from '@/lib/format';
import { computeHostHealth, type HealthLevel, thresholdTone } from '@/lib/host-health';
import { AnalyticsPanel } from './analytics-panel';
import { VoteAnalyticsPanel } from './vote-analytics-panel';

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

const HEALTH_STATE: Record<HealthLevel, StatusState> = {
  healthy: 'good',
  warning: 'warn',
  critical: 'crit',
};

const HEALTH_TILE_TONE: Record<HealthLevel, StatTileTone> = {
  healthy: 'good',
  warning: 'warn',
  critical: 'crit',
};

/**
 * `thresholdTone` живёт в `lib/host-health` и говорит на языке палитры
 * (`emerald`/`amber`/`red`), а плитка — на языке состояний дизайн-системы.
 * Перевод делается здесь, чтобы не менять общую библиотеку ради одной страницы.
 */
const THRESHOLD_TILE_TONE: Record<ReturnType<typeof thresholdTone>, StatTileTone> = {
  emerald: 'good',
  amber: 'warn',
  red: 'crit',
};

interface StatusStyle {
  label: string;
  state: StatusState;
}

const SERVER_STATUS: Record<string, StatusStyle> = {
  running: { label: 'Работает', state: 'good' },
  starting: { label: 'Запускается', state: 'warn' },
  stopping: { label: 'Остановка', state: 'warn' },
  installing: { label: 'Установка', state: 'warn' },
  ready: { label: 'Готов', state: 'idle' },
  stopped: { label: 'Остановлен', state: 'idle' },
  pending: { label: 'Ожидает', state: 'idle' },
  failed: { label: 'Сбой', state: 'crit' },
};

const RCON_STATUS: Record<string, StatusStyle> = {
  connected: { label: 'Подключён', state: 'good' },
  authenticating: { label: 'Аутентификация', state: 'warn' },
  reconnecting: { label: 'Переподключение', state: 'warn' },
  disconnected: { label: 'Отключён', state: 'crit' },
  failed: { label: 'Сбой', state: 'crit' },
  not_polled: { label: 'Не опрашивается', state: 'idle' },
};

/** Роль инициатора события из журнала; неизвестное значение показывается как есть. */
const ACTOR_KIND_LABEL: Record<string, string> = {
  steam: 'Оператор',
  user: 'Пользователь',
  system: 'Система',
  bot: 'Бот',
};

const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

const RELATIVE_LABELS: RelativeLabels = {
  justNow: 'только что',
  secondsAgo: (n) => `${n} с назад`,
  minutesAgo: (n) => `${n} мин назад`,
  hoursAgo: (n) => `${n} ч назад`,
  daysAgo: (n) => `${n} д назад`,
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
  const [serversError, setServersError] = useState<string | null>(null);
  const [recent, setRecent] = useState<AuditRow[]>([]);
  const [ready, setReady] = useState<ReadyCheck | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  // Первый ответ ещё не пришёл: без этого флага пустой список неотличим от
  // загрузки, и оператор видит «Серверов нет» там, где идёт первый запрос (§8).
  const [loaded, setLoaded] = useState(false);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [diskBreakdown, setDiskBreakdown] = useState<DiskBreakdown | null>(null);
  const [diskModalOpen, setDiskModalOpen] = useState(false);
  const [depotModalOpen, setDepotModalOpen] = useState(false);
  const [depotProgressOpen, setDepotProgressOpen] = useState(false);

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
    setLoaded(true);
    if (results[0].status === 'fulfilled') setBridge(results[0].value);
    else setBridge({ connected: false, error: (results[0].reason as Error).message });
    if (results[1].status === 'fulfilled') setInfo(results[1].value);
    if (results[2].status === 'fulfilled') setMetrics(results[2].value);
    if (results[3].status === 'fulfilled') {
      setServers(results[3].value.items);
      setServersError(null);
    } else {
      setServersError((results[3].reason as Error).message);
    }
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
  if (bridge && !bridge.connected) alerts.push(`Bridge: ${bridge.error ?? 'нет соединения'}`);
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
            <Button onClick={() => void load()}>
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
          hint={health.reasons[0] ?? (bridge?.connected ? 'все метрики в норме' : 'Bridge оффлайн')}
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
            metrics={metrics}
            health={health}
            lastUpdate={lastUpdate}
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
          />
        </div>
      </div>

      <AnalyticsPanel servers={servers.map((s) => ({ id: s.id, display_name: s.display_name }))} />

      <VoteAnalyticsPanel
        servers={servers.map((s) => ({ id: s.id, display_name: s.display_name }))}
      />

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
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

/** Порядок строк при выбранной колонке; без выбора остаётся порядок ответа API. */
function sortServers(
  servers: ServerRow[],
  key: string | null,
  direction: SortDirection,
): ServerRow[] {
  if (key === null) return servers;
  const sign = direction === 'asc' ? 1 : -1;
  return [...servers].sort((a, b) => {
    if (key === 'players') return sign * ((a.player_count ?? -1) - (b.player_count ?? -1));
    if (key === 'status') return sign * a.status.localeCompare(b.status, 'ru');
    return sign * a.display_name.localeCompare(b.display_name, 'ru');
  });
}

function ServersTable({
  servers,
  loading,
  error,
  onRefresh,
}: {
  servers: ServerRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [direction, setDirection] = useState<SortDirection>('asc');
  const rows = useMemo(
    () => sortServers(servers, sortKey, direction),
    [servers, sortKey, direction],
  );

  const handleSort = (key: string) => {
    if (key === sortKey) {
      setDirection(direction === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(key);
    setDirection('asc');
  };

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Серверы"
        count={servers.length === 0 ? undefined : servers.length}
        actions={
          <>
            <ButtonLink href="/servers/new" size="sm">
              <PlusIcon />
              Создать
            </ButtonLink>
            <ButtonLink href="/servers" variant="plain" size="sm">
              Все серверы
            </ButtonLink>
          </>
        }
      />
      {error ? (
        <CardBody>
          <InlineBanner
            tone="crit"
            title="Список серверов не загрузился"
            description={error}
            action={
              <Button size="sm" onClick={onRefresh}>
                Повторить
              </Button>
            }
          />
        </CardBody>
      ) : loading ? (
        <CardBody>
          <SkeletonTable rows={4} cols={5} label="Загружаем список серверов" />
        </CardBody>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Серверов нет"
          description="Установите первый сервер — он появится здесь вместе со статусом и числом игроков."
          action={
            <ButtonLink href="/servers/new" variant="primary" size="sm">
              Установить первый
            </ButtonLink>
          }
        />
      ) : (
        <Table ariaLabel="Серверы">
          <TableHead>
            <tr>
              <SortableTh
                sortKey="name"
                activeKey={sortKey}
                direction={direction}
                onSort={handleSort}
                label="Имя"
                directionText={SORT_DIRECTION_TEXT}
              />
              <SortableTh
                sortKey="status"
                activeKey={sortKey}
                direction={direction}
                onSort={handleSort}
                label="Статус"
                directionText={SORT_DIRECTION_TEXT}
              />
              <SortableTh
                sortKey="players"
                activeKey={sortKey}
                direction={direction}
                onSort={handleSort}
                label="Игроки"
                directionText={SORT_DIRECTION_TEXT}
                align="right"
              />
              <Th>RCON</Th>
              <Th>Последний опрос</Th>
              {/*
                Колонок «Карта / слой» и «CPU / RAM» здесь больше нет: обе
                печатали константу («не выбрано» и «— / —») — данных под них
                `/api/v1/servers` не отдаёт. Две колонки, которые никогда ничего
                не сообщают, отнимали ширину у тех, что сообщают.
              */}
              <Th align="right">Действия</Th>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((s) => (
              <ServerTableRow key={s.id} server={s} onAction={onRefresh} />
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function ServerTableRow({ server, onAction }: { server: ServerRow; onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = SERVER_STATUS[server.status] ?? {
    label: server.status,
    state: 'idle' as StatusState,
  };
  const rcon =
    server.status === 'running'
      ? (RCON_STATUS[server.rcon_state ?? 'not_polled'] ?? {
          label: server.rcon_state ?? 'неизвестно',
          state: 'idle' as StatusState,
        })
      : { label: '—', state: 'idle' as StatusState };
  const players = server.status === 'running' ? `${server.player_count ?? '—'}` : '—';

  async function restart() {
    if (busy) return;
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
      setConfirmOpen(false);
    }
  }

  return (
    <TableRow interactive>
      <Td>
        <Link href={`/servers/${server.id}`} className="block min-w-0 no-underline">
          <span className="block truncate font-medium text-ink">{server.display_name}</span>
          <span className="block truncate text-2xs text-ink-3">{server.slug}</span>
        </Link>
      </Td>
      <Td>
        <StatusDot state={status.state} label={status.label} size="sm" />
      </Td>
      <Td numeric>{players}</Td>
      <Td>
        <StatusDot state={rcon.state} label={rcon.label} size="sm" />
      </Td>
      <Td className="text-xs text-ink-3">
        {server.last_poll_at ? <RelativeTime ts={server.last_poll_at} /> : '—'}
      </Td>
      <Td align="right">
        <div className="inline-flex items-center gap-1">
          <ButtonLink href={`/servers/${server.id}`} size="sm">
            Открыть
          </ButtonLink>
          <Button
            size="sm"
            loading={busy}
            onClick={() => setConfirmOpen(true)}
            disabled={server.status !== 'running'}
            title={
              server.status !== 'running'
                ? 'Доступно только для работающих серверов'
                : 'Перезапустить контейнер'
            }
          >
            Перезапуск
          </Button>
        </div>
        {error ? (
          <span role="alert" className="mt-1 block text-2xs text-crit">
            {error}
          </span>
        ) : null}
        {/*
          Перезапуск отключает игроков, но ничего не стирает, поэтому тон
          обычный: критический цвет кнопки дизайн-система оставляет за
          необратимым разрушением данных (§5).
        */}
        <AlertDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Перезапустить сервер"
          body={`«${server.display_name}» перезапустится, все игроки будут отключены. Сохранённые данные не пострадают.`}
          confirmLabel="Перезапустить"
          cancelLabel="Отмена"
          tone="default"
          busy={busy}
          onConfirm={restart}
        />
      </Td>
    </TableRow>
  );
}

/** Относительное время, которое пересчитывается раз в пять секунд. */
function RelativeTime({ ts }: { ts: string }) {
  const locale = useIntlLocale();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <DateTime
      value={ts}
      locale={locale}
      mode="relative"
      now={now}
      relativeLabels={RELATIVE_LABELS}
      fallback="—"
    />
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
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);
  const bridgeConnected = bridge?.connected === true;
  /*
   * `bridge === null` — статус ещё не пришёл, `connected: false` — пришёл и
   * говорит, что метрик не будет. Без этого различия карточка вечно крутила
   * четыре скелетона: агент лежит, данные не придут никогда, а панель делает
   * вид, что вот-вот загрузит.
   */
  const bridgeDown = bridge !== null && !bridgeConnected;
  const noMetrics = info === null || metrics === null;

  return (
    <Card as="section" padding="none" className="flex h-full flex-col">
      <CardHeader
        title="Хост"
        actions={
          <StatusBadge
            state={HEALTH_STATE[health.level]}
            label={HEALTH_LABEL[health.level]}
            size="sm"
          />
        }
      />

      <CardBody className="space-y-1 border-b border-line">
        <p className="truncate text-[13px] font-semibold text-ink">
          {info?.hostname ?? (
            <span className="font-normal text-ink-3">
              {bridgeDown ? 'Хост не опознан' : 'Нет данных'}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-ink-3">
          {info ? (
            <>
              {info.os_name} {info.os_version} · {info.arch} · аптайм{' '}
              {formatUptime(info.uptime_seconds)}
            </>
          ) : bridgeDown ? (
            'Имя, ОС и аптайм читает агент — он не отвечает.'
          ) : (
            'Загружаем сведения о хосте…'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1 text-xs text-ink-3">
          <StatusDot
            state={bridgeConnected ? 'good' : 'crit'}
            size="sm"
            label={
              bridgeConnected
                ? `Bridge подключён${bridge?.version ? ` (v${bridge.version})` : ''}`
                : 'Bridge недоступен'
            }
          />
          <LiveIndicator
            lastUpdate={metrics?.sampled_at ? new Date(metrics.sampled_at) : lastUpdate}
          />
          <DockerPruneButton
            disabled={!bridgeConnected}
            disabledReason="Сначала восстановите соединение."
          />
          <RestartBridgeButton
            disabled={!bridgeConnected}
            disabledReason="Сначала восстановите соединение."
          />
        </div>
      </CardBody>

      <CardBody className={noMetrics && bridgeDown ? undefined : 'grid gap-4 sm:grid-cols-2'}>
        {noMetrics ? (
          bridgeDown ? (
            <InlineBanner
              tone="warn"
              title="Метрики хоста недоступны"
              description="Агент panel-host-bridge не отвечает, поэтому CPU, память, диск и сеть панели неоткуда взять. Запустите агент на хосте — плитки заполнятся сами."
            />
          ) : (
            <>
              <Skeleton variant="card" count={2} label="Загружаем метрики хоста" />
              <Skeleton variant="card" count={2} />
            </>
          )
        ) : (
          <>
            <CpuTile info={info} metrics={metrics} onOpen={() => setOpenMetric('cpu')} />
            <RamTile metrics={metrics} onOpen={() => setOpenMetric('ram')} />
            {/* Идентификатор нужен сценарию e2e, который открывает детализацию диска. */}
            <div data-testid="disk-card">
              <DiskTile metrics={metrics} diskBreakdown={diskBreakdown} onOpen={onDiskClick} />
            </div>
            <NetworkTile metrics={metrics} onOpen={() => setOpenMetric('net')} />
          </>
        )}
      </CardBody>

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
    </Card>
  );
}

function CpuTile({
  info,
  metrics,
  onOpen,
}: {
  info: HostInfo;
  metrics: HostMetrics;
  onOpen: () => void;
}) {
  const pct = Math.max(0, Math.min(100, metrics.cpu_percent));
  const tone = THRESHOLD_TILE_TONE[thresholdTone(pct / 100, 0.8, 0.95)];
  const cpuLabel = info.cpu_model && info.cpu_model !== 'unknown' ? info.cpu_model : null;
  const value = `${metrics.cpu_percent.toFixed(1)}%`;
  return (
    <StatTile
      label="CPU"
      size="sm"
      value={value}
      hint={cpuLabel ? `${cpuLabel} · ${info.cpu_cores} ядер` : `${info.cpu_cores} ядер`}
      tone={tone}
      progress={{ pct }}
      onClick={onOpen}
      actionLabel={`CPU ${value} — открыть график за 24 часа`}
    />
  );
}

function RamTile({ metrics, onOpen }: { metrics: HostMetrics; onOpen: () => void }) {
  const total = metrics.ram_total_bytes;
  if (total <= 0) {
    return (
      <StatTile
        label="RAM"
        size="sm"
        value="Нет данных"
        hint="Метрика не пришла"
        onClick={onOpen}
        actionLabel="RAM: нет данных — открыть график за 24 часа"
      />
    );
  }
  const r = ratio(metrics.ram_used_bytes, total);
  const value = formatPercent(metrics.ram_used_bytes, total);
  return (
    <StatTile
      label="RAM"
      size="sm"
      value={value}
      hint={`${formatBytes(metrics.ram_used_bytes)} из ${formatBytes(total)}`}
      tone={THRESHOLD_TILE_TONE[thresholdTone(r, 0.7, 0.85)]}
      progress={{ pct: r * 100 }}
      onClick={onOpen}
      actionLabel={`RAM ${value} — открыть график за 24 часа`}
    />
  );
}

function DiskTile({
  metrics,
  diskBreakdown,
  onOpen,
}: {
  metrics: HostMetrics;
  diskBreakdown: DiskBreakdown | null;
  onOpen: () => void;
}) {
  const total = metrics.disk_total_bytes;
  if (total <= 0) {
    return (
      <StatTile
        label="Диск"
        size="sm"
        value="Нет данных"
        hint="Метрика не пришла"
        onClick={onOpen}
        actionLabel="Диск: нет данных — открыть детализацию"
      />
    );
  }
  const r = ratio(metrics.disk_used_bytes, total);
  const usedPct = r * 100;
  const tone = THRESHOLD_TILE_TONE[thresholdTone(r, 0.75, 0.9)];
  const value = formatPercent(metrics.disk_used_bytes, total);
  const panelPct = diskBreakdown ? Math.min(diskBreakdown.panel_pct, usedPct) : 0;
  const otherPct = diskBreakdown ? Math.max(0, usedPct - panelPct) : 0;
  return (
    <StatTile
      label="Диск"
      size="sm"
      value={value}
      hint={`${formatBytes(metrics.disk_used_bytes)} из ${formatBytes(total)}`}
      tone={tone}
      progress={
        diskBreakdown
          ? {
              segments: [
                { pct: otherPct, tone: 'neutral', label: 'Прочее' },
                { pct: panelPct, tone: 'accent', label: 'Панель' },
              ],
            }
          : { pct: usedPct }
      }
      onClick={onOpen}
      actionLabel={`Диск ${value} — открыть детализацию`}
    />
  );
}

function NetworkTile({ metrics, onOpen }: { metrics: HostMetrics; onOpen: () => void }) {
  const rx = formatBytesPerSec(metrics.net_rx_bytes_per_sec);
  const tx = formatBytesPerSec(metrics.net_tx_bytes_per_sec);
  return (
    <StatTile
      label="Сеть, приём"
      size="sm"
      value={rx}
      hint={`Отдача ${tx}`}
      onClick={onOpen}
      actionLabel={`Сеть: приём ${rx}, отдача ${tx} — открыть график за 24 часа`}
    />
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
    <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line px-4 py-3">
      <SystemCell label="Ядро" value={kernel} />
      <SystemCell label="Docker" value={docker} />
      <SystemCell label="IP" value={ip} />
      <SystemCell label="Средняя загрузка" value={load} />
    </dl>
  );
}

function SystemCell({ label, value }: { label: string; value: string }) {
  const isMissing = value === 'нет данных';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* Служебный ярлык над значением — единственное место, где §1 разрешает
          заглавные буквы. */}
      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className={`truncate text-xs ${isMissing ? 'text-ink-3' : 'text-ink-2'}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function RecentActivity({
  rows,
  loading,
  filter,
  onFilter,
}: {
  rows: AuditRow[];
  loading: boolean;
  filter: ActivityFilter;
  onFilter: (f: ActivityFilter) => void;
}) {
  const filtered = useMemo(
    () => rows.filter((r) => matchesActivityFilter(r, filter)),
    [rows, filter],
  );
  return (
    <Card as="section" padding="none" className="flex h-full flex-col">
      <CardHeader
        title="Последние действия"
        count={`${filtered.length}/${rows.length}`}
        actions={
          <ButtonLink href="/audit" variant="plain" size="sm">
            Журнал действий
          </ButtonLink>
        }
      />
      <CardBody padding="sm" className="border-b border-line">
        <Toolbar
          filters={
            <SegmentedControl
              ariaLabel="Фильтр событий"
              size="sm"
              value={filter}
              onChange={(value) => onFilter(value as ActivityFilter)}
              items={ACTIVITY_FILTERS.map((f) => ({
                value: f,
                label: ACTIVITY_FILTER_LABEL[f],
              }))}
            />
          }
        />
      </CardBody>
      {loading ? (
        <CardBody>
          <SkeletonTable rows={5} cols={4} label="Загружаем последние действия" />
        </CardBody>
      ) : filtered.length === 0 ? (
        <EmptyState
          variant={rows.length === 0 ? 'initial' : 'filtered'}
          title={rows.length === 0 ? 'Действий пока нет' : 'Под фильтр ничего не подходит'}
          description={
            rows.length === 0
              ? 'Как только в панели что-то произойдёт, событие появится здесь.'
              : 'Выберите другой фильтр или покажите все события.'
          }
          action={
            rows.length === 0 ? undefined : (
              <Button size="sm" onClick={() => onFilter('all')}>
                Сбросить фильтр
              </Button>
            )
          }
        />
      ) : (
        <Table dense maxHeight="320px" ariaLabel="Последние действия">
          <TableHead>
            <tr>
              <Th>Время</Th>
              <Th>Кто</Th>
              <Th>Событие</Th>
              <Th>Цель</Th>
              <Th align="right">Итог</Th>
            </tr>
          </TableHead>
          <TableBody>
            {filtered.map((ev) => (
              <ActivityRow key={ev.id} ev={ev} />
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function ActivityRow({ ev }: { ev: AuditRow }) {
  const locale = useIntlLocale();
  const severity = severityFromStatus(ev.status_code);
  const time = new Date(ev.created_at);
  const targetLabel = ev.target_type
    ? `${ev.target_type}${ev.target_id ? ` · ${ev.target_id.slice(0, 8)}` : ''}`
    : '—';
  // Без `interactive`: строка журнала никуда не ведёт, а этот флаг примитив
  // резервирует за строками со ссылкой в первой ячейке.
  return (
    <TableRow>
      <Td className="whitespace-nowrap text-xs tabular-nums text-ink-3">
        {formatClock(time, locale) ?? '—'}
      </Td>
      <Td className="text-xs text-ink-2">{ACTOR_KIND_LABEL[ev.actor_kind] ?? ev.actor_kind}</Td>
      <Td className="text-xs text-ink">{ev.action_type}</Td>
      <Td className="text-xs text-ink-3">
        <span className="block max-w-[160px] truncate" title={targetLabel}>
          {targetLabel}
        </span>
      </Td>
      <Td align="right">
        <SeverityBadge severity={severity} statusCode={ev.status_code} />
      </Td>
    </TableRow>
  );
}

function SeverityBadge({
  severity,
  statusCode,
}: {
  severity: 'info' | 'warning' | 'critical';
  statusCode: number | null;
}) {
  const tone = severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'neutral';
  const label =
    severity === 'critical' ? 'критично' : severity === 'warning' ? 'предупреждение' : 'инфо';
  return (
    <Badge tone={tone} size="sm" title={statusCode != null ? `HTTP ${statusCode}` : 'нет статуса'}>
      {label}
    </Badge>
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
  state: StatusState;
  status: string;
  detail?: string;
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
    status: pgState === 'ok' ? 'здоров' : pgState ? 'недоступен' : 'нет данных',
    state: pgState === 'ok' ? 'good' : pgState ? 'crit' : 'idle',
  });

  const redisState = ready?.checks.redis;
  rows.push({
    key: 'redis',
    group: 'core',
    name: 'Redis',
    status: redisState === 'ok' ? 'здоров' : redisState ? 'недоступен' : 'нет данных',
    state: redisState === 'ok' ? 'good' : redisState ? 'crit' : 'idle',
  });

  rows.push({
    key: 'bridge',
    group: 'core',
    name: 'panel-host-bridge',
    status: bridge?.connected ? 'подключён' : (bridge?.error ?? 'отключён'),
    detail: bridge?.connected
      ? `RTT ${bridge.round_trip_ms ?? '?'} мс${bridge.version ? ` · v${bridge.version}` : ''}`
      : undefined,
    state: bridge?.connected ? 'good' : 'crit',
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
        status: 'нет heartbeat',
        state: 'crit',
      });
      continue;
    }
    const state: StatusState =
      w.age_ms > WORKER_STALE_MS ? 'crit' : w.age_ms > WORKER_OK_MS ? 'warn' : 'good';
    rows.push({
      key: `worker-${name}`,
      group: 'workers',
      name: `worker-${name}`,
      status: w.status ?? 'жив',
      detail: `${Math.round(w.age_ms / 1000)}с назад · pid ${w.pid}`,
      state,
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
  const summaryState: StatusState =
    healthyCount === totalCount ? 'good' : healthyCount > 0 ? 'warn' : 'crit';
  const core = rows.filter((r) => r.group === 'core');
  const workers = rows.filter((r) => r.group === 'workers');

  return (
    <Card as="section" padding="none" className="flex h-full flex-col">
      <CardHeader
        title="Соединения"
        actions={
          <StatusBadge
            state={summaryState}
            label={`${healthyCount} из ${totalCount} здоровы`}
            size="sm"
          />
        }
      />
      <CardBody className="space-y-4">
        <ConnectionGroup label="Базовые службы" rows={core} />
        <ConnectionGroup
          label="Воркеры"
          rows={workers}
          footnote={
            bridgeConnected
              ? 'Перезапуск воркеров выполняется через docker compose.'
              : 'Bridge оффлайн — состояние воркеров может быть устаревшим.'
          }
        />
      </CardBody>
    </Card>
  );
}

function ConnectionGroup({
  label,
  rows,
  footnote,
}: {
  label: string;
  rows: ConnectionRow[];
  footnote?: string;
}) {
  return (
    <section className="space-y-2">
      {/* Смысловой заголовок раздела, поэтому обычный регистр, а не капслок (§1). */}
      <h3 className="text-xs font-semibold text-ink-2">{label}</h3>
      <ul className="divide-y divide-line overflow-hidden rounded-ctl border border-line">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 px-2.5 py-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{r.name}</span>
            <StatusDot state={r.state} label={r.status} size="sm" />
            {r.detail ? (
              <span className="shrink-0 whitespace-nowrap text-2xs text-ink-3" title={r.detail}>
                {r.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {footnote ? <p className="text-2xs text-ink-3">{footnote}</p> : null}
    </section>
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
