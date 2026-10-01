'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Pagination,
  SegmentedControl,
  Skeleton,
  Toolbar,
} from '@/components/ui';
import { apiFetch, describeHttpError } from '@/lib/api';
import type { ReportListItem, ReportLiveView, ReportStatus } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { useApiResource } from '@/lib/use-polled-resource';
import {
  buildApiQuery,
  buildQueryString,
  groupPendingByTarget,
  parseFilters,
  STATUS_FILTERS,
  totalPages,
} from './helpers';
import { ReportCard } from './ReportCard';
import { ReportGroupBlock } from './ReportGroupBlock';
import { ReportsAnalytics } from './ReportsAnalytics';
import type { ReportListResponse } from './report-types';

const PAGINATION_LABELS = {
  previous: 'Назад',
  next: 'Вперёд',
  page: (page: number, of: number) => `Страница ${page} из ${of}`,
};

function upsertReport(list: ReportListItem[], incoming: ReportListItem): ReportListItem[] {
  const index = list.findIndex((report) => report.id === incoming.id);
  if (index === -1) return list;
  const next = list.slice();
  next[index] = incoming;
  return next;
}

export function ReportsBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = parseFilters(searchParams);

  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { data: me } = useApiResource<{ can_handle_reports?: boolean }>('/api/v1/me');
  const canHandle = me?.can_handle_reports ?? false;
  const [view, setView] = useState<'queue' | 'analytics'>('queue');

  const navigate = useCallback(
    (partial: Partial<{ status: '' | ReportStatus; page: number }>) => {
      const next = { ...filters, ...partial, page: partial.page ?? 1 };
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const { status: filterStatus, page: filterPage } = filters;
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ReportListResponse>(
        `/api/v1/reports?${buildApiQuery({ status: filterStatus, page: filterPage })}`,
      );
      setReports(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(describeHttpError(e));
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const onReportUpdated = useCallback(
    (event: { data: { report: ReportLiveView } }) => {
      if (filters.page !== 1) return;
      const incoming = event.data.report;
      setReports((prev) => {
        const current = prev.find((report) => report.id === incoming.id);
        if (!current) return prev;
        const matchesFilter = !filters.status || incoming.status === filters.status;
        if (!matchesFilter) return prev.filter((report) => report.id !== incoming.id);
        // The live event only carries ids; keep the resolved names already on screen.
        return upsertReport(prev, { ...current, ...incoming });
      });
    },
    [filters.page, filters.status],
  );
  useLiveSubscription('report.updated', onReportUpdated);

  const pages = totalPages(total);

  // Pending queue: group reports sharing a target into a single block with a
  // mass-resolve action (REPORT-3, #113 P2). Only meaningful with 2+ reports
  // on the same target; singletons render as regular cards.
  const { grouped } = groupPendingByTarget(reports);
  const multiGroups = grouped.filter((g) => g.reports.length > 1);
  const groupedTargetIds = new Set(multiGroups.map((g) => g.target_player_id));
  const showGroups = filters.status === 'pending' && multiGroups.length > 0;
  const renderedGroupTargets = new Set<string>();

  // Аналитике нужна вся ширина операционного экрана, очереди карточек — нет:
  // строка текста жалобы на 1600px читается хуже, чем на 1150px.
  return (
    <PageContainer width={view === 'analytics' ? 'full' : 'wide'}>
      <PageHeader
        title="Жалобы"
        subtitle="Очередь модерации жалоб игроков, отправленных из игры или через панель."
        actions={
          <SegmentedControl
            ariaLabel="Представление жалоб"
            value={view}
            onChange={(value) => setView(value as 'queue' | 'analytics')}
            items={[
              { value: 'queue', label: 'Очередь' },
              { value: 'analytics', label: 'Аналитика' },
            ]}
          />
        }
      />

      {view === 'analytics' ? <ReportsAnalytics /> : null}

      {view !== 'queue' ? null : (
        <>
          <Toolbar
            filters={
              <SegmentedControl
                ariaLabel="Статус жалобы"
                value={filters.status}
                onChange={(value) => navigate({ status: value as '' | ReportStatus })}
                items={STATUS_FILTERS.map((filter) => ({
                  value: filter.value,
                  label: filter.label,
                }))}
              />
            }
            summary={`Найдено: ${total}`}
          />

          {error ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить жалобы"
              description={error}
              action={
                <Button size="sm" onClick={() => void load()}>
                  Повторить
                </Button>
              }
            />
          ) : null}

          {loading ? (
            <Skeleton variant="card" count={3} label="Загрузка жалоб" />
          ) : reports.length === 0 ? (
            <Card padding="none">
              {filters.status ? (
                <EmptyState
                  variant="filtered"
                  title="Жалоб не найдено"
                  description="По выбранному статусу жалоб нет."
                  action={
                    <Button size="sm" onClick={() => navigate({ status: '' })}>
                      Сбросить фильтр
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="Жалоб нет"
                  description="Жалобы игроков появятся здесь сразу после отправки из игры или через панель."
                />
              )}
            </Card>
          ) : (
            <div className="space-y-4">
              {reports.map((report) => {
                if (
                  showGroups &&
                  report.target_player_id &&
                  groupedTargetIds.has(report.target_player_id)
                ) {
                  if (renderedGroupTargets.has(report.target_player_id)) return null;
                  renderedGroupTargets.add(report.target_player_id);
                  const group = multiGroups.find(
                    (g) => g.target_player_id === report.target_player_id,
                  );
                  if (!group) return null;
                  return (
                    <ReportGroupBlock
                      key={group.target_player_id}
                      group={group}
                      canHandle={canHandle}
                      onSaved={load}
                    />
                  );
                }
                return (
                  <ReportCard
                    key={report.id}
                    report={report}
                    canHandle={canHandle}
                    onSaved={load}
                  />
                );
              })}
            </div>
          )}

          {!loading && reports.length > 0 && pages > 1 ? (
            <Pagination
              page={filters.page}
              pageCount={pages}
              onChange={(page) => navigate({ page })}
              labels={PAGINATION_LABELS}
              allowJump
            />
          ) : null}
        </>
      )}
    </PageContainer>
  );
}
