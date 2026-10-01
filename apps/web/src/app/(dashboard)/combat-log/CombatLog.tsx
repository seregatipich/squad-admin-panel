'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  InlineBanner,
  Modal,
  SegmentedControl,
  Toolbar,
} from '@/components/ui';
import { apiFetch, describeHttpError } from '@/lib/api';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { useApiResource } from '@/lib/use-polled-resource';
import { FilterPanel, type ServerOption } from './CombatFilterPanel';
import { CombatTable } from './CombatTable';
import {
  appendPage,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  COMBAT_FACETS,
  type CombatApiRow,
  type CombatFilters,
  type CombatListResponse,
  combatEventToRow,
  defaultFilters,
  facetLabel,
  hasActiveFilters,
  matchesLiveFilters,
  PAGE_LIMIT,
  parseFilters,
  prependLiveRow,
  type SortDir,
  showsDamageColumn,
  sortRowsByDamage,
} from './helpers';

interface ServersResponse {
  items: ServerOption[];
}

const NO_SERVERS: ServerOption[] = [];

/*
 * Ссылка на выгрузку остаётся обычным `<a>`, а не `ButtonLink`: `next/link`
 * перехватывает клик и уводит в клиентскую навигацию, из-за чего файл не
 * скачивается. Классы повторяют вторичную кнопку размера `md` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-3 text-xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

/**
 * Боевой лог: список событий боя с фильтрами и живым дополнением сверху.
 *
 * Собственного `<h1>` компонент не рендерит. Он встроен в две страницы —
 * `/combat-log` и `/servers/[id]/combat-log`, — и на второй заголовок страницы
 * принадлежит layout раздела сервера. Второй `<h1>` лишил бы экранный диктор
 * единственной опоры, по которой оператор понимает, где он оказался (§1).
 *
 * @param lockedServerId Ограничивает лог одним сервером и убирает его фильтр.
 */
