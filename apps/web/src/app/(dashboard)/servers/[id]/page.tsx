'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useRef, useState } from 'react';
import { LogConsole, type LogEntry } from '@/components/LogConsole';

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
  install_path: string;
}

interface RconStatus {
  state: 'connected' | 'disconnected' | 'connecting' | 'not_polled';
  ts?: string;
  backoffMs?: number;
}

interface ServerResponse {
  server: ServerRow;
  settings: ServerSettings | null;
  rcon_status: RconStatus;
}

export default function ServerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<ServerResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLive, setLogsLive] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/v1/servers/${id}`, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as ServerResponse);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh closes over `id` and setting a dep on it would cycle
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [id]);

  // Live Squad-server journal. Only opens when the server has a systemd unit
  // (status ∈ running/starting/stopping/stopped/ready). For pending/failed/
  // installing we skip the WebSocket entirely — the backend would close it
  // immediately anyway, and reconnect storms would just spam the API.
  const currentStatus = data?.server.status ?? null;
  const logsEnabled =
    currentStatus === 'running' ||
    currentStatus === 'starting' ||
    currentStatus === 'stopping' ||
    currentStatus === 'stopped' ||
    currentStatus === 'ready';

  useEffect(() => {
    if (!logsEnabled) {
      setLogsLive(false);
      return;
    }
    let cancelled = false;
    let reconnects = 0;
    function open() {
      if (cancelled || reconnects >= 3) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${window.location.host}/api/v1/servers/${id}/logs/ws?lines=200`,
      );
      wsRef.current = ws;
      ws.onopen = () => setLogsLive(true);
      ws.onmessage = (ev) => {
        try {
          const f = JSON.parse(ev.data) as LogEntry & { error?: string; done?: boolean };
          if (f.error) {
            setLogs((prev) => [
              ...prev,
              {
                ts: new Date().toISOString(),
                stream: 'stderr',
                message: `[log-stream] ${f.error}`,
              },
            ]);
            return;
          }
          if (f.done) return;
          setLogs((prev) => {
            const next = [...prev, f];
            return next.length > 2000 ? next.slice(-2000) : next;
          });
        } catch {
          // ignore malformed frame
        }
      };
      ws.onclose = () => {
        setLogsLive(false);
        if (!cancelled) {
          reconnects++;
          setTimeout(open, 2000);
        }
      };
      ws.onerror = () => {
        setLogsLive(false);
      };
    }
    open();
    return () => {
      cancelled = true;
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
        router.push('/servers');
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

  const { server, settings, rcon_status } = data;
  const canStart = server.status !== 'running' && server.status !== 'starting';
  const canStop = server.status === 'running' || server.status === 'starting';
  const rconColor =
    rcon_status.state === 'connected'
      ? 'bg-green-700'
      : rcon_status.state === 'connecting'
        ? 'bg-amber-700'
        : 'bg-neutral-700';

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{server.display_name}</h1>
          <div className="text-xs text-neutral-500 font-mono">{server.id}</div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/servers/${server.id}/configs`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            Конфиги →
          </Link>
          <Link
            href={`/servers/${server.id}/events`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            События →
          </Link>
          <StatusBadge status={server.status} />
        </div>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <section className="grid grid-cols-2 gap-6">
        <div className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">RCON</h2>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${rconColor}`} />
            <span className="text-sm">
              {rcon_status.state === 'not_polled' ? '— (сервер не запущен)' : rcon_status.state}
            </span>
          </div>
          {rcon_status.ts ? (
            <div className="text-xs text-neutral-500">
              обновлено: {new Date(rcon_status.ts).toLocaleString()}
            </div>
          ) : null}
        </div>
        <div className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-1 text-sm">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Порты</h2>
          {settings ? (
            <dl className="grid grid-cols-2 gap-1 font-mono text-xs">
              <dt className="text-neutral-500">Game UDP</dt>
              <dd>{settings.game_port}</dd>
              <dt className="text-neutral-500">Query UDP</dt>
              <dd>{settings.query_port}</dd>
              <dt className="text-neutral-500">Beacon UDP</dt>
              <dd>{settings.beacon_port}</dd>
              <dt className="text-neutral-500">RCON TCP</dt>
              <dd>{settings.rcon_port}</dd>
              <dt className="text-neutral-500">MaxPlayers</dt>
              <dd>{settings.max_players}</dd>
            </dl>
          ) : (
            <div className="text-neutral-500 text-xs">нет настроек</div>
          )}
        </div>
      </section>

      <section className="flex flex-wrap gap-2">
        <ActionButton
          label="Старт"
          onClick={() => action('start')}
          disabled={!canStart || !!acting}
          loading={acting === 'start'}
          tone="sky"
        />
        <ActionButton
          label="Стоп (graceful)"
          onClick={() => action('stop')}
          disabled={!canStop || !!acting}
          loading={acting === 'stop'}
          tone="amber"
        />
        <ActionButton
          label="Рестарт"
          onClick={() => action('restart')}
          disabled={!canStop || !!acting}
          loading={acting === 'restart'}
          tone="neutral"
        />
        <ActionButton
          label="Удалить"
          onClick={() => {
            if (confirm('Удалить сервер из панели? Файлы на диске останутся.'))
              void action('delete');
          }}
          disabled={!!acting}
          loading={acting === 'delete'}
          tone="red"
        />
      </section>

      <section>
        <LogConsole
          lines={logs}
          height="32rem"
          title="Лог контейнера (docker logs)"
          live={logsLive}
          emptyText={
            !logsEnabled
              ? `Сервер в состоянии "${server.status}" — контейнер ещё не создан. Запустите установку, чтобы журнал появился.`
              : server.status === 'running' || server.status === 'starting'
                ? 'Подключение к логу контейнера…'
                : 'Сервер остановлен — здесь будут последние 200 строк после запуска.'
          }
        />
      </section>
    </div>
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
