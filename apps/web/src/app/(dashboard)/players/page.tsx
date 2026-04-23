'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

interface Player {
  steam_id64: string;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

interface PlayersResponse {
  items: Player[];
  total: number;
}

const POLL_MS = 8000;
/** Treat a player as "online" when their last_seen_at is within one poll cycle. */
const ONLINE_WINDOW_MS = 90_000;

export default function PlayersPage() {
  const [data, setData] = useState<PlayersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyOnline, setOnlyOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/v1/players', { credentials: 'include', cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!cancelled) {
          setData((await r.json()) as PlayersResponse);
          setErr(null);
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

  const now = Date.now();
  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.items.filter((p) => {
      if (onlyOnline) {
        const age = now - new Date(p.last_seen_at).getTime();
        if (age > ONLINE_WINDOW_MS) return false;
      }
      if (!needle) return true;
      return (
        p.canonical_name.toLowerCase().includes(needle) ||
        p.steam_id64.includes(needle) ||
        (p.eos_id ?? '').toLowerCase().includes(needle)
      );
    });
  }, [data, q, onlyOnline, now]);

  if (!data && !err) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Игроки</h1>
        <div className="text-xs text-neutral-500">
          всего: {data?.total ?? 0} • онлайн сейчас:{' '}
          {data?.items.filter(
            (p) => Date.now() - new Date(p.last_seen_at).getTime() <= ONLINE_WINDOW_MS,
          ).length ?? 0}
        </div>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по нику, SteamID или EOS ID…"
          className="flex-1 min-w-[260px] rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyOnline}
            onChange={(e) => setOnlyOnline(e.target.checked)}
            className="accent-emerald-500"
          />
          только онлайн
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          {data?.items.length
            ? 'Нет совпадений.'
            : 'Ни один игрок ещё не подключался. Запустите сервер и подключитесь в Squad-клиенте.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2 w-8"></th>
                <th className="text-left p-2">Ник</th>
                <th className="text-left p-2">SteamID64</th>
                <th className="text-left p-2">EOS ID</th>
                <th className="text-left p-2">Total playtime</th>
                <th className="text-left p-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const age = Date.now() - new Date(p.last_seen_at).getTime();
                const online = age <= ONLINE_WINDOW_MS;
                return (
                  <tr key={p.steam_id64} className="border-t border-neutral-900">
                    <td className="p-2">
                      <span
                        className={`inline-block h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-neutral-600'}`}
                        title={online ? 'online' : 'offline'}
                      />
                    </td>
                    <td className="p-2">
                      <Link
                        href={`/players/${p.steam_id64}`}
                        className="text-sky-400 hover:text-sky-300 font-medium"
                      >
                        {p.canonical_name}
                      </Link>
                    </td>
                    <td className="p-2 font-mono text-xs">
                      <a
                        href={`https://steamcommunity.com/profiles/${p.steam_id64}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-300 hover:text-sky-300"
                      >
                        {p.steam_id64}
                      </a>
                    </td>
                    <td className="p-2 font-mono text-[11px] text-neutral-400">
                      {p.eos_id ?? '—'}
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {fmtDuration(p.total_time_played_seconds)}
                    </td>
                    <td className="p-2 text-xs text-neutral-500">
                      {online ? (
                        <span className="text-emerald-400">сейчас на сервере</span>
                      ) : (
                        new Date(p.last_seen_at).toLocaleString()
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtDuration(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
