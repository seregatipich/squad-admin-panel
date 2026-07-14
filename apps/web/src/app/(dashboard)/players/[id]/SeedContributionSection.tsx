'use client';

import { useEffect, useState } from 'react';

import {
  buildSeedContributionUrl,
  formatSeedDuration,
  parseSeedContribution,
  type SeedContributionResponse,
  serverLabel,
  sortServersBySeedSeconds,
} from './seed-contribution';

export function SeedContributionSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<SeedContributionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(buildSeedContributionUrl(playerId), { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      })
      .then((body) => {
        if (cancelled || !body) return;
        const parsed = parseSeedContribution(body);
        if (!parsed) throw new Error('invalid response shape');
        setData(parsed);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  if (hidden) return null;

  const servers = data ? sortServersBySeedSeconds(data.by_server) : [];

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Сид-вклад</h2>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки сид-вклада: {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="py-6 text-center text-sm text-neutral-500">Загрузка…</div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-xs uppercase tracking-widest text-neutral-500">
                Сид ({data.window.days} дней)
              </div>
              <div className="mt-1 font-mono text-2xl text-sky-300">
                Сид: {formatSeedDuration(data.total_seed_seconds)}
              </div>
              <div className="text-[11px] text-neutral-500">
                {data.window.from} — {data.window.to}
              </div>
            </div>

            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-xs uppercase tracking-widest text-neutral-500">
                Бонусы за сид
              </div>
              <div className="mt-1 font-mono text-2xl text-emerald-300">
                Начислено бонусов: {data.bonus.earned_points}
              </div>
              <div className="text-[11px] text-neutral-500">
                коэффициент k_seed: <span className="text-neutral-400">{data.bonus.k_seed}</span>
              </div>
            </div>
          </div>

          {servers.length === 0 ? (
            <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              Нет данных о сид-вкладе по серверам.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead className="text-xs uppercase tracking-widest text-neutral-500">
                  <tr>
                    <th className="p-1 text-left">Сервер</th>
                    <th className="p-1 text-right">Сид</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((server) => (
                    <tr key={server.server_id} className="border-t border-neutral-900">
                      <td className="p-1">
                        <span
                          title={server.server_name ?? undefined}
                          className="inline-block rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200"
                        >
                          {serverLabel(server)}
                        </span>
                      </td>
                      <td className="p-1 text-right font-mono text-sky-300">
                        {formatSeedDuration(server.seed_seconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
