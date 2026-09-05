'use client';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { A2SIndicator } from '@/components/A2SIndicator';
import { AdminsCfgDriftBanner } from '@/components/AdminsCfgDriftBanner';
import { BroadcastComposer } from '@/components/BroadcastComposer';
import { CrashBadge } from '@/components/CrashBadge';
import { ForceStopDialog } from '@/components/ForceStopDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { LogConsole, type LogEntry } from '@/components/LogConsole';
import { ServerLogFiles } from '@/components/ServerLogFiles';
import { UpdateProgressModal } from '@/components/UpdateProgressModal';
import {
  AlertDialog,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardGrid,
  CardHeader,
  ChevronDownIcon,
  formatAbsolute,
  GroupedList,
  GroupedRow,
  IconButton,
  InlineBanner,
  Menu,
  PageContainer,
  Skeleton,
  SkeletonTable,
  StatTile,
  StatusBadge,
  StatusDot,
  type StatusState,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { nextBackoffMs } from '@/lib/ws-backoff';
import type { SeedingSummary } from '../seeding-format';
import { ChatPanel } from './ChatPanel';
import { LivePlayers } from './live-players';
import { MapWidget } from './map-widget';
import { SeedCallButton } from './SeedCallButton';
import { SeedingBadge } from './SeedingBadge';

interface ServerRow {
  id: string;
  display_name: string;
  slug: string;
  status: string;
  /** `external` — размещён вне панели: нет контейнера, логов и конфигов, только RCON/A2S. */
  runtime?: string;
  created_at: string;
  updated_at: string;
}

interface ServerSettings {
  server_id: string;
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
  max_players: number;
  tickrate: number;
  multihome: string;
  install_path: string;
  seed_live_at?: number;
  seed_hysteresis?: number;
}

interface RconStatus {
  state: 'connected' | 'disconnected' | 'connecting' | 'not_polled';
  ts?: string;
  player_count?: number;
  last_poll_at?: string;
  backoffMs?: number;
  tickrate_rt?: number;
  current_map?: string;
}

interface ContainerRuntime {
  state: string;
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  image: string | null;
  pid: number | null;
  restart_count: number;
  exit_code: number;
  cpu_percent?: number;
  mem_used_bytes?: number;
  mem_limit_bytes?: number;
}

interface HostInfo {
  address: string;
  hostname: string;
}

interface A2sStatus {
  visible: boolean;
  server_name?: string;
  latency_ms?: number;
  reason?: string;
}

interface ServerResponse {
  server: ServerRow;
  settings: ServerSettings | null;
  rcon_status: RconStatus;
  container: ContainerRuntime | null;
  host: HostInfo | null;
  /** Только у внешнего сервера: куда панель ходит по RCON. */
  connection?: { rcon_host: string | null; rcon_port: number | null } | null;
  a2s_status?: A2sStatus | null;
  crash_loop?: boolean;
  crash_count?: number;
  seeding?: SeedingSummary | null;
}

const POLL_INTERVAL_MS = 3000;

/**
 * Состояние контейнера словами и тоном. Английские `running`/`stopped` в
 * русском интерфейсе не остаются: тон дублируется подписью (§5), а незнакомое
 * значение показывается как есть, а не молча теряется.
 */
const STATUS_VIEW: Record<string, { state: StatusState; label: string }> = {
  running: { state: 'good', label: 'работает' },
  starting: { state: 'warn', label: 'запускается' },
  stopping: { state: 'warn', label: 'останавливается' },
  installing: { state: 'warn', label: 'устанавливается' },
  ready: { state: 'idle', label: 'готов к запуску' },
  stopped: { state: 'idle', label: 'остановлен' },
  pending: { state: 'idle', label: 'ожидает' },
  failed: { state: 'crit', label: 'сбой' },
};

/** Состояние соединения RCON словами — подпись точки в строке «Порт RCON». */
function rconView(status: RconStatus): { state: StatusState; label: string } {
  if (status.state === 'connected') return { state: 'good', label: 'подключён' };
  if (status.state === 'connecting') {
    const backoff = status.backoffMs ? ` (пауза ${Math.round(status.backoffMs / 1000)} с)` : '';
    return { state: 'warn', label: `переподключение${backoff}` };
  }
  if (status.state === 'not_polled') return { state: 'idle', label: 'сервер не запущен' };
  return { state: 'crit', label: 'нет связи' };
}

/**
 * Операционный экран сервера: то, на что оператор смотрит во время матча.
 *
 * Блоки идут по частоте обращения, а не по истории появления: сначала
 * состояние сервера и карта, затем ростер и чат, затем то, что оператор
 * отправляет игрокам, и только внизу — служебное (адрес, порты, журналы),
 * которое читают один раз при настройке.
 *
 * `<h1>` с именем сервера принадлежит `layout.tsx`; здесь только заголовки
 * разделов.
 */
export default function ServerDetail({ params }: { params: Promise<{ id: string }> }) {
  const locale = useIntlLocale();
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<ServerResponse | null>(null);
  const [canChat, setCanChat] = useState(false);
  const [canManageServer, setCanManageServer] = useState(false);
  const [canChangeMap, setCanChangeMap] = useState(false);
  const [canBan, setCanBan] = useState(false);
  const [canDownloadLogs, setCanDownloadLogs] = useState(false);
  const [modPermissions, setModPermissions] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLive, setLogsLive] = useState(false);
  const [logsError, setLogsError] = useState<{
    code: number | null;
    reason: string | null;
    retryInMs: number | null;
  } | null>(null);
  const [forceStopOpen, setForceStopOpen] = useState(false);
  const [dangerMenuOpen, setDangerMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateRunning, setUpdateRunning] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/v1/servers/${id}`, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as ServerResponse);
      setLastRefreshedAt(Date.now());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh closes over `id`
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const me = (await res.json()) as { squad_permissions?: string[]; permissions?: string[] };
        if (!cancelled) {
          setCanChat(me.squad_permissions?.includes('chat') ?? false);
          setCanManageServer(me.squad_permissions?.includes('manageserver') ?? false);
          setCanChangeMap(me.squad_permissions?.includes('changemap') ?? false);
          setCanBan(me.squad_permissions?.includes('ban') ?? false);
          setCanDownloadLogs(me.permissions?.includes('server:download_logs') ?? false);
          setModPermissions((me.permissions ?? []).filter((key) => key.startsWith('mod:')));
        }
      } catch {
        // permission fetch is best-effort; chat UI simply stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onLiveStatus = useCallback(
    (event: { data: { server_id: string; status: string } }) => {
      if (event.data.server_id !== id) return;
      setData((prev) =>
        prev ? { ...prev, server: { ...prev.server, status: event.data.status } } : prev,
      );
      setLastRefreshedAt(Date.now());
    },
    [id],
  );
  useLiveSubscription('server.status', onLiveStatus);

  const currentStatus = data?.server.status ?? null;
  const isExternal = data?.server.runtime === 'external';
  // У внешнего сервера нет контейнера, а значит и потока docker logs.
  const logsEnabled =
    !isExternal &&
    (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping');

  useEffect(() => {
    if (!logsEnabled) {
      setLogsLive(false);
      setLogsError(null);
      reconnectNowRef.current = null;
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_AUTO_ATTEMPTS = 5;

    function clearBackoff() {
      if (backoffTimer != null) {
        clearTimeout(backoffTimer);
        backoffTimer = null;
      }
    }

    function scheduleReconnect() {
      if (cancelled) return;
      if (attempts >= MAX_AUTO_ATTEMPTS) {
        setLogsError((prev) => (prev ? { ...prev, retryInMs: null } : prev));
        return;
      }
      const delay = nextBackoffMs(attempts);
      attempts++;
      clearBackoff();
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        open();
      }, delay);
    }

    function reconnectNow() {
      if (cancelled) return;
      clearBackoff();
      attempts = 0;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      open();
    }

    function open() {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${window.location.host}/api/v1/servers/${id}/logs/ws?lines=200`,
      );
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        attempts = 0;
        clearBackoff();
        setLogsLive(true);
        setLogsError(null);
      };
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(ev.data) as LogEntry & {
            error?: string;
            done?: boolean;
            heartbeat?: boolean;
          };
          if (frame.heartbeat) return;
          if (frame.error) {
            setLogs((prev) => [
              ...prev,
              {
                ts: new Date().toISOString(),
                stream: 'stderr',
                message: `[log-stream] ${frame.error}`,
              },
            ]);
            return;
          }
          if (frame.done) return;
          setLogs((prev) => {
            const next = [...prev, frame];
            return next.length > 2000 ? next.slice(-2000) : next;
          });
        } catch {
          // ignore malformed frame
        }
      };
      ws.onclose = (ev) => {
        if (cancelled) return;
        setLogsLive(false);
        const willRetry = attempts < MAX_AUTO_ATTEMPTS;
        const nextDelay = willRetry ? nextBackoffMs(attempts) : null;
        const code = typeof ev.code === 'number' ? ev.code : null;
        const reason =
          (ev.reason && ev.reason.length > 0 ? ev.reason : null) ??
          (ev.wasClean === false ? 'abnormal_closure' : null);
        setLogsError((prev) => {
          if (
            prev &&
            prev.code === code &&
            prev.reason === reason &&
            prev.retryInMs === nextDelay
          ) {
            return prev;
          }
          return { code, reason, retryInMs: nextDelay };
        });
        scheduleReconnect();
      };
      ws.onerror = () => {
        setLogsLive(false);
      };
    }

    reconnectNowRef.current = reconnectNow;

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectNow();
      }
    };
    const onOnline = () => reconnectNow();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    open();

    return () => {
      cancelled = true;
      clearBackoff();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      reconnectNowRef.current = null;
      wsRef.current?.close();
    };
  }, [id, logsEnabled]);

  async function action(name: 'start' | 'stop' | 'restart' | 'delete') {
    setActing(name);
    try {
      const method = name === 'delete' ? 'DELETE' : 'POST';
      const r = await fetch(`/api/v1/servers/${id}${name === 'delete' ? '' : `/${name}`}`, {
        method,
        credentials: 'include',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      });
      if (!r.ok) {
        const text = await r.text();
        setErr(`${name} failed: HTTP ${r.status} ${text}`);
      } else if (name === 'delete') {
        // У внешнего сервера нет резервной копии конфигов — в архиве смотреть нечего.
        router.push(isExternal ? '/servers' : `/servers/archive/${id}`);
        return;
      }
      await refresh();
    } finally {
      setActing(null);
    }
  }

  if (err && !data) {
    return (
      <PageContainer>
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить сервер"
          description={err}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      </PageContainer>
    );
  }
  if (!data) {
    return (
      <PageContainer>
        <Skeleton variant="block" label="Загружается состояние сервера" />
        <CardGrid cols={4}>
          <Skeleton variant="card" />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </CardGrid>
        <SkeletonTable rows={6} cols={6} />
      </PageContainer>
    );
  }

  const { server, settings, rcon_status, container, host } = data;
  const external = server.runtime === 'external';
  const canStart = server.status !== 'running' && server.status !== 'starting';
  const canStop = server.status === 'running' || server.status === 'starting';
  const startedAt = container?.running ? container.started_at : null;
  const uptimeMs = startedAt ? Math.max(0, now - new Date(startedAt).getTime()) : null;
  const statusView = STATUS_VIEW[server.status] ?? {
    state: 'idle' as StatusState,
    label: server.status,
  };
  const rcon = rconView(rcon_status);

  return (
    <PageContainer>
      {err ? (
        <InlineBanner
          tone="crit"
          title="Данные на экране могли устареть"
          description={err}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <AdminsCfgDriftBanner serverId={server.id} />

      {data.crash_loop ? (
        <InlineBanner
          tone="crit"
          title="Сервер в цикле аварий — автоперезапуск отключён"
          description="Проверьте журнал контейнера и запустите сервер вручную."
        />
      ) : null}

      {/* 1. Состояние и карта — то, ради чего экран открывают во время матча. */}
      <Card padding="none" as="section">
        <CardHeader title="Состояние" actions={<LiveIndicator lastUpdate={lastRefreshedAt} />} />
        <CardBody>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge state={statusView.state} label={statusView.label} />
            <A2SIndicator a2sStatus={data.a2s_status ?? null} serverStatus={server.status} />
            <CrashBadge crashLoop={data.crash_loop ?? false} crashCount={data.crash_count ?? 0} />
            <SeedingBadge serverId={server.id} initial={data.seeding ?? null} />
            {uptimeMs != null && startedAt ? (
              <span className="text-xs text-ink-3" title={formatAbsolute(startedAt, locale) ?? ''}>
                В работе {formatUptime(uptimeMs)}
              </span>
            ) : null}
            {container?.restart_count ? (
              <span className="text-xs text-ink-3" title="Счётчик авто-перезапусков Docker">
                Перезапусков: {container.restart_count}
              </span>
            ) : null}
          </div>
        </CardBody>
        <CardFooter>
          {/* Опасное действие отодвинуто в правый край и не соседствует с
              «Рестартом»: промах мышью не должен стоить сервера. */}
          {external ? (
            <p className="mr-auto text-xs text-ink-3">
              Внешний сервер: запуск и остановка выполняются на его хосте, панель управляет им по
              RCON.
            </p>
          ) : (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => action('start')}
                disabled={!canStart || !!acting}
                loading={acting === 'start'}
              >
                Старт
              </Button>
              <div className="flex items-center gap-1">
                <Button
                  onClick={() => action('stop')}
                  disabled={!canStop || !!acting}
                  loading={acting === 'stop'}
                >
                  Стоп
                </Button>
                <IconButton
                  icon={<ChevronDownIcon />}
                  label="Принудительная остановка"
                  disabled={!canStop || !!acting}
                  onClick={() => setForceStopOpen(true)}
                />
              </div>
              <Button
                onClick={() => action('restart')}
                disabled={!canStop || !!acting}
                loading={acting === 'restart'}
              >
                Рестарт
              </Button>
              {server.status === 'stopped' || updateRunning ? (
                <Button
                  onClick={async () => {
                    if (updateRunning) {
                      setUpdateModalOpen(true);
                      return;
                    }
                    setActing('update');
                    try {
                      const r = await fetch(`/api/v1/servers/${id}/update`, {
                        method: 'POST',
                        credentials: 'include',
                      });
                      if (!r.ok) throw new Error(`HTTP ${r.status}`);
                      setUpdateRunning(true);
                      setUpdateModalOpen(true);
                    } catch (e) {
                      setErr((e as Error).message);
                    } finally {
                      setActing(null);
                    }
                  }}
                  disabled={acting !== null}
                >
                  {acting === 'update'
                    ? 'Запуск обновления...'
                    : updateRunning
                      ? 'Обновление... (открыть лог)'
                      : 'Обновить игру'}
                </Button>
              ) : null}
            </div>
          )}
          <Menu
            trigger={{ label: 'Опасная зона' }}
            open={dangerMenuOpen}
            onOpenChange={setDangerMenuOpen}
            align="end"
            items={[
              {
                kind: 'action',
                label: 'Удалить сервер',
                hint: external ? 'Сервер будет убран из панели' : 'Файлы на диске будут стёрты',
                tone: 'destructive',
                disabled: !!acting,
                onSelect: () => setDeleteOpen(true),
              },
            ]}
          />
        </CardFooter>
      </Card>

      <CardGrid cols={4}>
        <StatTile
          label="Игроки"
          value={
            rcon_status.player_count != null
              ? `${rcon_status.player_count} / ${settings?.max_players ?? '—'}`
              : '—'
          }
          hint={
            rcon_status.state === 'connected'
              ? 'Онлайн-счётчик RCON (обновляется каждые 30 с)'
              : 'Доступно при подключении RCON'
          }
        />
        <StatTile
          label="Тикрейт"
          value={
            rcon_status.tickrate_rt != null
              ? `${rcon_status.tickrate_rt.toFixed(1)} / ${settings?.tickrate ?? '—'}`
              : settings?.tickrate != null
                ? `${settings.tickrate}`
                : '—'
          }
          hint={
            rcon_status.tickrate_rt != null
              ? 'Фактический / целевой тикрейт'
              : 'Целевой тикрейт (фактический появится в ServerInfo)'
          }
        />
        {external ? (
          <>
            <StatTile
              label="RCON"
              value={
                data.connection?.rcon_host
                  ? `${data.connection.rcon_host}:${data.connection.rcon_port ?? '—'}`
                  : '—'
              }
              hint="Адрес внешнего сервера, к которому подключена панель"
            />
            <StatTile
              label="Опрос A2S"
              value={settings ? `UDP ${settings.query_port}` : '—'}
              hint="Порт запросов для проверки видимости сервера"
            />
          </>
        ) : (
          <>
            <StatTile
              label="CPU"
              value={container?.cpu_percent != null ? `${container.cpu_percent.toFixed(1)}%` : '—'}
              hint="Нагрузка контейнера Squad"
            />
            <StatTile
              label="RAM"
              value={
                container?.mem_used_bytes != null
                  ? formatBytes(container.mem_used_bytes) +
                    (container.mem_limit_bytes
                      ? ` / ${formatBytes(container.mem_limit_bytes)}`
                      : '')
                  : '—'
              }
              hint="Потребление памяти контейнером"
            />
          </>
        )}
      </CardGrid>

      <MapWidget serverId={server.id} canChangeMap={canChangeMap} />

      {/* 2. Ростер и чат — работа с людьми, которые сейчас на сервере. */}
      <LivePlayers
        serverId={server.id}
        canChat={canChat}
        canBan={canBan}
        modPermissions={modPermissions}
      />

      <ChatPanel serverId={id} canBan={canBan} />

      {/* 3. Объявление — то, что оператор отправляет в игру. */}
      <BroadcastComposer serverId={server.id} canChat={canChat} />

      <SeedCallButton serverId={server.id} canCall={canChat || canManageServer} />

      {/* 4. Служебное: адрес и порты читают один раз при настройке. */}
      <GroupedList
        title="Подключение"
        footnote={
          external
            ? 'Адрес, порты и пароль RCON внешнего сервера меняются в его настройках.'
            : 'Адрес и порты задаются при установке сервера и меняются в его настройках.'
        }
      >
        {settings ? (
          <>
            <GroupedRow
              label="Адрес"
              control={<span className="font-mono">{host?.address ?? '—'}</span>}
            />
            <GroupedRow
              label="Игровой порт"
              description="UDP"
              control={<span className="font-mono">{settings.game_port}</span>}
            />
            <GroupedRow
              label="Порт запросов"
              description="UDP"
              control={<span className="font-mono">{settings.query_port}</span>}
            />
            {external ? null : (
              <GroupedRow
                label="Порт маяка"
                description="UDP"
                control={<span className="font-mono">{settings.beacon_port}</span>}
              />
            )}
            <GroupedRow
              label="Порт RCON"
              description="TCP"
              control={
                <>
                  <span className="font-mono">{settings.rcon_port}</span>
                  <StatusDot state={rcon.state} label={rcon.label} size="sm" />
                </>
              }
            />
          </>
        ) : (
          <GroupedRow label="Настройки не заданы" description="Сервер ещё не установлен" />
        )}
      </GroupedList>

      {external ? null : (
        <>
          <LogConsole
            lines={logs}
            height="32rem"
            title="Лог контейнера (docker logs)"
            live={logsLive}
            errorBanner={
              logsError && logsEnabled
                ? {
                    code: logsError.code,
                    reason: logsError.reason,
                    retryInMs: logsError.retryInMs,
                    onRetry: () => reconnectNowRef.current?.(),
                  }
                : null
            }
            emptyText={
              !logsEnabled
                ? `Сервер в состоянии «${statusView.label}» — контейнер ещё не создан. Запустите установку, чтобы журнал появился.`
                : server.status === 'running' || server.status === 'starting'
                  ? 'Подключение к логу контейнера…'
                  : 'Сервер остановлен — здесь будут последние 200 строк после запуска.'
            }
          />

          <ServerLogFiles serverId={id} canDownload={canDownloadLogs} />
        </>
      )}

      <UpdateProgressModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление игры"
        onDone={() => {
          setUpdateRunning(false);
          void refresh();
        }}
      />

      <ForceStopDialog
        open={forceStopOpen}
        onOpenChange={setForceStopOpen}
        serverName={server.display_name}
        onConfirm={async () => {
          const r = await fetch(`/api/v1/servers/${id}/force-stop`, {
            method: 'POST',
            credentials: 'include',
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          void refresh();
        }}
      />

      {/* Удаление стирает файлы сервера с диска, поэтому здесь стоит ввод
          точного имени — необратимую операцию нельзя запустить не глядя. */}
      <AlertDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Удалить сервер"
        body={
          external
            ? 'Сервер будет убран из панели: опрос RCON остановится, история игроков останется. На хосте самого сервера ничего не изменится.'
            : 'Файлы сервера на диске будут стёрты. Резервная копия .cfg останется в архиве серверов.'
        }
        confirmLabel="Удалить сервер"
        cancelLabel="Отмена"
        tone="destructive"
        busy={acting === 'delete'}
        challenge={{
          expected: server.display_name,
          label: 'Введите имя сервера',
          hint: `Ожидается: ${server.display_name}`,
        }}
        onConfirm={async () => {
          await action('delete');
          setDeleteOpen(false);
        }}
      />
    </PageContainer>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
