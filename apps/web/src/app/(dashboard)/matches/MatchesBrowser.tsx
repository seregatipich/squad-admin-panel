'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, InlineBanner, Modal, PageContainer, PageHeader } from '@/components/ui';
import { apiFetch, describeHttpError } from '@/lib/api';
import { announcesMatchBoundary } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  appendMatchPage,
  buildCountApiQuery,
  buildExportUrl,
  buildListApiQuery,
  buildQueryString,
  clearMatchListScroll,
  isOpenMatch,
  type MatchFilters,
  type MatchListItem,
  type MatchListScrollSnapshot,
  mergeMatchPage,
  nextSort,
  PAGE_LIMIT,
  parseFilters,
  readMatchListScroll,
  type ServerOption,
  saveMatchListScroll,
  serverOptionsFromMatches,
  shouldDelayMatchScrollRestore,
} from './helpers';
import { MatchFilterPanel } from './MatchFilterPanel';
import { MatchTable } from './MatchTable';
import { parseMatchCount, parseMatchListResponse, parseServerOptions } from './response-parsers';

/*
 * Ссылка на выгрузку остаётся обычным `<a>`, а не `ButtonLink`: `next/link`
 * перехватывает клик и уводит в клиентскую навигацию, из-за чего файл не
 * скачивается. Классы повторяют вторичную кнопку размера `md` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-3 text-xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

export function MatchesBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const currentListHref = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const [items, setItems] = useState<MatchListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [fetchedServers, setFetchedServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  /**
   * Номер последнего запроса первой страницы. Ответ на отменённый запрос —
   * фильтры сменились, кнопку «Повторить» нажали второй раз, страницу закрыли —
   * не имеет права попасть в состояние поверх актуального.
   */
  const listRequestRef = useRef(0);
  const scrollRestoreRef = useRef<MatchListScrollSnapshot | null>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const scrollRestoreLoadAttemptsRef = useRef(0);
  const restoredScrollHrefRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRestoreRef.current = readMatchListScroll(window.sessionStorage, currentListHref);
    restoredScrollHrefRef.current = null;
    scrollRestoreLoadAttemptsRef.current = 0;
  }, [currentListHref]);

  useEffect(
    () => () => {
      if (scrollRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      }
    },
    [],
  );

  const navigate = useCallback(
    (partial: Partial<MatchFilters>) => {
      const nextFilters: MatchFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const loadFirstPage = useCallback(() => {
    listRequestRef.current += 1;
    const requestId = listRequestRef.current;
    const current = () => listRequestRef.current === requestId;
    setLoading(true);
    setError(null);
    // Invalidates any loadMore/refreshHead started under the previous
    // filters/sort immediately, instead of waiting for this request to
    // resolve: their stale cursor or off-filter rows must never reach the
    // list this new first page is about to replace (MATCHES-582).
    setNextCursor(null);
    apiFetch<unknown>(`/api/v1/matches?${buildListApiQuery(filters, { limit: PAGE_LIMIT })}`)
      .then(parseMatchListResponse)
      .then((data) => {
        if (!current()) return;
        setItems(data.items);
        setNextCursor(data.next_cursor);
      })
      .catch((err: unknown) => {
        if (current()) setError(describeHttpError(err));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [filters]);

  useEffect(() => {
    loadFirstPage();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFirstPage]);

  useEffect(() => {
    let cancelled = false;
    setTotal(null);
    apiFetch<unknown>(`/api/v1/matches/count?${buildCountApiQuery(filters)}`)
      .then(parseMatchCount)
      .then((data) => {
        // A failed count request leaves `total` at `null` ("…") rather than
        // folding into 0 — a real 0 and "unknown" are different facts, and
        // showing "всего: 0" for a request that never actually counted
        // anything is misleading.
        if (!cancelled) setTotal(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<unknown>('/api/v1/servers')
      .then(parseServerOptions)
      .then((data) => {
        if (cancelled) return;
        setFetchedServers(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const hasOpenMatch = useMemo(() => items.some(isOpenMatch), [items]);
  useEffect(() => {
    if (!hasOpenMatch) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [hasOpenMatch]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const requestId = listRequestRef.current;
    setLoadingMore(true);
    try {
      const data = parseMatchListResponse(
        await apiFetch<unknown>(
          `/api/v1/matches?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT })}`,
        ),
      );
      // filters/sort changed (a new first page started) while this request
      // was in flight: its cursor and rows belong to the superseded query
      // and must not be spliced onto the list loadFirstPage already replaced
      // (MATCHES-582).
      if (listRequestRef.current !== requestId) return;
      setItems((prev) => appendMatchPage(prev, data.items));
      setNextCursor(data.next_cursor);
    } catch (err) {
      if (listRequestRef.current !== requestId) return;
      setError(describeHttpError(err));
    } finally {
      if (listRequestRef.current === requestId) setLoadingMore(false);
    }
  }, [filters, nextCursor, loadingMore]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  useEffect(() => {
    if (loading) return;
    const snapshot = scrollRestoreRef.current;
    if (!snapshot || snapshot.href !== currentListHref) return;
    if (restoredScrollHrefRef.current === currentListHref) return;

    const scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    );
    if (
      shouldDelayMatchScrollRestore(
        snapshot.scrollY,
        window.innerHeight,
        scrollHeight,
        nextCursor !== null,
      ) &&
      !loadingMore &&
      !error &&
      scrollRestoreLoadAttemptsRef.current < 20
    ) {
      scrollRestoreLoadAttemptsRef.current += 1;
      void loadMore();
      return;
    }

    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }
    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      window.scrollTo(0, snapshot.scrollY);
      clearMatchListScroll(window.sessionStorage, currentListHref);
      scrollRestoreRef.current = null;
      restoredScrollHrefRef.current = currentListHref;
      scrollRestoreFrameRef.current = null;
    });
  }, [currentListHref, error, loadMore, loading, loadingMore, nextCursor]);

  const refreshHead = useCallback(() => {
    if (filters.sort !== 'started_at' || filters.order !== 'desc') return;
    const requestId = listRequestRef.current;
    apiFetch<unknown>(`/api/v1/matches?${buildListApiQuery(filters, { limit: PAGE_LIMIT })}`)
      .then(parseMatchListResponse)
      .then((data) => {
        // filters/sort changed while this refresh was in flight: it must not
        // add rows from the superseded query onto the list loadFirstPage
        // already replaced (MATCHES-582).
        if (listRequestRef.current !== requestId) return;
        setItems((prev) => mergeMatchPage(data.items, prev));
      })
      .catch(() => {});
  }, [filters]);
  /*
   * There is no `match.started`/`match.ended` live-bus event: nothing
   * publishes it (log-ingest only writes match.* rows to Redis Streams and
   * the `events` table), so subscribing to it here was a dead listener
   * (MATCHES-1296). New matches do reach the browser as
   * `server.events.appended` batches, the same signal EventsBrowser uses.
   */
  const onEventsAppended = useCallback(
    (event: { data: { server_id: string | null; kinds: string[] } }) => {
      if (announcesMatchBoundary(event.data)) refreshHead();
    },
    [refreshHead],
  );
  useLiveSubscription('server.events.appended', onEventsAppended);

  const serverOptions = useMemo(() => {
    const merged = new Map<string, ServerOption>();
    for (const option of fetchedServers) merged.set(option.id, option);
    for (const option of serverOptionsFromMatches(items)) {
      if (!merged.has(option.id)) merged.set(option.id, option);
    }
    return Array.from(merged.values()).sort((left, right) =>
      (left.display_name ?? left.slug ?? '').localeCompare(right.display_name ?? right.slug ?? ''),
    );
  }, [fetchedServers, items]);

  /**
   * Строка списка — настоящая ссылка, поэтому переход делает браузер. Снимок
   * прокрутки успевает сохраниться в обработчике клика: он выполняется до того,
   * как `next/link` начинает навигацию.
   */
  const rememberScroll = useCallback(
    (id: string) => {
      saveMatchListScroll(window.sessionStorage, currentListHref, window.scrollY, id);
    },
    [currentListHref],
  );

  const exportUrl = useMemo(() => buildExportUrl(filters), [filters]);

  const filtersApplied =
    filters.layer.trim() !== '' ||
    filters.servers.length > 0 ||
    filters.hideSeeding ||
    filters.preset !== 'all';

  return (
    <PageContainer>
      <PageHeader
        title="Матчи"
        meta={<span>всего: {total === null ? '…' : total}</span>}
        actions={
          <>
            <a href={exportUrl} className={DOWNLOAD_LINK_CLASS}>
              Экспорт CSV
            </a>
            <Button className="lg:hidden" onClick={() => setDrawerOpen(true)}>
              Фильтры
            </Button>
          </>
        }
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить список матчей"
          description={error}
          action={
            <Button size="sm" onClick={loadFirstPage}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <div className="flex gap-6">
        <aside className="hidden w-64 shrink-0 lg:block">
          <Card>
            <MatchFilterPanel filters={filters} servers={serverOptions} onChange={navigate} />
          </Card>
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          <Card padding="none">
            <MatchTable
              items={items}
              loading={loading}
              filters={filters}
              filtersApplied={filtersApplied}
              now={now}
              onSort={(column) => navigate(nextSort(filters, column))}
              onOpen={rememberScroll}
              listHref={currentListHref}
            />
          </Card>

          <div ref={sentinelRef} />

          {nextCursor ? (
            <div className="flex justify-center">
              <Button onClick={() => void loadMore()} loading={loadingMore}>
                Показать ещё
              </Button>
            </div>
          ) : !loading && items.length > 0 ? (
            <p className="py-2 text-center text-xs text-ink-3">Больше матчей нет</p>
          ) : null}
        </div>
      </div>

      <Modal
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Фильтры"
        closeLabel="Закрыть фильтры"
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setDrawerOpen(false)}>
            Готово
          </Button>
        }
      >
        <MatchFilterPanel filters={filters} servers={serverOptions} onChange={navigate} />
      </Modal>
    </PageContainer>
  );
}
