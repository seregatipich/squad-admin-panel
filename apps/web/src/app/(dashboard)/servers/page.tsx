'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { formatSeedProgress, type SeedingSummary } from './seeding-format';

interface Server {
  id: string;
  display_name: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
  rcon_state: string | null;
  player_count: number | null;
  last_poll_at: string | null;
  tags?: string[];
  seeding: SeedingSummary | null;
}

interface ServersResponse {
  items: Server[];
  total: number;
}

const POLL_MS = 120_000;

export default function ServersPage() {
  const [data, setData] = useState<ServersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ServersResponse;
        if (!cancelled) {
          setData(j);
          setErr(null);
          setLastUpdate(new Date());
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const onStatus = useCallback((event: { data: { server_id: string; status: string } }) => {
    setData((prev) => {
      if (!prev) return prev;
      const idx = prev.items.findIndex((s) => s.id === event.data.server_id);
      if (idx < 0) return prev;
      const items = prev.items.slice();
      items[idx] = { ...items[idx], status: event.data.status };
      return { ...prev, items };
    });
    setLastUpdate(new Date());
  }, []);
  useLiveSubscription('server.status', onStatus);

  const onDeleted = useCallback((event: { data: { server_id: string } }) => {
    setData((prev) => {
      if (!prev) return prev;
      const items = prev.items.filter((s) => s.id !== event.data.server_id);
      if (items.length === prev.items.length) return prev;
      return { items, total: items.length };
    });
    setLastUpdate(new Date());
  }, []);
  useLiveSubscription('server.deleted', onDeleted);

  const onRcon = useCallback(
    (event: { data: { server_id: string; state: string; player_count?: number } }) => {
      setData((prev) => {
        if (!prev) return prev;
        const idx = prev.items.findIndex((s) => s.id === event.data.server_id);
        if (idx < 0) return prev;
        const items = prev.items.slice();
        items[idx] = {
          ...items[idx],
          rcon_state: event.data.state,
          player_count:
            event.data.player_count != null ? event.data.player_count : items[idx].player_count,
        };
        return { ...prev, items };
      });
      setLastUpdate(new Date());
    },
    [],
  );
  useLiveSubscription('rcon.status', onRcon);

  const onSeeding = useCallback(
    (event: {
      data: {
        server_id: string;
        state: 'seeding' | 'live';
        current_players: number;
        live_at: number;
        progress_pct: number;
        started_at: string | null;
      };
    }) => {
      setData((prev) => {
        if (!prev) return prev;
        const idx = prev.items.findIndex((s) => s.id === event.data.server_id);
        if (idx < 0) return prev;
        const items = prev.items.slice();
        items[idx] = {
          ...items[idx],
          seeding: {
            state: event.data.state,
            current_players: event.data.current_players,
            live_at: event.data.live_at,
            progress_pct: event.data.progress_pct,
            started_at: event.data.started_at,
          },
        };
        return { ...prev, items };
      });
      setLastUpdate(new Date());
    },
    [],
  );
  useLiveSubscription('server.seeding', onSeeding);

  const allTags = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.items.flatMap((s) => s.tags ?? [])));
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    let filtered = data.items;
    if (tagFilter) {
      filtered = filtered.filter((s) => (s.tags ?? []).includes(tagFilter));
    }
    const needle = q.trim().toLowerCase();
    if (!needle) return filtered;
    return filtered.filter(
      (s) =>
        s.display_name.toLowerCase().includes(needle) ||
        s.slug.toLowerCase().includes(needle) ||
        s.id.toLowerCase().includes(needle),
    );
  }, [data, q, tagFilter]);

  async function runAction(id: string, action: 'start' | 'stop' | 'restart') {
    setActingId(`${id}:${action}`);
    try {
      const r = await fetch(`/api/v1/servers/${id}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) setErr(`${action} failed: HTTP ${r.status} ${await r.text()}`);
    } finally {
      setActingId(null);
    }
  }

  if (!data && !err) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Серверы</h1>
        <div className="flex items-center gap-3">
          <LiveIndicator lastUpdate={lastUpdate} />
          <Link
            href="/servers/new"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
          >
            + Установить новый
          </Link>
        </div>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по имени, slug или id…"
          className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm"
        />
        {allTags.length > 0 && (
          <select
            value={tagFilter ?? ''}
            onChange={(e) => setTagFilter(e.target.value || null)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm"
          >
            <option value="">Все теги</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          {data?.items.length ? 'Нет совпадений.' : 'Нет серверов.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2 w-8"></th>
                <th className="text-left p-2">Имя</th>
                <th className="text-left p-2">Игроков</th>
                <th className="text-left p-2">RCON</th>
                <th className="text-left p-2">Последний опрос</th>
                <th className="text-left p-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-900">
                  <td className="p-2">
                    <StatusDot status={row.status} />
                  </td>
                  <td className="p-2">
                    <Link
                      href={`/servers/${row.id}`}
                      className="text-sky-400 hover:text-sky-300 font-medium"
                    >
                      {row.display_name}
                    </Link>
                    <div className="text-[11px] text-neutral-500 font-mono">{row.slug}</div>
                    {(row.tags ?? []).length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {(row.tags ?? []).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="p-2 font-mono text-sm">
                    {row.player_count == null ? '—' : row.player_count}
                    {row.seeding?.state === 'seeding' && (
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-sans text-amber-400">
                          Сидинг
                        </span>
                        <span className="text-[10px] font-sans text-neutral-500">
                          {formatSeedProgress(row.seeding.current_players, row.seeding.live_at)}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="p-2 text-xs">
                    <span
                      className={
                        row.rcon_state === 'connected' ? 'text-emerald-400' : 'text-neutral-500'
                      }
                    >
                      {row.rcon_state ?? '—'}
                    </span>
                  </td>
                  <td className="p-2 text-xs text-neutral-500">
                    {row.last_poll_at ? new Date(row.last_poll_at).toLocaleTimeString() : '—'}
                  </td>
                  <td className="p-2">
                    <ActionButtons
                      status={row.status}
                      id={row.id}
                      actingKey={actingId}
                      run={runAction}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-red-500'
        : status === 'starting' || status === 'stopping' || status === 'installing'
          ? 'bg-amber-500'
          : 'bg-neutral-600';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} title={status} />;
}

function ActionButtons({
  status,
  id,
  actingKey,
  run,
}: {
  status: string;
  id: string;
  actingKey: string | null;
  run: (id: string, action: 'start' | 'stop' | 'restart') => void;
}) {
  const canStart = status !== 'running' && status !== 'starting' && status !== 'installing';
  const canStop = status === 'running' || status === 'starting';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={!canStart || !!actingKey}
        onClick={() => run(id, 'start')}
        className="rounded bg-sky-700 px-2 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {actingKey === `${id}:start` ? '…' : '▶'}
      </button>
      <button
        type="button"
        disabled={!canStop || !!actingKey}
        onClick={() => run(id, 'stop')}
        className="rounded bg-amber-700 px-2 py-1 text-xs text-white hover:bg-amber-600 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {actingKey === `${id}:stop` ? '…' : '■'}
      </button>
      <button
        type="button"
        disabled={!canStop || !!actingKey}
        onClick={() => run(id, 'restart')}
        className="rounded bg-neutral-700 px-2 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {actingKey === `${id}:restart` ? '…' : '↻'}
      </button>
      <Link
        href={`/servers/${id}`}
        className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 ml-1"
      >
        открыть
      </Link>
    </div>
  );
}
