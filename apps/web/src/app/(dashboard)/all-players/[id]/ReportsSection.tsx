'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  excerpt,
  formatReportDate,
  REPORT_STATUS_BADGE_CLASSES,
  REPORT_STATUS_LABELS,
  type ReportSummaryStatus,
} from './reports-summary';

const PAGE_SIZE = 10;

interface ReportSummaryItem {
  id: string;
  status: ReportSummaryStatus;
  body: string;
  created_at: string;
}

interface ReportListResponse {
  items: ReportSummaryItem[];
  total: number;
}

/**
 * "Жалобы на игрока" player-card section (REPORT-3, #113): lists reports
 * where this player is the target, backed by the existing REPORT-2 list
 * endpoint filtered by `target_player_id`. Hidden entirely for viewers
 * without panel access, matching the other player-card sections.
 */
export function ReportsSection({ playerId }: { playerId: string }) {
  const [items, setItems] = useState<ReportSummaryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(`/api/v1/reports?target_player_id=${playerId}&page_size=${PAGE_SIZE}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ReportListResponse;
      })
      .then((body) => {
        if (!cancelled && body) {
          setItems(body.items);
          setTotal(body.total);
        }
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
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Жалобы на игрока{total > 0 ? ` (${total})` : ''}
        </h2>
        <Link href="/reports" className="text-xs text-sky-400 no-underline hover:text-sky-300">
          Все жалобы →
        </Link>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : !items || items.length === 0 ? (
        <div className="text-sm text-neutral-500">Жалоб на этого игрока нет.</div>
      ) : (
        <ul className="space-y-2">
          {items.map((report) => (
            <li
              key={report.id}
              className="rounded border border-neutral-900 bg-neutral-900/40 p-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${REPORT_STATUS_BADGE_CLASSES[report.status]}`}
                >
                  {REPORT_STATUS_LABELS[report.status]}
                </span>
                <span className="text-xs text-neutral-500">
                  {formatReportDate(report.created_at)}
                </span>
              </div>
              <p className="mt-1 text-neutral-300">{excerpt(report.body)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
