'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
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
  SearchField,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { describeLoadError } from '@/lib/load-error';
import { type MarkTone, type MarkTypeOption, markIconEmoji, severityTone } from '@/lib/marks';
import { useApiResource } from '@/lib/use-polled-resource';

const NO_MARK_TYPES: MarkTypeOption[] = [];

interface SuspectMark {
  mark_type_id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
}

interface SuspectRole {
  id: string;
  name: string;
  color: string;
}

interface Suspect {
  id: string;
  steam_id64: string | null;
  eos_id: string | null;
  canonical_name: string;
  last_seen_at: string;
  role: SuspectRole | null;
  marks: SuspectMark[];
  has_active_ban: boolean;
}

interface SuspectsResponse {
  items: Suspect[];
  next_cursor: string | null;
}

type SortOption = 'last_seen_desc' | 'last_seen_asc';

/** Тяжесть метки — это состояние, и оно читается тоном пилюли (§5). */
const MARK_TONE: Record<MarkTone, BadgeTone> = {
  red: 'crit',
  amber: 'warn',
  neutral: 'neutral',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

function buildParams(filters: {
  markTypeIds: Set<number>;
  q: string;
  noActiveBan: boolean;
  sort: SortOption;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.markTypeIds.size > 0) {
    params.set('mark_type_ids', [...filters.markTypeIds].join(','));
  }
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.noActiveBan) params.set('no_active_ban', 'true');
  if (filters.sort !== 'last_seen_desc') params.set('sort', filters.sort);
  return params;
}

export function SuspectsBrowser() {
  const markTypesResource = useApiResource<MarkTypeOption[]>('/api/v1/mark-types');
  const markTypes = Array.isArray(markTypesResource.data) ? markTypesResource.data : NO_MARK_TYPES;
  const [rows, setRows] = useState<Suspect[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [markTypeIds, setMarkTypeIds] = useState<Set<number>>(new Set());
  const [noActiveBan, setNoActiveBan] = useState(false);
  const [sort, setSort] = useState<SortOption>('last_seen_desc');

  const sortId = useId();
  // Bumped by every first-page load; older responses compare against it and are dropped.
  const requestGeneration = useRef(0);

  const filters = useMemo(
    () => ({ markTypeIds, q, noActiveBan, sort }),
    [markTypeIds, q, noActiveBan, sort],
  );

  const load = useCallback(async () => {
    requestGeneration.current += 1;
    const generation = requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const params = buildParams(filters);
      const body = await apiFetch<SuspectsResponse>(`/api/v1/suspects?${params.toString()}`);
      if (generation !== requestGeneration.current) return;
      setRows(body.items);
      setNextCursor(body.next_cursor);
    } catch (e) {
      if (generation === requestGeneration.current) setError(describeLoadError(e));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor || busy) return;
    const generation = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const params = buildParams(filters);
      params.set('cursor', nextCursor);
      const body = await apiFetch<SuspectsResponse>(`/api/v1/suspects?${params.toString()}`);
      // A filter change while this page was in flight started a newer load.
      if (generation !== requestGeneration.current) return;
      setRows((prev) => [...prev, ...body.items]);
      setNextCursor(body.next_cursor);
    } catch (e) {
      if (generation === requestGeneration.current) setError(describeLoadError(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleMarkType(id: number) {
    setMarkTypeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtersApplied = q.trim() !== '' || markTypeIds.size > 0 || noActiveBan;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Метки"
        subtitle="Игроки с активными метками (читерство, гриферство и т.п.): быстрый доступ к подозрительным игрокам для проверки и модерации."
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить список"
          description={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <div className="space-y-3">
        <Toolbar
          search={
            <SearchField
              value={q}
              onCommit={setQ}
              label="Поиск по нику"
              placeholder="текущий или прошлый ник"
              clearLabel="Очистить поиск"
            />
          }
          filters={
            <>
              <Checkbox
                label="Без активного бана"
                checked={noActiveBan}
                onChange={(e) => setNoActiveBan(e.target.checked)}
              />
              <label htmlFor={sortId} className="text-xs text-ink-3">
                Сортировка
              </label>
              <Select
                id={sortId}
                value={sort}
                onChange={(e) => setSort(e.target.value as SortOption)}
              >
                <option value="last_seen_desc">Недавно на сервере</option>
                <option value="last_seen_asc">Давно не заходили</option>
              </Select>
            </>
          }
        />

        {markTypes.length > 0 ? (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Фильтр по типам меток</legend>
            {markTypes.map((type) => {
              const active = markTypeIds.has(type.id);
              return (
                <button
                  key={type.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleMarkType(type.id)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-ctl border px-2.5 text-2xs font-medium transition-colors duration-150 ${
                    active
                      ? 'border-accent bg-accent-dim text-ink'
                      : 'border-line bg-raised text-ink-2 hover:text-ink'
                  }`}
                >
                  <span aria-hidden>{markIconEmoji(type.icon)}</span>
                  <span>{type.label_ru}</span>
                </button>
              );
            })}
          </fieldset>
        ) : null}
      </div>

      <Card padding="none">
        {loading ? (
          <div className="p-3">
            <SkeletonTable rows={6} cols={4} label="Загрузка списка" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title="Подозреваемых не найдено."
            description={
              filtersApplied
                ? 'Ни один игрок не подходит под запрос и выбранные типы меток.'
                : 'Ни на одном игроке нет активных меток.'
            }
          />
        ) : (
          <>
            <Table ariaLabel="Игроки с активными метками">
              <TableHead>
                <tr>
                  <Th>Игрок</Th>
                  <Th>Метки</Th>
                  <Th>Последний визит</Th>
                  <Th>Бан</Th>
                </tr>
              </TableHead>
              <TableBody>
                {rows.map((suspect) => (
                  <TableRow key={suspect.id} interactive>
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/all-players/${suspect.id}`}
                        className="text-accent no-underline hover:brightness-110"
                      >
                        {suspect.canonical_name}
                      </Link>
                      {suspect.role ? (
                        <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-ink-3">
                          <RoleColorDot color={suspect.role.color} size="sm" />
                          {suspect.role.name}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {suspect.marks.map((mark) => (
                          <Badge
                            key={mark.mark_type_id}
                            size="sm"
                            tone={MARK_TONE[severityTone(mark.severity)]}
                            title={mark.label_ru}
                          >
                            <span aria-hidden>{markIconEmoji(mark.icon)}</span>
                            <span>{mark.label_ru}</span>
                          </Badge>
                        ))}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-ink-3">
                      {formatDate(suspect.last_seen_at)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {suspect.has_active_ban ? (
                        <Badge tone="crit">забанен</Badge>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {nextCursor ? (
              <div className="flex justify-center border-t border-line p-3">
                <Button onClick={() => void loadMore()} loading={busy}>
                  Показать ещё
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </PageContainer>
  );
}
