'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { type PlayerVoteStats, serialSkipperLabel } from './votes';

export function VotesSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<PlayerVoteStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/vote-stats`, { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: PlayerVoteStats) => {
        if (!cancelled) setData(body);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Голосования</h2>
        {data?.serial_skipper.flagged ? (
          <span
            title={serialSkipperLabel(data.serial_skipper)}
            className="inline-flex items-center gap-1.5 rounded border border-red-900 bg-red-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-300"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            Серийный скипер
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading || !data ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                Инициировал
              </div>
              <div className="mt-1 font-mono text-2xl text-neutral-100 tabular-nums">
                {data.initiated.toLocaleString('ru-RU')}
              </div>
            </div>
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                Участвовал
              </div>
              <div className="mt-1 font-mono text-2xl text-neutral-100 tabular-nums">
                {data.participated.toLocaleString('ru-RU')}
              </div>
            </div>
          </div>

          {data.serial_skipper.flagged ? (
            <div className="rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-200">
              {serialSkipperLabel(data.serial_skipper)}
            </div>
          ) : (
            <div className="text-[11px] text-neutral-500">
              Скипов за {data.serial_skipper.window_days} дн.:{' '}
              <span className="font-mono text-neutral-300">{data.serial_skipper.skip_count}</span>{' '}
              (порог {data.serial_skipper.threshold})
            </div>
          )}

          <Link href="/votes" className="inline-block text-[11px] text-sky-400 hover:text-sky-300">
            лог голосований →
          </Link>
        </>
      )}
    </section>
  );
}
