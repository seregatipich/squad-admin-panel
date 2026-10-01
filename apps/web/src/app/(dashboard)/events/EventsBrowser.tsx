'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  IconButton,
  InlineBanner,
  Modal,
  SearchField,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';
import { apiFetch, apiResult, describeHttpError, nullOnHttpError } from '@/lib/api';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { useApiResource } from '@/lib/use-polled-resource';
import { EnvelopeModal } from './EnvelopeModal';
import { FilterPanel } from './EventFilterPanel';
import { EventList } from './EventList';
import {
  appendEventPage,
  buildCountApiQuery,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  type EventFilters,
  type EventListItem,
  type EventListResponse,
  type EventsAppendedBatch,
  eventsBatchAffectsList,
  kindOptionsFromEvents,
  mergeEventPage,
  PAGE_LIMIT,
  parseFilters,
  type ServerOption,
  serverOptionsFromEvents,
} from './helpers';

/** Минимальный промежуток между живыми перечитываниями первой страницы. */
const LIVE_REFRESH_MS = 5000;
/** Верхняя граница страниц догонки в одном живом перечитывании (EVENTS-1336). */
const MAX_CATCHUP_PAGES = 10;
/** Верхняя граница длины списка: не даёт долгоживущей вкладке расти вечно. */
const ITEMS_CAP = 1000;

interface ServersResponse {
  items: Array<{ id: string; display_name: string | null; slug: string | null }>;
}

/*
 * Ссылка на выгрузку остаётся обычным `<a>`, а не `ButtonLink`: `next/link`
 * перехватывает клик и уводит в клиентскую навигацию, из-за чего файл не
 * скачивается. Классы повторяют вторичную кнопку размера `md` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-3 text-xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

/**
 * Журнал событий: список конвертов с фильтрами и постраничной подгрузкой.
 *
 * Собственного `<h1>` здесь нет ни в одном режиме. Тот же компонент
 * встраивается в `/servers/[id]/events`, где заголовок первого уровня — имя
 * сервера из layout раздела; второй `<h1>` лишил бы экранный диктор
 * единственной опоры. На верхнем уровне заголовок ставит `/events/page.tsx`,
 * а во вложенном режиме здесь появляется только заголовок раздела.
 *
 * @param lockedServerId Показывать события одного сервера; выключает выбор
 *   серверов в фильтрах и включает заголовок раздела.
 */
