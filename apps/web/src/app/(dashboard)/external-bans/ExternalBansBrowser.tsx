'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Pagination,
  SearchField,
  Select,
  Skeleton,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';
import {
  type BanStatusLike,
  banStatusBadge,
  buildApiQuery,
  buildQueryString,
  formatDate,
  identityLabel,
  parseFilters,
  trustLevelLabel,
} from './helpers';

interface RegistryBan {
  id: string;
  source_id: string;
  source_name: string;
  trust_level: string;
  discord_url: string | null;
  nickname: string | null;
  reason: string | null;
  admin_name: string | null;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  is_active: boolean;
  is_permanent: boolean;
}

interface RegistryRow {
  steam_id64: string | null;
  eos_id: string | null;
  player_id: string | null;
  panel_nickname: string | null;
  bans: RegistryBan[];
  active_source_count: number;
}

interface RegistryResponse {
  rows: RegistryRow[];
  total: number;
  limit: number;
  offset: number;
}

interface BanSourceOption {
  id: string;
  name: string;
}

/** Доверие к источнику — категория, а не состояние системы: пилюля, а не цвет строки. */
const TRUST_TONE: Record<string, BadgeTone> = {
  trusted: 'good',
  normal: 'accent',
  low: 'warn',
};

/** Тон статуса бана. Смысл всё равно несёт подпись из {@link banStatusBadge} (§5). */
function banStatusTone(ban: BanStatusLike): BadgeTone {
  if (!ban.is_active) return 'neutral';
  return ban.is_permanent ? 'crit' : 'warn';
}

export function ExternalBansBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = parseFilters(searchParams);

  const [rows, setRows] = useState<RegistryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<BanSourceOption[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/ban-sources', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : []))
      .then((body: BanSourceOption[]) => {
        if (!cancelled) setSources(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const navigate = useCallback(
    (partial: Partial<typeof filters>) => {
      const next = { ...filters, ...partial };
      if (
        partial.q !== undefined ||
        partial.permanentOnly !== undefined ||
        partial.sourceId !== undefined
      ) {
        next.offset = 0;
      }
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/external-bans?${buildApiQuery(filters)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RegistryResponse;
      setRows(data.rows);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtersApplied = filters.q !== '' || filters.permanentOnly || filters.sourceId !== '';
  const page = Math.floor(filters.offset / filters.limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / filters.limit));

  function resetFilters() {
    navigate({ q: '', permanentOnly: false, sourceId: '' });
  }

  // Слот сброса у `Toolbar` — пара «обработчик + подпись» или ничего.
  const resetProps: ToolbarProps = filtersApplied
    ? { onReset: resetFilters, resetLabel: 'Сбросить фильтр' }
    : {};

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Внешние баны"
        subtitle="Агрегированный реестр банов из подключённых внешних источников."
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить реестр"
          description={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Toolbar
        search={
          <SearchField
            value={filters.q}
            onCommit={(next) => navigate({ q: next.trim() })}
            label="Поиск по реестру"
            placeholder="Ник, SteamID64, EOS ID или причина"
            clearLabel="Очистить поиск"
          />
        }
        filters={
          <>
            <Checkbox
              label="Только перманентные"
              checked={filters.permanentOnly}
              onChange={(e) => navigate({ permanentOnly: e.target.checked })}
            />
            <Select
              aria-label="Источник бана"
              value={filters.sourceId}
              onChange={(e) => navigate({ sourceId: e.target.value })}
            >
              <option value="">Все источники</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </Select>
          </>
        }
        {...resetProps}
        summary={
          rows.length > 0
            ? `${filters.offset + 1}–${filters.offset + rows.length} из ${total}`
            : undefined
        }
      />

      {loading ? (
        <Skeleton variant="card" count={3} label="Загрузка реестра внешних банов" />
      ) : rows.length === 0 ? (
        <Card padding="none">
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title={filtersApplied ? 'Ничего не нашлось' : 'Реестр пуст'}
            description={
              filtersApplied
                ? 'Ни один игрок не подходит под запрос и выбранные фильтры.'
                : 'Подключённые источники ещё не прислали ни одного бана.'
            }
            action={filtersApplied ? <Button onClick={resetFilters}>Сбросить фильтр</Button> : null}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const key = `${row.steam_id64 ?? ''}:${row.eos_id ?? ''}`;
            const expanded = expandedKey === key;
            return (
              <Card key={key} padding="sm" className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {row.player_id ? (
                      <Link
                        href={`/all-players/${row.player_id}`}
                        className="font-medium text-accent no-underline hover:brightness-110"
                      >
                        {identityLabel(row)}
                      </Link>
                    ) : (
                      <span className="font-medium text-ink">{identityLabel(row)}</span>
                    )}
                    {row.active_source_count > 0 ? (
                      <Badge tone="crit">Активен в {row.active_source_count}</Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-ink-3">
                    {row.steam_id64 ? <span className="font-mono">{row.steam_id64}</span> : null}
                    {row.eos_id ? <span className="font-mono">{row.eos_id}</span> : null}
                    <Button
                      size="sm"
                      aria-expanded={expanded}
                      onClick={() => setExpandedKey(expanded ? null : key)}
                    >
                      {expanded ? 'Скрыть' : `Показать (${row.bans.length})`}
                    </Button>
                  </div>
                </div>

                {expanded ? (
                  <ul className="divide-y divide-line rounded-ctl border border-line">
                    {row.bans.map((ban) => {
                      const status = banStatusBadge(ban);
                      return (
                        <li key={ban.id} className="p-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <span className="text-ink-2">{ban.source_name}</span>
                              <Badge size="sm" tone={TRUST_TONE[ban.trust_level] ?? 'neutral'}>
                                {trustLevelLabel(ban.trust_level)}
                              </Badge>
                              <Badge size="sm" tone={banStatusTone(ban)}>
                                {status.label}
                              </Badge>
                            </div>
                            <span className="text-ink-3">
                              {formatDate(ban.issued_at)}
                              {ban.expires_at ? ` → ${formatDate(ban.expires_at)}` : ''}
                            </span>
                          </div>
                          {ban.reason ? <p className="mt-1 text-ink-2">{ban.reason}</p> : null}
                          {ban.admin_name ? (
                            <p className="mt-0.5 text-ink-3">Админ: {ban.admin_name}</p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      {!loading && rows.length > 0 ? (
        <div className="flex justify-end">
          <Pagination
            page={page}
            pageCount={pageCount}
            onChange={(next) => navigate({ offset: (next - 1) * filters.limit })}
            allowJump
            labels={{
              previous: 'Назад',
              next: 'Вперёд',
              page: (current, of) => `Стр. ${current} из ${of}`,
            }}
          />
        </div>
      ) : null}
    </PageContainer>
  );
}
