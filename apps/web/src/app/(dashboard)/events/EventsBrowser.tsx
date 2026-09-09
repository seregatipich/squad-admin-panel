'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  EmptyState,
  IconButton,
  InlineBanner,
  Modal,
  SearchField,
  Select,
  Skeleton,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';
import {
  appendEventPage,
  buildCountApiQuery,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  DATE_PRESETS,
  type EventEnvelope,
  type EventFilters,
  type EventListItem,
  type EventListResponse,
  formatDateTime,
  kindLabel,
  kindOptionsFromEvents,
  PAGE_LIMIT,
  parseFilters,
  type ServerOption,
  serverOptionsFromEvents,
  shortServerName,
} from './helpers';

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
 * Тон пилюли типа события.
 *
 * Повторяет разбиение `kindTone` из `helpers.ts`, но выдаёт тон дизайн-системы,
 * а не строку классов: помощник — общий модуль со своим владельцем, и цвета
 * оформления в нём остаются те, что были. Смысл всё равно несёт подпись
 * `kindLabel`, а не цвет (§5).
 */
function kindBadgeTone(kind: string): BadgeTone {
  if (kind.startsWith('server.crashed') || kind.endsWith('.failed')) return 'crit';
  if (kind.startsWith('player.connected') || kind.startsWith('match.started')) return 'good';
  if (
    kind.startsWith('player.disconnected') ||
    kind.startsWith('match.ended') ||
    kind.startsWith('banname.matched')
  ) {
    return 'warn';
  }
  return 'neutral';
}

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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [fetchedServers, setFetchedServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<EventListItem | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

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
    setLoading(true);
    setError(null);
    fetch(`/api/v1/events?${buildListApiQuery(filters, { limit: PAGE_LIMIT, lockedServerId })}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as EventListResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setNextCursor(data.next_cursor);
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
  }, [filters, lockedServerId, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    setTotal(null);
    fetch(`/api/v1/events/count?${buildCountApiQuery(filters, { lockedServerId })}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => (res.ok ? ((await res.json()) as { total: number }) : { total: 0 }))
      .then((data) => {
        if (!cancelled) setTotal(data.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters, lockedServerId]);

  useEffect(() => {
    if (lockedServerId) return;
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as ServersResponse) : { items: [] }))
      .then((data) => {
        if (cancelled) return;
        setFetchedServers(
          data.items.map((entry) => ({
            id: entry.id,
            display_name: entry.display_name,
            slug: entry.slug,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lockedServerId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/events?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT, lockedServerId })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as EventListResponse;
      setItems((prev) => appendEventPage(prev, data.items));
      setNextCursor(data.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [filters, nextCursor, loadingMore, lockedServerId]);

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
        summary={total === null ? 'Всего: …' : `Всего: ${total}`}
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
                <Button onClick={() => void loadMore()} loading={loadingMore}>
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

function FilterPanel({
  filters,
  servers,
  kinds,
  lockedServerId,
  onChange,
}: {
  filters: EventFilters;
  servers: ServerOption[];
  kinds: Array<{ value: string; label: string }>;
  lockedServerId: string | undefined;
  onChange: (partial: Partial<EventFilters>) => void;
}) {
  function toggleKind(value: string) {
    const active = filters.kinds.includes(value);
    const nextKinds = active
      ? filters.kinds.filter((entry) => entry !== value)
      : [...filters.kinds, value];
    onChange({ kinds: nextKinds });
  }

  function toggleServer(id: string) {
    const active = filters.servers.includes(id);
    const nextServers = active
      ? filters.servers.filter((entry) => entry !== id)
      : [...filters.servers, id];
    onChange({ servers: nextServers });
  }

  return (
    <Card className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink-2">Тип события</span>
          {filters.kinds.length > 0 ? (
            <Button variant="plain" size="sm" onClick={() => onChange({ kinds: [] })}>
              Сбросить
            </Button>
          ) : null}
        </div>
        <div className="space-y-1">
          {kinds.map((option) => (
            <Checkbox
              key={option.value}
              label={<span className="truncate">{option.label}</span>}
              checked={filters.kinds.includes(option.value)}
              onChange={() => toggleKind(option.value)}
              className="px-0.5"
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-ink-2">Период</span>
        <Select
          aria-label="Период"
          value={filters.preset}
          onChange={(event) => onChange({ preset: event.target.value as EventFilters['preset'] })}
        >
          {DATE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </Select>
        {filters.preset === 'custom' ? (
          <div className="flex flex-col gap-2 pt-1">
            <label className="flex items-center justify-between gap-2 text-xs text-ink-3">
              С
              <input
                type="date"
                value={filters.from}
                onChange={(event) => onChange({ from: event.target.value })}
                className="h-8 rounded-ctl border border-line bg-raised px-2 text-xs text-ink"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-xs text-ink-3">
              По
              <input
                type="date"
                value={filters.to}
                onChange={(event) => onChange({ to: event.target.value })}
                className="h-8 rounded-ctl border border-line bg-raised px-2 text-xs text-ink"
              />
            </label>
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-ink-2">Порядок</span>
        <Select
          aria-label="Порядок событий"
          value={filters.order}
          onChange={(event) => onChange({ order: event.target.value as EventFilters['order'] })}
        >
          <option value="desc">Сначала новые</option>
          <option value="asc">Сначала старые</option>
        </Select>
      </div>

      {lockedServerId ? null : (
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-ink-2">Серверы</span>
          {servers.length === 0 ? (
            <p className="text-xs text-ink-3">Нет доступных серверов</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-ctl border border-line p-1">
              {servers.map((server) => (
                <Checkbox
                  key={server.id}
                  label={
                    <span className="truncate">
                      {server.display_name ?? server.slug ?? server.id.slice(0, 8)}
                    </span>
                  }
                  checked={filters.servers.includes(server.id)}
                  onChange={() => toggleServer(server.id)}
                  className="px-1.5"
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function EventList({
  items,
  loading,
  filtersApplied,
  showServer,
  onSelect,
  onResetFilters,
}: {
  items: EventListItem[];
  loading: boolean;
  filtersApplied: boolean;
  showServer: boolean;
  onSelect: (event: EventListItem) => void;
  onResetFilters: () => void;
}) {
  if (loading && items.length === 0) {
    return (
      <div className="p-3">
        <SkeletonTable rows={8} cols={showServer ? 5 : 4} label="Загружаем журнал событий" />
      </div>
    );
  }
  if (!loading && items.length === 0) {
    return (
      <EmptyState
        variant={filtersApplied ? 'filtered' : 'initial'}
        title={filtersApplied ? 'Ничего не нашлось' : 'Событий пока нет'}
        description={
          filtersApplied
            ? 'Ни одно событие не подходит под выбранные фильтры.'
            : 'Как только серверы начнут присылать события, они появятся здесь.'
        }
        action={filtersApplied ? <Button onClick={onResetFilters}>Сбросить фильтр</Button> : null}
      />
    );
  }
  return (
    <Table dense ariaLabel="События">
      <TableHead>
        <TableRow>
          <Th>Время</Th>
          <Th>Тип</Th>
          {showServer ? <Th>Сервер</Th> : null}
          <Th>Кто</Th>
          <Th align="right">Идентификатор</Th>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((event) => (
          <TableRow key={event.event_id} interactive>
            <Td className="whitespace-nowrap">
              {/* Конверт открывается в модальном окне, поэтому здесь настоящая
                  кнопка, а не ссылка и не обработчик на строке. */}
              <Button
                variant="plain"
                size="sm"
                onClick={() => onSelect(event)}
                title={`Показать конверт события ${event.event_id.slice(0, 8)}`}
              >
                {formatDateTime(event.occurred_at)}
              </Button>
            </Td>
            <Td>
              <Badge size="sm" tone={kindBadgeTone(event.kind)}>
                {kindLabel(event.kind)}
              </Badge>
            </Td>
            {showServer ? <Td className="text-ink-2">{shortServerName(event)}</Td> : null}
            <Td truncate className="text-ink-2">
              {event.actor_nickname ?? '—'}
            </Td>
            <Td numeric className="font-mono text-2xs text-ink-3">
              {event.event_id.slice(0, 8)}
            </Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EnvelopeModal({ event, onClose }: { event: EventListItem | null; onClose: () => void }) {
  const [envelope, setEnvelope] = useState<EventEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const eventId = event?.event_id ?? null;

  useEffect(() => {
    if (eventId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEnvelope(null);
    fetch(`/api/v1/events/${eventId}`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as EventEnvelope;
      })
      .then((data) => {
        if (!cancelled) setEnvelope(data);
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
  }, [eventId]);

  return (
    <Modal
      open={event !== null}
      onClose={onClose}
      title={event ? kindLabel(event.kind) : 'Событие'}
      description={event ? `${formatDateTime(event.occurred_at)} · ${event.event_id}` : undefined}
      size="lg"
      closeLabel="Закрыть"
    >
      {loading ? (
        <Skeleton variant="text" count={6} label="Загружаем конверт события" />
      ) : error ? (
        <InlineBanner tone="crit" title="Не удалось загрузить конверт" description={error} />
      ) : envelope ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-ctl bg-raised p-3 font-mono text-2xs leading-relaxed text-ink-2">
          {JSON.stringify(envelope, null, 2)}
        </pre>
      ) : null}
    </Modal>
  );
}
