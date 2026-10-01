'use client';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminsCfgDriftBanner } from '@/components/AdminsCfgDriftBanner';
import { BroadcastComposer } from '@/components/BroadcastComposer';
import { LogConsole, type LogEntry } from '@/components/LogConsole';
import { ServerLogFiles } from '@/components/ServerLogFiles';
import {
  Button,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
  Skeleton,
  SkeletonTable,
  StatusDot,
  type StatusState,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { useApiResource } from '@/lib/use-polled-resource';
import { nextBackoffMs } from '@/lib/ws-backoff';
import { ChatPanel } from './ChatPanel';
import { LivePlayers } from './live-players';
import { MapWidget } from './map-widget';

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
 * ростер и карта, затем чат и то, что оператор отправляет игрокам, и только
 * внизу — служебное (адрес, порты, журналы), которое читают один раз при
 * настройке. Кнопки жизненного цикла (старт, стоп, удаление) живут в
 * «Настройках» — `settings/ServerControls.tsx`.
 *
 * `<h1>` с именем сервера принадлежит `layout.tsx`; здесь только заголовки
 * разделов.
 */
export default function ServerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Each GET /servers/:id triggers several DB/Redis reads and two privileged
  // bridge RPCs (containerInspect, docker stats), so a slow response must not
  // pile up behind the next poll tick or a live rcon.status/server.status
  // nudge (#633): the hook skips a tick while a request is in flight, and the
  // nudge below passes `skipIfInFlight`. server.status/rcon.status already
  // push every change live; the poll is only a backstop, so it pauses while
  // the tab is hidden instead of hammering the bridge/docker daemon for a
  // screen no one is watching.
  const {
    data = null,
    errorMessage: err,
    refresh,
    setData,
  } = useApiResource<ServerResponse>(`/api/v1/servers/${id}`, {
    intervalMs: POLL_INTERVAL_MS,
    pauseWhenHidden: true,
  });
  // Permission fetch is best-effort; chat UI simply stays hidden without it.
  const { data: me } = useApiResource<{ squad_permissions?: string[]; permissions?: string[] }>(
    '/api/v1/me',
  );
  const canChat = me?.squad_permissions?.includes('chat') ?? false;
  const canChangeMap = me?.squad_permissions?.includes('changemap') ?? false;
  const canBan = me?.squad_permissions?.includes('ban') ?? false;
  const canDownloadLogs = me?.permissions?.includes('server:download_logs') ?? false;
  const canSyncAdminsCfg = me?.permissions?.includes('admin_group:edit') ?? false;
  const modPermissions = useMemo(
    () => (me?.permissions ?? []).filter((key) => key.startsWith('mod:')),
    [me],
  );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLive, setLogsLive] = useState(false);
  const [logsError, setLogsError] = useState<{
    code: number | null;
    reason: string | null;
    retryInMs: number | null;
  } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);

  const onLiveStatus = useCallback(
    (event: { data: { server_id: string; status: string } }) => {
      if (event.data.server_id !== id) return;
      setData((prev) =>
        prev ? { ...prev, server: { ...prev.server, status: event.data.status } } : prev,
      );
    },
    [id],
  );
  useLiveSubscription('server.status', onLiveStatus);

  // worker-rcon публикует `rcon.status`, только когда меняется то, что здесь
  // видно (игроки, карта, следующий слой, очередь), — перечитываем карточку
  // сразу, не дожидаясь очередного тика опроса.
  const onLiveRcon = useCallback(
    (event: { data: { server_id: string } }) => {
      if (event.data.server_id === id) void refresh({ skipIfInFlight: true });
    },
    [id, refresh],
  );
  useLiveSubscription('rcon.status', onLiveRcon);

  const currentStatus = data?.server.status ?? null;
  const isExternal = data?.server.runtime === 'external';
  // У внешнего сервера нет контейнера, а значит и потока docker logs.
  const containerLogsExist =
    !isExternal &&
    (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping');
  // В потоке те же строки, что в SquadGame.log, вместе с IP игроков, поэтому
  // API пускает к нему только с server:download_logs (#1239).
  const logsEnabled = containerLogsExist && canDownloadLogs;

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
      // CLOSING falls through deliberately: a socket mid-close still has its
      // own onclose pending, and letting `open()` replace `wsRef.current`
      // right now would orphan that old socket — its onclose would still
      // fire, see `wsRef.current !== ws` below, and no longer re-schedule a
      // reconnect for it, but only because every handler checks identity
      // first (#632).
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      open();
    }

    function open() {
      if (cancelled) return;
      // Never leave the previous socket's handlers live once a new one
      // takes over `wsRef.current`: without this a CLOSING socket's onclose
      // would still fire after a replacement is already connected, scheduling
      // a spurious extra reconnect and leaving two sockets appending frames
      // (#632).
      const previous = wsRef.current;
      if (previous) {
        previous.onopen = null;
        previous.onmessage = null;
        previous.onclose = null;
        previous.onerror = null;
        previous.close();
      }
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${window.location.host}/api/v1/servers/${id}/logs/ws?lines=200`,
      );
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled || wsRef.current !== ws) return;
        attempts = 0;
        clearBackoff();
        setLogsLive(true);
        setLogsError(null);
        // The server always backfills the last 200 lines on connect
        // (#631) — starting from an empty buffer keeps a reconnect (backoff,
        // visibilitychange, `online`, or a manual retry) from re-appending
        // up to 200 lines the operator already saw, out of order with
        // whatever arrived since.
        setLogs([]);
      };
      ws.onmessage = (ev) => {
        if (cancelled || wsRef.current !== ws) return;
        try {
          const frame = JSON.parse(ev.data) as LogEntry & {
            error?: string;
            done?: boolean;
            heartbeat?: boolean;
          };
          if (frame.heartbeat) return;
          if (frame.error) {
            setLogs((prev) => {
              const next = [
                ...prev,
                {
                  ts: new Date().toISOString(),
                  stream: 'stderr' as const,
                  message: `[log-stream] ${frame.error}`,
                },
              ];
              return next.length > 2000 ? next.slice(-2000) : next;
            });
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
        if (cancelled || wsRef.current !== ws) return;
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
        if (cancelled || wsRef.current !== ws) return;
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
        <SkeletonTable rows={6} cols={6} />
      </PageContainer>
    );
  }

  const { server, settings, rcon_status, host } = data;
  const external = server.runtime === 'external';
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

      <AdminsCfgDriftBanner serverId={server.id} canSync={canSyncAdminsCfg} />

      {data.crash_loop ? (
        <InlineBanner
          tone="crit"
          title="Сервер в цикле аварий — автоперезапуск отключён"
          description="Проверьте журнал контейнера и запустите сервер вручную в «Настройках»."
        />
      ) : null}

      {/* 1. Ростер — то, ради чего экран открывают во время матча: кто сейчас
          в игре, в каком отряде и что с ним можно сделать. Он стоит выше
          карты, потому что читают его постоянно, а адрес и порты — один раз
          при настройке. Выше него остаются
          только баннеры аварий: предупреждение, уехавшее под список из ста
          строк, никого не предупреждает. */}
      <LivePlayers serverId={server.id} canChat={canChat} modPermissions={modPermissions} />

      {/* 2. Карта — управление матчем, который сейчас идёт. */}
      <MapWidget serverId={server.id} canChangeMap={canChangeMap} />

      {/* 3. Чат и объявления — то, что оператор отправляет в игру. */}
      <ChatPanel serverId={id} canBan={canBan} />

      <BroadcastComposer serverId={server.id} serverName={server.display_name} canChat={canChat} />

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
              containerLogsExist && !canDownloadLogs
                ? 'Лог контейнера доступен только с правом на логи сервера.'
                : !logsEnabled
                  ? `Сервер в состоянии «${statusView.label}» — контейнер ещё не создан. Запустите установку, чтобы журнал появился.`
                  : server.status === 'running' || server.status === 'starting'
                    ? 'Подключение к логу контейнера…'
                    : 'Сервер остановлен — здесь будут последние 200 строк после запуска.'
            }
          />

          <ServerLogFiles serverId={id} canDownload={canDownloadLogs} />
        </>
      )}
    </PageContainer>
  );
}
