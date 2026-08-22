'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  SegmentedControl,
  Select,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
  Toolbar,
} from '@/components/ui';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  appendPage,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  COMBAT_FACETS,
  type CombatApiRow,
  type CombatFilters,
  type CombatListResponse,
  type CombatPlayer,
  combatEventToRow,
  DATE_PRESETS,
  defaultFilters,
  eventTypeMeta,
  facetLabel,
  formatDamage,
  formatEventTime,
  hasActiveFilters,
  PAGE_LIMIT,
  parseFilters,
  playerHref,
  playerLabel,
  prependLiveRow,
  type SortDir,
  shortServerLabel,
  showsDamageColumn,
  sortRowsByDamage,
} from './helpers';

interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

interface ServersResponse {
  items: ServerOption[];
}

interface PlayersResponse {
  items: Array<{ id: string; canonical_name: string | null }>;
}

/**
 * Тип боевого события. Оттенки различают соседние категории и ничего не
 * сообщают о состоянии системы: смысл несёт подпись внутри метки (§5).
 */
const EVENT_TONE: Record<string, BadgeTone> = {
  death: 'crit',
  damage: 'warn',
  wound: 'warn',
  revive: 'good',
};

/** Направление сортировки колонки урона читается величиной, а не словом «по». */
const DAMAGE_DIRECTION_TEXT: Record<SortDirection, string> = {
  desc: 'сначала больший урон',
  asc: 'сначала меньший урон',
};

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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [approxTotal, setApproxTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [damageSort, setDamageSort] = useState<SortDir>('desc');
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [lastLiveAt, setLastLiveAt] = useState<Date | null>(null);
  /**
   * Номер последнего запроса первой страницы: «Повторить» ходит тем же путём,
   * что и обычная загрузка, а ответ на отменённый запрос в список не попадает.
   */
  const listRequestRef = useRef(0);

  const damageVisible = showsDamageColumn(filters.facet);

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

  useEffect(() => {
    if (lockedServerId) return;
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data: ServersResponse) => {
        if (!cancelled) setServers(data.items ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lockedServerId]);

  const loadFirstPage = useCallback(() => {
    listRequestRef.current += 1;
    const requestId = listRequestRef.current;
    const current = () => listRequestRef.current === requestId;
    setLoading(true);
    setError(null);
    setApproxTotal(null);
    fetch(
      `/api/v1/combat-events?${buildListApiQuery(filters, { limit: PAGE_LIMIT, lockedServerId })}`,
      {
        credentials: 'include',
        cache: 'no-store',
      },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as CombatListResponse;
      })
      .then((data) => {
        if (!current()) return;
        setRows(data.rows);
        setNextCursor(data.nextCursor);
        setApproxTotal(data.approxTotal);
      })
      .catch((err: unknown) => {
        if (!current()) return;
        setError((err as Error).message);
        setRows([]);
        setNextCursor(null);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [filters, lockedServerId]);

  useEffect(() => {
    loadFirstPage();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/combat-events?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT, lockedServerId })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CombatListResponse;
      setRows((prev) => appendPage(prev, data.rows));
      setNextCursor(data.nextCursor);
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

  const onCombat = useCallback(
    (event: Extract<LiveEvent, { type: 'combat.event' }>) => {
      if (!liveEnabled) return;
      if (lockedServerId && event.data.server_id !== lockedServerId) return;
      setRows((prev) => prependLiveRow(prev, combatEventToRow(event.data)));
      setLastLiveAt(new Date());
    },
    [liveEnabled, lockedServerId],
  );
  useLiveSubscription('combat.event', onCombat);

  const displayRows = useMemo(
    () => (damageVisible ? sortRowsByDamage(rows, damageSort) : rows),
    [rows, damageVisible, damageSort],
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
            {liveEnabled ? <LiveIndicator lastUpdate={lastLiveAt} label="событие" /> : null}
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

function PlayerLink({ player }: { player: CombatPlayer | null }) {
  const href = playerHref(player);
  const label = playerLabel(player);
  if (href) {
    return (
      <Link href={href} className="font-medium text-accent no-underline hover:brightness-110">
        {label}
      </Link>
    );
  }
  return <span className="text-ink-3">{label}</span>;
}

/** «TK» — принятое в Squad сокращение тимкилла, поэтому остаётся как есть. */
function TeamkillBadge() {
  return (
    <Badge tone="crit" size="sm" title="Тимкилл">
      TK
    </Badge>
  );
}

function EventTypeBadge({ eventType }: { eventType: string }) {
  const meta = eventTypeMeta(eventType);
  return <Badge tone={EVENT_TONE[eventType] ?? 'neutral'}>{meta.labelRu}</Badge>;
}

function CombatTable({
  rows,
  loading,
  filtersApplied,
  onReset,
  showServer,
  serverNames,
  damageVisible,
  damageSort,
  onToggleDamageSort,
}: {
  rows: CombatApiRow[];
  loading: boolean;
  filtersApplied: boolean;
  onReset: () => void;
  showServer: boolean;
  serverNames: Map<string, string>;
  damageVisible: boolean;
  damageSort: SortDir;
  onToggleDamageSort: () => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <Card padding="sm">
        <SkeletonTable rows={10} cols={showServer ? 7 : 6} label="Загрузка боевого лога" />
      </Card>
    );
  }
  if (!loading && rows.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          variant={filtersApplied ? 'filtered' : 'initial'}
          title={filtersApplied ? 'Нет совпадений.' : 'Боевых событий пока нет'}
          description={
            filtersApplied
              ? 'Ни одно событие не подходит под включённые фильтры.'
              : 'Панель ещё не записала ни одного боевого события.'
          }
          action={
            filtersApplied ? (
              <Button size="sm" onClick={onReset}>
                Сбросить фильтры
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <>
      <Card padding="none" className="hidden overflow-hidden md:block">
        <Table ariaLabel="Боевые события" className="min-w-[720px]">
          <TableHead>
            <tr>
              <Th>Время</Th>
              {showServer ? <Th>Сервер</Th> : null}
              <Th>Кто</Th>
              <Th>Кого</Th>
              <Th>Оружие</Th>
              {damageVisible ? (
                <SortableTh
                  sortKey="damage"
                  activeKey="damage"
                  direction={damageSort}
                  onSort={onToggleDamageSort}
                  label="Урон"
                  directionText={DAMAGE_DIRECTION_TEXT}
                  align="right"
                />
              ) : null}
              <Th>TK</Th>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} interactive>
                <Td className="whitespace-nowrap text-xs text-ink-3">
                  <span title={row.occurredAt}>{formatEventTime(row.occurredAt)}</span>
                </Td>
                {showServer ? (
                  <Td className="whitespace-nowrap text-xs text-ink-2">
                    {shortServerLabel(serverNames, row.serverId)}
                  </Td>
                ) : null}
                <Td className="whitespace-nowrap">
                  <PlayerLink player={row.attacker} />
                </Td>
                <Td className="whitespace-nowrap">
                  <PlayerLink player={row.victim} />
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <EventTypeBadge eventType={row.eventType} />
                    <span className="text-xs">{row.weapon ?? '—'}</span>
                  </span>
                </Td>
                {damageVisible ? (
                  <Td numeric className="whitespace-nowrap text-xs">
                    {formatDamage(row.damage)}
                  </Td>
                ) : null}
                <Td>
                  {row.isTeamkill ? <TeamkillBadge /> : <span className="text-ink-4">—</span>}
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li key={row.id}>
            <Card padding="sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <EventTypeBadge eventType={row.eventType} />
                <span className="text-2xs tabular-nums text-ink-3" title={row.occurredAt}>
                  {formatEventTime(row.occurredAt)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <PlayerLink player={row.attacker} />
                <span aria-hidden="true" className="text-ink-3">
                  →
                </span>
                <PlayerLink player={row.victim} />
                {row.isTeamkill ? <TeamkillBadge /> : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
                <span>{row.weapon ?? '—'}</span>
                {showServer ? <span>{shortServerLabel(serverNames, row.serverId)}</span> : null}
                {damageVisible ? (
                  <span className="tabular-nums">Урон: {formatDamage(row.damage)}</span>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

function FilterPanel({
  filters,
  servers,
  lockedServerId,
  onChange,
  onReset,
}: {
  filters: CombatFilters;
  servers: ServerOption[];
  lockedServerId: string | undefined;
  onChange: (partial: Partial<CombatFilters>) => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-4">
      <PlayerAutocomplete
        label="Кто"
        placeholder="Ник атакующего"
        value={filters.attackerQuery}
        onCommit={(value) => onChange({ attackerQuery: value, attackerPlayerId: '' })}
      />
      <PlayerAutocomplete
        label="Кого"
        placeholder="Ник цели"
        value={filters.victimQuery}
        onCommit={(value) => onChange({ victimQuery: value, victimPlayerId: '' })}
      />
      <WeaponInput value={filters.weapon} onCommit={(value) => onChange({ weapon: value })} />

      <FieldRow label="Период">
        <Select
          value={filters.preset}
          onChange={(event) => onChange({ preset: event.target.value as CombatFilters['preset'] })}
        >
          {DATE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      {filters.preset === 'custom' ? (
        <div className="flex flex-col gap-2">
          <FieldRow label="С">
            <TextInput
              type="date"
              value={filters.from}
              onChange={(event) => onChange({ from: event.target.value })}
            />
          </FieldRow>
          <FieldRow label="По">
            <TextInput
              type="date"
              value={filters.to}
              onChange={(event) => onChange({ to: event.target.value })}
            />
          </FieldRow>
        </div>
      ) : null}

      {lockedServerId ? null : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink-2">Серверы</p>
          {servers.length === 0 ? (
            <p className="text-xs text-ink-3">Нет доступных серверов</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-ctl border border-line p-2">
              {servers.map((server) => {
                const active = filters.serverIds.includes(server.id);
                return (
                  <Checkbox
                    key={server.id}
                    label={server.display_name ?? server.slug ?? server.id.slice(0, 8)}
                    checked={active}
                    onChange={() =>
                      onChange({
                        serverIds: active
                          ? filters.serverIds.filter((id) => id !== server.id)
                          : [...filters.serverIds, server.id],
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {hasActiveFilters(filters) ? (
        <Button variant="plain" size="sm" onClick={onReset}>
          Сбросить фильтры
        </Button>
      ) : null}
    </div>
  );
}

function PlayerAutocomplete({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const query = draft.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/v1/players?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
        cache: 'no-store',
      })
        .then((res) => (res.ok ? res.json() : { items: [] }))
        .then((data: PlayersResponse) => {
          if (cancelled) return;
          const names = data.items
            .map((item) => item.canonical_name)
            .filter((name): name is string => Boolean(name));
          setSuggestions(Array.from(new Set(names)).slice(0, 10));
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(draft.trim());
      }}
    >
      <FieldRow label={label}>
        <TextInput
          type="search"
          list={listId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft.trim())}
          placeholder={placeholder}
        />
      </FieldRow>
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </form>
  );
}

function WeaponInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(draft.trim());
      }}
    >
      <FieldRow label="Оружие">
        <TextInput
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft.trim())}
          placeholder="Напр. AK74"
        />
      </FieldRow>
    </form>
  );
}