export function EventsBrowser({ lockedServerId }: { lockedServerId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [items, setItems] = useState<EventListItem[]>([]);
  const itemsRef = useRef<EventListItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [totalEstimated, setTotalEstimated] = useState(false);
  const serversResource = useApiResource<ServersResponse>('/api/v1/servers', {
    enabled: !lockedServerId,
  });
  const fetchedServers = useMemo<ServerOption[]>(
    () =>
      (serversResource.data?.items ?? []).map((entry) => ({
        id: entry.id,
        display_name: entry.display_name,
        slug: entry.slug,
      })),
    [serversResource.data],
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<EventListItem | null>(null);
  const [_reloadToken, setReloadToken] = useState(0);

  /**
   * Bumped every time `filters`/`lockedServerId` change (a new first page is
   * requested). `loadMore` and `refreshHead` capture the generation active
   * when they start and discard their response if it no longer matches by
   * the time it arrives — otherwise a `loadMore`/`refreshHead` begun under
   * the old filters could splice stale-filter rows or an old cursor into the
   * list the new first page already replaced (EVENTS-553).
   */
  const requestGenerationRef = useRef(0);
  // Mirrors `loadingMore` without being a `loadMore` dependency: putting the
  // state value itself in the deps recreated `loadMore` on every toggle,
  // which re-ran the IntersectionObserver effect below and could re-trigger
  // it immediately with no backoff (EVENTS-552).
  const loadingMoreRef = useRef(false);
  // Set on a failed `loadMore`; the IntersectionObserver skips auto-retrying
  // while it's set; only the visible "Показать ещё" button clears it.
  const loadMoreFailedRef = useRef(false);

  const navigate = useCallback(
    (partial: Partial<EventFilters>) => {
      const nextFilters: EventFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    requestGenerationRef.current += 1;
    loadMoreFailedRef.current = false;
    setLoading(true);
    setError(null);
    apiFetch<EventListResponse>(
      `/api/v1/events?${buildListApiQuery(filters, { limit: PAGE_LIMIT, lockedServerId })}`,
    )
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setNextCursor(data.next_cursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeHttpError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, lockedServerId]);

  useEffect(() => {
    let cancelled = false;
    setTotal(null);
    apiFetch<{ total: number; estimated?: boolean } | null>(
      `/api/v1/events/count?${buildCountApiQuery(filters, { lockedServerId })}`,
    )
      // A failed count is unknown, not zero: `total: 0` would render "Всего: 0"
      // and read as "there are no events" instead of "count unavailable".
      .catch(nullOnHttpError)
      .then((data) => {
        if (cancelled) return;
        setTotal(data ? data.total : null);
        setTotalEstimated(data?.estimated === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters, lockedServerId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    const generation = requestGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await apiFetch<EventListResponse>(
        `/api/v1/events?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT, lockedServerId })}`,
      );
      // The filters/server may have changed while this request was in
      // flight — the first-page effect already replaced `items` under the
      // new filters, so an old-generation response must not be appended to
      // it (EVENTS-553).
      if (requestGenerationRef.current !== generation) return;
      setItems((prev) => appendEventPage(prev, data.items));
      setNextCursor(data.next_cursor);
      loadMoreFailedRef.current = false;
    } catch (err) {
      if (requestGenerationRef.current !== generation) return;
      setError(describeHttpError(err));
      // Stop the IntersectionObserver from firing again on its own; only the
      // visible "Показать ещё" click clears this (EVENTS-552).
      loadMoreFailedRef.current = true;
    } finally {
      loadingMoreRef.current = false;
      if (requestGenerationRef.current === generation) setLoadingMore(false);
    }
  }, [filters, nextCursor, lockedServerId]);

  // Живая лента: API шлёт `server.events.appended`, как только в `events`
  // появилась строка, и список подтягивает свежую первую страницу сверху, не
  // трогая уже догруженный хвост. Кадр не несёт самих событий — они приходят
  // через тот же REST с проверкой прав. Не чаще раза в LIVE_REFRESH_MS: в
  // разгар боя строки идут десятками в секунду.
  const liveRef = useRef({ inFlight: false, again: false, lastAt: 0 });
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshHead = useCallback(async () => {
    const live = liveRef.current;
    if (live.inFlight) {
      live.again = true;
      return;
    }
    live.inFlight = true;
    live.lastAt = Date.now();
    const generation = requestGenerationRef.current;
    try {
      // A single first-page refresh only ever sees PAGE_LIMIT=50 new rows: in
      // a busy match, more than 50 events between two live refreshes used to
      // vanish for good, since the cursor picks up only from the *old* head.
      // Walk forward page by page (bounded) until a row already in the list
      // is found, so a burst larger than one page is still caught up on
      // instead of leaving a permanent gap (EVENTS-1336).
      const known = new Set(itemsRef.current.map((event) => event.event_id));
      let collected: EventListItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_CATCHUP_PAGES; page++) {
        const result = await apiResult<EventListResponse>(
          `/api/v1/events?${buildListApiQuery(filters, { limit: PAGE_LIMIT, cursor, lockedServerId })}`,
        );
        if (!result.ok) break;
        const data = result.data;
        collected = collected.concat(data.items);
        const reachedKnownRow = data.items.some((event) => known.has(event.event_id));
        if (reachedKnownRow || !data.next_cursor || data.items.length < PAGE_LIMIT) break;
        cursor = data.next_cursor;
      }
      if (requestGenerationRef.current !== generation) return;
      const added = collected.filter((event) => !known.has(event.event_id)).length;
      if (added > 0) setTotal((current) => (current === null ? current : current + added));
      setItems((prev) => {
        const merged = mergeEventPage(collected, prev);
        // A long-lived tab must not grow this list forever (EVENTS-1336).
        return merged.length > ITEMS_CAP ? merged.slice(0, ITEMS_CAP) : merged;
      });
    } catch {
      // Живое обновление — надбавка; при ошибке список просто ждёт следующего кадра.
    } finally {
      live.inFlight = false;
      if (live.again) {
        live.again = false;
        liveTimerRef.current = setTimeout(() => {
          // Without this reset, `onEventsAppended`'s
          // `if (liveTimerRef.current) return;` guard permanently blocks any
          // further live refresh once this retry timer has fired once
          // (EVENTS-551).
          liveTimerRef.current = null;
          void refreshHead();
        }, LIVE_REFRESH_MS);
      }
    }
  }, [filters, lockedServerId]);

  const onEventsAppended = useCallback(
    (event: { data: EventsAppendedBatch }) => {
      if (loading || !eventsBatchAffectsList(event.data, filters, lockedServerId)) return;
      if (liveTimerRef.current) return;
      const wait = Math.max(0, liveRef.current.lastAt + LIVE_REFRESH_MS - Date.now());
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        void refreshHead();
      }, wait);
    },
    [filters, loading, lockedServerId, refreshHead],
  );
  useLiveSubscription('server.events.appended', onEventsAppended);
  useEffect(
    () => () => {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    },
    [],
  );

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (loadMoreFailedRef.current) return;
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  const serverOptions = useMemo(() => {
    const merged = new Map<string, ServerOption>();
    for (const option of fetchedServers) merged.set(option.id, option);
    for (const option of serverOptionsFromEvents(items)) {
      if (!merged.has(option.id)) merged.set(option.id, option);
    }
    return Array.from(merged.values()).sort((left, right) =>
      (left.display_name ?? left.slug ?? '').localeCompare(right.display_name ?? right.slug ?? ''),
    );
  }, [fetchedServers, items]);

  const kindOptions = useMemo(() => kindOptionsFromEvents(items), [items]);

  const exportHref = `/api/v1/events/export?${buildExportApiQuery(filters, { lockedServerId })}`;

  const filtersApplied =
    filters.kinds.length > 0 ||
    filters.servers.length > 0 ||
    filters.playerQuery !== '' ||
    filters.ruleId !== '' ||
    filters.preset !== 'all';

  const resetFilters = useCallback(() => {
    navigate({
      kinds: [],
      servers: [],
      playerQuery: '',
      ruleId: '',
      preset: 'all',
      from: '',
      to: '',
    });
  }, [navigate]);

  const resetProps: ToolbarProps = filtersApplied
    ? { onReset: resetFilters, resetLabel: 'Сбросить фильтр' }
    : {};

  const filterPanel = (
    <FilterPanel
      filters={filters}
      servers={serverOptions}
      kinds={kindOptions}
      lockedServerId={lockedServerId}
      onChange={navigate}
    />
  );

  return (
    <div className="space-y-4">
      {lockedServerId ? (
        <h2 className="text-[17px] font-semibold text-ink">Журнал событий</h2>
      ) : null}

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить события"
          description={error}
          action={
            <Button size="sm" onClick={() => setReloadToken((token) => token + 1)}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Toolbar
        search={
          <SearchField
            value={filters.playerQuery}
            onCommit={(next) => navigate({ playerQuery: next.trim() })}
            label="Поиск по игроку"
            placeholder="Ник игрока"
            clearLabel="Очистить поиск"
          />
        }
        filters={
          <Button className="lg:hidden" onClick={() => setDrawerOpen(true)}>
            Фильтры
          </Button>
        }
        {...resetProps}
        summary={total === null ? 'Всего: …' : `Всего: ${totalEstimated ? '≈' : ''}${total}`}
        actions={
          <a href={exportHref} className={DOWNLOAD_LINK_CLASS}>
            Экспорт CSV
          </a>
        }
      />

      {filters.ruleId ? (
        <div className="flex items-center gap-1">
          <Badge tone="accent">Правило: {filters.ruleId.slice(0, 8)}…</Badge>
          <IconButton
            icon={<span aria-hidden="true">✕</span>}
            label="Убрать фильтр по правилу"
            onClick={() => navigate({ ruleId: '' })}
          />
        </div>
      ) : null}

      <div className="flex gap-6">
        <aside className="hidden w-64 shrink-0 lg:block">{filterPanel}</aside>

        <div className="min-w-0 flex-1">
          <Card padding="none">
            <EventList
              items={items}
              loading={loading}
              filtersApplied={filtersApplied}
              showServer={!lockedServerId}
              onSelect={setSelected}
              onResetFilters={resetFilters}
            />

            <div ref={sentinelRef} />

            {nextCursor ? (
              <div className="flex justify-center border-t border-line p-3">
                <Button
                  onClick={() => {
                    loadMoreFailedRef.current = false;
                    void loadMore();
                  }}
                  loading={loadingMore}
                >
                  Показать ещё
                </Button>
              </div>
            ) : !loading && items.length > 0 ? (
              <p className="border-t border-line p-3 text-center text-xs text-ink-3">
                Больше событий нет
              </p>
            ) : null}
          </Card>
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
        {filterPanel}
      </Modal>

      <EnvelopeModal event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
