'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { A2SIndicator } from '@/components/A2SIndicator';
import { AdminsCfgDriftBanner } from '@/components/AdminsCfgDriftBanner';
import { BroadcastComposer } from '@/components/BroadcastComposer';
import { CrashBadge } from '@/components/CrashBadge';
import { ForceStopDialog } from '@/components/ForceStopDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { LogConsole, type LogEntry } from '@/components/LogConsole';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { nextBackoffMs } from '@/lib/ws-backoff';
import type { SeedingSummary } from '../seeding-format';
import { ChatPanel } from './ChatPanel';
import { LivePlayers } from './live-players';
import { MapWidget } from './map-widget';
import { SeedingBadge } from './SeedingBadge';

interface ServerRow {
  id: string;
  display_name: string;
  slug: string;
  status: string;
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
  a2s_status?: A2sStatus | null;
  crash_loop?: boolean;
  crash_count?: number;
  seeding?: SeedingSummary | null;
}

const POLL_INTERVAL_MS = 3000;

export default function ServerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<ServerResponse | null>(null);
  const [canChat, setCanChat] = useState(false);
  const [canChangeMap, setCanChangeMap] = useState(false);
  const [canBan, setCanBan] = useState(false);
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
        const me = (await res.json()) as { squad_permissions?: string[] };
        if (!cancelled) {
          setCanChat(me.squad_permissions?.includes('chat') ?? false);
          setCanChangeMap(me.squad_permissions?.includes('changemap') ?? false);
          setCanBan(me.squad_permissions?.includes('ban') ?? false);
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
  const logsEnabled =
    currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping';

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
        router.push(`/servers/archive/${id}`);
        return;
      }
      await refresh();
    } finally {
      setActing(null);
    }
  }

  if (err && !data) {
    return (
      <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">Ошибка: {err}</div>
    );
  }
  if (!data) return <div className="text-neutral-500">Загрузка…</div>;

  const { server, settings, rcon_status, container, host } = data;
  const canStart = server.status !== 'running' && server.status !== 'starting';
  const canStop = server.status === 'running' || server.status === 'starting';
  const startedAt = container?.running ? container.started_at : null;
  const uptimeMs = startedAt ? Math.max(0, now - new Date(startedAt).getTime()) : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{server.display_name}</h1>
            <StatusBadge status={server.status} />
            <A2SIndicator a2sStatus={data.a2s_status ?? null} serverStatus={server.status} />
            <CrashBadge crashLoop={data.crash_loop ?? false} crashCount={data.crash_count ?? 0} />
            <SeedingBadge serverId={server.id} initial={data.seeding ?? null} />
          </div>
          <div className="flex items-center gap-3 text-xs text-neutral-500">
            <span className="font-mono">{server.id}</span>
            {uptimeMs != null && startedAt ? (
              <>
                <span className="text-neutral-700">·</span>
                <span title={`Запущен: ${new Date(startedAt).toLocaleString()}`}>
                  uptime {formatUptime(uptimeMs)}
                </span>
              </>
            ) : null}
            {container?.restart_count ? (
              <>
                <span className="text-neutral-700">·</span>
                <span title="Счётчик авто-перезапусков Docker">
                  рестартов: {container.restart_count}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <LiveIndicator lastUpdate={lastRefreshedAt} />
          <Link
            href={`/servers/${server.id}/configs`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            Конфиги →
          </Link>
          <Link
            href={`/servers/${server.id}/rotation`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            Ротация →
          </Link>
          <Link
            href={`/servers/${server.id}/settings`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            Настройки →
          </Link>
          <Link
            href={`/servers/${server.id}/monitoring`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            Мониторинг →
          </Link>
          <Link
            href={`/servers/${server.id}/events`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            События →
          </Link>
        </div>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <AdminsCfgDriftBanner serverId={server.id} />

      {data.crash_loop && (
        <div className="mb-4 rounded border border-red-900 bg-red-950 p-3 text-sm text-red-300">
          Сервер в цикле аварий — автоперезапуск отключён. Проверьте логи и запустите вручную.
        </div>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
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
        <Stat
          label="Tickrate"
          value={
            rcon_status.tickrate_rt != null
              ? `${rcon_status.tickrate_rt.toFixed(1)} / ${settings?.tickrate ?? '—'}`
              : settings?.tickrate != null
                ? `${settings.tickrate}`
                : '—'
          }
          hint={
            rcon_status.tickrate_rt != null
              ? 'Фактический / целевой tickrate'
              : 'Целевой tickrate (фактический появится в ServerInfo)'
          }
        />
        <Stat
          label="CPU"
          value={container?.cpu_percent != null ? `${container.cpu_percent.toFixed(1)}%` : '—'}
          hint="Нагрузка контейнера Squad"
        />
        <Stat
          label="RAM"
          value={
            container?.mem_used_bytes != null
              ? formatBytes(container.mem_used_bytes) +
                (container.mem_limit_bytes ? ` / ${formatBytes(container.mem_limit_bytes)}` : '')
              : '—'
          }
          hint="Потребление памяти контейнером"
        />
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400 mb-3">Подключение</h2>
        {settings ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 font-mono text-xs">
            <dt className="text-neutral-500">Адрес</dt>
            <dd>{host?.address ?? '—'}</dd>
            <dt className="text-neutral-500">Game</dt>
            <dd>
              {settings.game_port} <span className="text-neutral-600">UDP</span>
            </dd>
            <dt className="text-neutral-500">Query</dt>
            <dd>
              {settings.query_port} <span className="text-neutral-600">UDP</span>
            </dd>
            <dt className="text-neutral-500">Beacon</dt>
            <dd>
              {settings.beacon_port} <span className="text-neutral-600">UDP</span>
            </dd>
            <dt className="text-neutral-500">RCON</dt>
            <dd className="flex items-center gap-2">
              <span>
                {settings.rcon_port} <span className="text-neutral-600">TCP</span>
              </span>
              <RconDot status={rcon_status} />
            </dd>
          </dl>
        ) : (
          <div className="text-neutral-500 text-xs">нет настроек</div>
        )}
      </section>

      <MapWidget serverId={server.id} canChangeMap={canChangeMap} />

      <BroadcastComposer serverId={server.id} canChat={canChat} />

      <LivePlayers serverId={server.id} canChat={canChat} canBan={canBan} />

      <section className="flex flex-wrap items-center gap-2">
        <ActionButton
          label="Старт"
          onClick={() => action('start')}
          disabled={!canStart || !!acting}
          loading={acting === 'start'}
          tone="sky"
        />
        <div className="inline-flex">
          <ActionButton
            label="Стоп (graceful)"
            onClick={() => action('stop')}
            disabled={!canStop || !!acting}
            loading={acting === 'stop'}
            tone="amber"
          />
          <button
            type="button"
            disabled={!canStop || !!acting}
            onClick={() => setForceStopOpen(true)}
            className="rounded-l-none rounded-r border-l border-amber-800 bg-amber-600 px-2 py-2 text-sm text-white hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Принудительная остановка"
          >
            ▾
          </button>
        </div>
        <ActionButton
          label="Рестарт"
          onClick={() => action('restart')}
          disabled={!canStop || !!acting}
          loading={acting === 'restart'}
          tone="neutral"
        />
        {data?.server.status === 'stopped' && (
          <button
            type="button"
            onClick={async () => {
              setActing('update');
              try {
                const r = await fetch(`/api/v1/servers/${id}/update`, {
                  method: 'POST',
                  credentials: 'include',
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setActing(null);
              }
            }}
            disabled={acting !== null}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-sky-700 hover:text-sky-300 disabled:opacity-40"
          >
            {acting === 'update' ? 'Обновление...' : 'Обновить игру'}
          </button>
        )}
        <div className="ml-auto">
          <DangerMenu
            disabled={!!acting}
            onDelete={() => {
              if (
                confirm(
                  'Удалить сервер? Файлы на диске будут стёрты, бэкап .cfg сохранится в Архиве серверов.',
                )
              ) {
                void action('delete');
              }
            }}
            deleting={acting === 'delete'}
          />
        </div>
      </section>

      <section>
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
              ? `Сервер в состоянии "${server.status}" — контейнер ещё не создан. Запустите установку, чтобы журнал появился.`
              : server.status === 'running' || server.status === 'starting'
                ? 'Подключение к логу контейнера…'
                : 'Сервер остановлен — здесь будут последние 200 строк после запуска.'
          }
        />
      </section>

      <section>
        <ChatPanel serverId={id} canBan={canBan} />
      </section>

      <ForceStopDialog
        open={forceStopOpen}
        onOpenChange={setForceStopOpen}
        serverName={data?.server.display_name ?? ''}
        onConfirm={async () => {
          const r = await fetch(`/api/v1/servers/${id}/force-stop`, {
            method: 'POST',
            credentials: 'include',
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          void refresh();
        }}
      />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-3" title={hint}>
      <div className="text-[10px] uppercase tracking-widest text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-mono">{value}</div>
    </div>
  );
}

function RconDot({ status }: { status: RconStatus }) {
  const color =
    status.state === 'connected'
      ? 'bg-green-500'
      : status.state === 'connecting'
        ? 'bg-amber-500'
        : 'bg-neutral-600';
  const label =
    status.state === 'not_polled'
      ? 'сервер не запущен'
      : status.state === 'connecting'
        ? `переподключение${status.backoffMs ? ` (backoff ${Math.round(status.backoffMs / 1000)}с)` : ''}`
        : status.state;
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-neutral-400"
      title={`RCON: ${label}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      <span>{status.state === 'connected' ? 'connected' : label}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-green-700 text-green-100',
    starting: 'bg-amber-700 text-amber-100',
    stopping: 'bg-amber-700 text-amber-100',
    ready: 'bg-sky-700 text-sky-100',
    stopped: 'bg-neutral-800 text-neutral-300',
    installing: 'bg-amber-700 text-amber-100',
    failed: 'bg-red-800 text-red-100',
    pending: 'bg-neutral-800 text-neutral-300',
  };
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-mono uppercase tracking-widest ${colors[status] ?? 'bg-neutral-800 text-neutral-300'}`}
    >
      {status}
    </span>
  );
}

function ActionButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone: 'sky' | 'amber' | 'neutral' | 'red';
}) {
  const toneClass = {
    sky: 'bg-sky-600 hover:bg-sky-500',
    amber: 'bg-amber-600 hover:bg-amber-500',
    neutral: 'bg-neutral-700 hover:bg-neutral-600',
    red: 'bg-red-700 hover:bg-red-600',
  }[props.tone];
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded px-4 py-2 text-sm text-white ${toneClass} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {props.loading ? '…' : props.label}
    </button>
  );
}

function DangerMenu({
  disabled,
  onDelete,
  deleting,
}: {
  disabled: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Опасная зона ▾
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-[12rem] rounded border border-neutral-700 bg-neutral-900 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            disabled={deleting}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="block w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-red-950 disabled:opacity-40"
          >
            {deleting ? 'Удаление…' : 'Удалить сервер'}
          </button>
        </div>
      ) : null}
    </div>
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
