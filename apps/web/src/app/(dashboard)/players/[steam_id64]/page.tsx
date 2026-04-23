'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

interface Player {
  steam_id64: string;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

interface NameHistory {
  name: string;
  name_normalized: string;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

interface IpHistory {
  ip: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface PlayerResponse {
  player: Player;
  names: NameHistory[];
  ips: IpHistory[];
  ips_visible: boolean;
}

export default function PlayerDetail({ params }: { params: Promise<{ steam_id64: string }> }) {
  const { steam_id64 } = use(params);
  const [data, setData] = useState<PlayerResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/v1/players/${steam_id64}`, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, [steam_id64]);

  if (err) {
    return (
      <div>
        <Link href="/players" className="text-sky-400 text-xs">
          ← игроки
        </Link>
        <div className="mt-3 rounded border border-red-900 bg-red-950 p-3 text-sm">
          Ошибка: {err}
        </div>
      </div>
    );
  }
  if (!data) return <div className="text-neutral-500">Загрузка…</div>;

  const { player, names, ips, ips_visible } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/players" className="text-sky-400 hover:text-sky-300 text-xs font-mono">
          ← игроки
        </Link>
        <h1 className="text-2xl font-semibold">{player.canonical_name}</h1>
      </div>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Профиль</h2>
        <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-sm">
          <dt className="text-neutral-500">SteamID64</dt>
          <dd className="font-mono">
            <a
              href={`https://steamcommunity.com/profiles/${player.steam_id64}`}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              {player.steam_id64}
            </a>
          </dd>
          <dt className="text-neutral-500">EOS ID</dt>
          <dd className="font-mono">{player.eos_id ?? '—'}</dd>
          <dt className="text-neutral-500">First seen</dt>
          <dd>{new Date(player.first_seen_at).toLocaleString()}</dd>
          <dt className="text-neutral-500">Last seen</dt>
          <dd>{new Date(player.last_seen_at).toLocaleString()}</dd>
          <dt className="text-neutral-500">Total playtime</dt>
          <dd className="font-mono">{fmtDuration(player.total_time_played_seconds)}</dd>
        </dl>
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          История ников ({names.length})
        </h2>
        {names.length === 0 ? (
          <div className="text-neutral-500 text-sm">только основной ник</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-1">Ник</th>
                <th className="text-left p-1">Виделся N раз</th>
                <th className="text-left p-1">Первый раз</th>
                <th className="text-left p-1">Последний раз</th>
              </tr>
            </thead>
            <tbody>
              {names.map((n) => (
                <tr key={n.name_normalized} className="border-t border-neutral-900">
                  <td className="p-1 font-medium">{n.name}</td>
                  <td className="p-1 font-mono">{n.observation_count}</td>
                  <td className="p-1 text-neutral-500">
                    {new Date(n.first_seen_at).toLocaleString()}
                  </td>
                  <td className="p-1 text-neutral-500">
                    {new Date(n.last_seen_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {ips_visible ? (
        <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">
            История IP ({ips.length})
          </h2>
          {ips.length === 0 ? (
            <div className="text-neutral-500 text-sm">пока пусто</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="text-left p-1">IP</th>
                  <th className="text-left p-1">Первый раз</th>
                  <th className="text-left p-1">Последний раз</th>
                </tr>
              </thead>
              <tbody>
                {ips.map((ip) => (
                  <tr key={ip.ip} className="border-t border-neutral-900">
                    <td className="p-1 font-mono">{ip.ip}</td>
                    <td className="p-1 text-neutral-500">
                      {new Date(ip.first_seen_at).toLocaleString()}
                    </td>
                    <td className="p-1 text-neutral-500">
                      {new Date(ip.last_seen_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : (
        <section className="rounded border border-neutral-800 bg-neutral-950 p-4 text-xs text-neutral-500">
          У вас нет разрешения <code className="text-neutral-300">player:view_ips</code> — IP скрыт.
        </section>
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
