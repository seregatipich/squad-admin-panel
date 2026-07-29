'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  allMatchesHref,
  formatMatchDate,
  formatMatchDuration,
  type MatchSummary,
  outcomeLabel,
  outcomeToneClasses,
  serverLabel,
  winratePercent,
  winrateSummaryText,
} from './recent-matches';

export function RecentMatchesSection({ playerId }: { playerId: string }) {
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/match-summary`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: MatchSummary) => {
        if (!cancelled) setSummary(body);
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

  const percent = summary ? winratePercent(summary.winrate) : null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Последние матчи
          {summary && summary.winrate.considered > 0 ? (
            <span
              className="ml-2 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 tabular-nums"
              title={`Победы за последние ${summary.winrate.window} матчей`}
            >
              {winrateSummaryText(summary.winrate)}
              {percent !== null ? ` · ${percent}%` : ''}
            </span>
          ) : null}
        </h2>
        <Link
          href={allMatchesHref(playerId)}
          className="text-xs font-mono text-sky-400 hover:text-sky-300"
        >
          Все матчи →
        </Link>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : !summary || summary.recent.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          <p>У этого игрока пока нет сыгранных матчей.</p>
          <p className="mt-1 text-xs text-neutral-600">
            История матчей ведётся с момента, когда панель начала учитывать матчи на серверах.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="p-1 text-left">Дата</th>
                <th className="p-1 text-left">Сервер</th>
                <th className="p-1 text-left">Layer</th>
                <th className="p-1 text-left">Участие</th>
                <th className="p-1 text-left">Исход</th>
              </tr>
            </thead>
            <tbody>
              {summary.recent.map((match) => (
                <tr key={match.match_id} className="border-t border-neutral-900 align-middle">
                  <td className="whitespace-nowrap p-1 font-mono text-neutral-400">
                    <Link
                      href={`/matches/${match.match_id}`}
                      className="hover:text-sky-300"
                      title="Открыть матч"
                    >
                      {formatMatchDate(match.started_at)}
                    </Link>
                  </td>
                  <td className="p-1">
                    <span
                      title={match.server_name ?? undefined}
                      className="inline-block rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200"
                    >
                      {serverLabel(match)}
                    </span>
                  </td>
                  <td className="p-1 text-neutral-200">{match.layer ?? '—'}</td>
                  <td className="p-1 font-mono text-neutral-300">
                    {formatMatchDuration(match.play_seconds)}
                  </td>
                  <td className="p-1">
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${outcomeToneClasses(
                        match.outcome,
                      )}`}
                    >
                      {outcomeLabel(match.outcome)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
