'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtDuration } from './presence';

interface CoplayPartner {
  player_id: string;
  player_name: string | null;
  overlap_seconds: number;
  shared_session_count: number;
}

interface CoplayResponse {
  partners: CoplayPartner[];
}

/** ALT-6 co-play card block, gated by the existing panel_access API route. */
export function PlaysWithSection({ playerId }: { playerId: string }) {
  const [partners, setPartners] = useState<CoplayPartner[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/players/${playerId}/coplay`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          if (!cancelled) setHidden(true);
          return null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as CoplayResponse;
      })
      .then((body) => {
        if (!cancelled && body) setPartners(body.partners.slice(0, 10));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  if (hidden) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Часто играет с</h2>
        <Link
          href={`/players/${playerId}/compare`}
          className="text-xs text-sky-400 hover:text-sky-300"
        >
          Сравнить онлайн →
        </Link>
      </div>
      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : partners === null ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : partners.length === 0 ? (
        <div className="text-sm text-neutral-500">
          Совместных игровых сессий выше порога не найдено.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {partners.map((partner) => (
            <li
              key={partner.player_id}
              className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5 text-sm"
            >
              <Link
                href={`/players/${partner.player_id}`}
                className="font-medium text-sky-400 hover:text-sky-300"
              >
                {partner.player_name ?? '—'}
              </Link>
              <span className="text-xs text-neutral-500">
                {fmtDuration(partner.overlap_seconds)} вместе
              </span>
              <span className="text-xs text-neutral-500">
                {partner.shared_session_count} сессий
              </span>
              <Link
                href={`/players/${playerId}/compare?other=${encodeURIComponent(partner.player_id)}`}
                className="ml-auto text-xs text-sky-400 hover:text-sky-300"
              >
                Сравнить онлайн
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
