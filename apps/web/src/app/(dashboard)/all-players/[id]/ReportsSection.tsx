'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  Skeleton,
} from '@/components/ui';
import {
  excerpt,
  formatReportDate,
  REPORT_STATUS_LABELS,
  type ReportSummaryStatus,
} from './reports-summary';

const PAGE_SIZE = 10;

/** Ход разбора жалобы — состояние, а не категория: тон повторяет подпись (§5). */
const STATUS_TONE: Record<ReportSummaryStatus, BadgeTone> = {
  pending: 'warn',
  in_review: 'accent',
  resolved: 'good',
  rejected: 'neutral',
};

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

  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

  if (hidden) return null;

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Жалобы на игрока"
        count={total > 0 ? total : undefined}
        actions={
          <ButtonLink href="/reports" variant="plain" size="sm">
            Все жалобы
          </ButtonLink>
        }
      />
      <CardBody>
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить жалобы"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading ? (
          <Skeleton variant="block" count={2} label="Загрузка жалоб" />
        ) : !items || items.length === 0 ? (
          <EmptyState
            title="Жалоб нет"
            description="На этого игрока никто не жаловался через панель."
          />
        ) : (
          <ul className="space-y-2">
            {items.map((report) => (
              <li key={report.id} className="rounded-ctl border border-line p-2 text-[13px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge size="sm" tone={STATUS_TONE[report.status]}>
                    {REPORT_STATUS_LABELS[report.status]}
                  </Badge>
                  <span className="text-xs text-ink-3">{formatReportDate(report.created_at)}</span>
                </div>
                <p className="mt-1 text-ink-2">{excerpt(report.body)}</p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
