'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  banStatusBadge,
  formatDate,
  foundBadgeLabel,
  type PlayerExternalBansResponse,
  trustLevelBadgeClass,
  trustLevelLabel,
} from './external-bans';

/**
 * "Внешние банлисты" player-card section (CBAN-3, #108): shows whether this
 * player is known to any external ban source, backed by
 * `GET /api/v1/players/:playerId/external-bans`. Collapsed by default with a
 * badge summarizing active sources; expands to a per-source breakdown with
 * trust-level and ban-status badges. Hidden entirely for viewers without
 * panel access, matching the other player-card sections.
 */
export function ExternalBansSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<PlayerExternalBansResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(`/api/v1/players/${playerId}/external-bans`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as PlayerExternalBansResponse;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
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

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Внешние банлисты</h2>
        <Link
          href="/external-bans"
          className="text-xs text-sky-400 no-underline hover:text-sky-300"
        >
          Все внешние баны →
        </Link>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : !data ? null : (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            disabled={data.total === 0}
            className={`flex w-full items-center justify-between rounded border px-3 py-2 text-sm ${
              data.active_source_count > 0
                ? 'border-red-900 bg-red-950/30 text-red-300'
                : 'border-emerald-900 bg-emerald-950/30 text-emerald-300'
            } ${data.total > 0 ? 'hover:opacity-90' : 'cursor-default'}`}
          >
            <span>
              {data.active_source_count > 0 ? '⚠ ' : '✓ '}
              {foundBadgeLabel(data.active_source_count)}
            </span>
            {data.total > 0 ? (
              <span className="text-xs text-neutral-400">{expanded ? 'Скрыть' : 'Показать'}</span>
            ) : null}
          </button>

          {expanded && data.sources.length > 0 ? (
            <div className="space-y-3">
              {data.sources.map((group) => (
                <div
                  key={group.source.id}
                  className="rounded border border-neutral-900 bg-neutral-900/40 p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {group.source.discord_url ? (
                        <a
                          href={group.source.discord_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-sky-400 hover:text-sky-300"
                        >
                          {group.source.name}
                        </a>
                      ) : (
                        <span className="text-sm text-neutral-200">{group.source.name}</span>
                      )}
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${trustLevelBadgeClass(group.source.trust_level)}`}
                      >
                        {trustLevelLabel(group.source.trust_level)}
                      </span>
                    </div>
                    <span className="text-xs text-neutral-500">
                      {group.active_count > 0
                        ? `Активных банов: ${group.active_count}`
                        : 'Активных банов нет'}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {group.bans.map((ban) => {
                      const status = banStatusBadge(ban);
                      return (
                        <li key={ban.id} className="rounded bg-neutral-950/50 p-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={`rounded px-1.5 py-0.5 ${status.className}`}>
                              {status.label}
                            </span>
                            <span className="text-neutral-500">
                              {formatDate(ban.issued_at)}
                              {ban.expires_at ? ` → ${formatDate(ban.expires_at)}` : ''}
                            </span>
                          </div>
                          {ban.reason ? (
                            <p className="mt-1 text-neutral-300">{ban.reason}</p>
                          ) : null}
                          {ban.admin_name ? (
                            <p className="mt-0.5 text-neutral-500">Админ: {ban.admin_name}</p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