export function CombatLog({ lockedServerId }: { lockedServerId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [rows, setRows] = useState<CombatApiRow[]>([]);
  /**
   * Live rows prepended via the `combat.event` live-bus subscription, kept in
   * their own array separate from the paginated `rows` history. Capping this
   * array on its own (instead of slicing the merged list) means an unattended
   * Live view never drops history rows the loaded page's `nextCursor` still
   * expects to find — see COMBAT-529.
   */
  const [liveRows, setLiveRows] = useState<CombatApiRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [approxTotal, setApproxTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serversResource = useApiResource<ServersResponse>('/api/v1/servers', {
    enabled: !lockedServerId,
  });
  const servers = serversResource.data?.items ?? NO_SERVERS;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [damageSort, setDamageSort] = useState<SortDir>('desc');
  const [liveEnabled, setLiveEnabled] = useState(false);
  /**
   * Номер последнего запроса первой страницы: «Повторить» ходит тем же путём,
   * что и обычная загрузка, а ответ на отменённый запрос в список не попадает.
   */
  const listRequestRef = useRef(0);

  const damageVisible = showsDamageColumn(filters.facet);
  // The API orders the whole result set by damage, so the header sorts the
  // true top rather than only the pages loaded so far; live rows are merged in
  // client-side below.
  const serverDamageSort = damageVisible ? damageSort : undefined;

  const serverNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) {
      map.set(server.id, server.display_name ?? server.slug ?? server.id.slice(0, 8));
    }
    return map;
  }, [servers]);

  const navigate = useCallback(
    (partial: Partial<CombatFilters>) => {
      const next: CombatFilters = { ...filters, ...partial };
      const qs = buildQueryString(next);
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
    setApproxTotal(null);
    apiFetch<Partial<CombatListResponse>>(
      `/api/v1/combat-events?${buildListApiQuery(filters, { limit: PAGE_LIMIT, lockedServerId, damageSort: serverDamageSort })}`,
    )
      .then((body) => {
        if (!Array.isArray(body.rows)) throw new Error('Некорректный ответ сервера');
        return body as CombatListResponse;
      })
      .then((data) => {
        if (!current()) return;
        setRows(data.rows);
        setLiveRows([]);
        setNextCursor(data.nextCursor);
        setApproxTotal(data.approxTotal);
      })
      .catch((err: unknown) => {
        if (!current()) return;
        setError(describeHttpError(err));
        setRows([]);
        setLiveRows([]);
        setNextCursor(null);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [filters, lockedServerId, serverDamageSort]);

  useEffect(() => {
    loadFirstPage();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    // Captured at the start: if the user changes filters while this request
    // is in flight, loadFirstPage bumps listRequestRef and this stale
    // response is dropped instead of appending rows (or a cursor) from the
    // filter that was active when it was sent.
    const requestId = listRequestRef.current;
    const current = () => listRequestRef.current === requestId;
    setLoadingMore(true);
    try {
      const body = await apiFetch<Partial<CombatListResponse>>(
        `/api/v1/combat-events?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT, lockedServerId, damageSort: serverDamageSort })}`,
      );
      if (!Array.isArray(body.rows)) throw new Error('Некорректный ответ сервера');
      if (!current()) return;
      setRows((prev) => appendPage(prev, body.rows as CombatApiRow[]));
      setNextCursor(body.nextCursor ?? null);
    } catch (err) {
      if (!current()) return;
      setError(describeHttpError(err));
    } finally {
      if (current()) setLoadingMore(false);
    }
  }, [filters, nextCursor, loadingMore, lockedServerId, serverDamageSort]);

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

  const onCombat = useCallback(
    (event: Extract<LiveEvent, { type: 'combat.event' }>) => {
      if (!liveEnabled) return;
      const row = combatEventToRow(event.data);
      if (!matchesLiveFilters(row, filters, lockedServerId)) return;
      setLiveRows((prev) => prependLiveRow(prev, row));
    },
    [liveEnabled, lockedServerId, filters],
  );
  useLiveSubscription('combat.event', onCombat);

  const combinedRows = useMemo(() => [...liveRows, ...rows], [liveRows, rows]);

  const displayRows = useMemo(
    () => (damageVisible ? sortRowsByDamage(combinedRows, damageSort) : combinedRows),
    [combinedRows, damageVisible, damageSort],
  );

  const exportHref = `/api/v1/combat-events/export?${buildExportApiQuery(filters, { lockedServerId })}`;
  const resetFilters = useCallback(() => navigate(defaultFilters()), [navigate]);

  return (
    <div className="space-y-4">
      <Toolbar
        filters={
          <>
            <SegmentedControl
              ariaLabel="Тип боевых событий"
              items={COMBAT_FACETS.map((facet) => ({ value: facet, label: facetLabel(facet) }))}
              value={filters.facet}
              onChange={(facet) => navigate({ facet: facet as CombatFilters['facet'] })}
            />
            <Checkbox
              label="Живая лента"
              checked={liveEnabled}
              onChange={(event) => setLiveEnabled(event.target.checked)}
            />
          </>
        }
        summary={approxTotal === null ? '≈ …' : `≈ ${approxTotal.toLocaleString('ru-RU')}`}
        actions={
          <>
            <a href={exportHref} className={DOWNLOAD_LINK_CLASS}>
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
          title="Не удалось загрузить боевой лог"
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
            <FilterPanel
              filters={filters}
              servers={servers}
              lockedServerId={lockedServerId}
              onChange={navigate}
              onReset={resetFilters}
            />
          </Card>
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          <CombatTable
            rows={displayRows}
            loading={loading}
            filtersApplied={hasActiveFilters(filters)}
            onReset={resetFilters}
            showServer={!lockedServerId}
            serverNames={serverNames}
            damageVisible={damageVisible}
            damageSort={damageSort}
            onToggleDamageSort={() => setDamageSort((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
          />

          <div ref={sentinelRef} />

          {nextCursor ? (
            <div className="flex justify-center">
              <Button onClick={() => void loadMore()} loading={loadingMore}>
                Показать ещё
              </Button>
            </div>
          ) : !loading && displayRows.length > 0 ? (
            <p className="py-2 text-center text-xs text-ink-3">Больше событий нет</p>
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
        <FilterPanel
          filters={filters}
          servers={servers}
          lockedServerId={lockedServerId}
          onChange={navigate}
          onReset={resetFilters}
        />
      </Modal>
    </div>
  );
}
