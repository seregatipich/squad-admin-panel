'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import {
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
  TextInput,
  Th,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';

interface FeedNote {
  id: string;
  player_id: string;
  target: { id: string; name: string };
  author: { id: string; name: string; role_color: string | null; role_name: string | null };
  body: string;
  created_at: string;
  updated_at: string | null;
  edited: boolean;
  deleted: boolean;
  deleted_at: string | null;
  deleted_by: { id: string; name: string | null } | null;
}

interface FeedResponse {
  items: FeedNote[];
  next_cursor: string | null;
  can_view_deleted: boolean;
}

interface Author {
  id: string;
  name: string;
  role_color: string | null;
  role_name: string | null;
}

const BODY_TRUNCATE = 160;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

function buildParams(filters: {
  q: string;
  player: string;
  author: string;
  dateFrom: string;
  dateTo: string;
  includeDeleted: boolean;
  canViewDeleted: boolean;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.player.trim()) params.set('player', filters.player.trim());
  if (filters.author) params.set('author', filters.author);
  if (filters.dateFrom) params.set('dateFrom', `${filters.dateFrom}T00:00:00`);
  if (filters.dateTo) params.set('dateTo', `${filters.dateTo}T23:59:59`);
  if (filters.canViewDeleted && filters.includeDeleted) params.set('includeDeleted', 'true');
  return params;
}

export default function NotesFeedPage() {
  const [rows, setRows] = useState<FeedNote[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [canViewDeleted, setCanViewDeleted] = useState(false);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [q, setQ] = useState('');
  const [player, setPlayer] = useState('');
  const [author, setAuthor] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const playerId = useId();
  const authorId = useId();
  const fromId = useId();
  const toId = useId();

  const filters = useMemo(
    () => ({ q, player, author, dateFrom, dateTo, includeDeleted, canViewDeleted }),
    [q, player, author, dateFrom, dateTo, includeDeleted, canViewDeleted],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildParams(filters);
      const res = await fetch(`/api/v1/notes?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as FeedResponse;
      setRows(body.items);
      setNextCursor(body.next_cursor);
      setCanViewDeleted(body.can_view_deleted);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch('/api/v1/notes/authors', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((body: { items: Author[] }) => setAuthors(body.items))
      .catch(() => setAuthors([]));
  }, []);

  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const params = buildParams(filters);
      params.set('cursor', nextCursor);
      const res = await fetch(`/api/v1/notes?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as FeedResponse;
      setRows((prev) => [...prev, ...body.items]);
      setNextCursor(body.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      const params = buildParams(filters);
      const res = await fetch(`/api/v1/notes/export?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `notes-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtersApplied =
    q.trim() !== '' ||
    player.trim() !== '' ||
    author !== '' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    includeDeleted;

  function resetFilters() {
    setQ('');
    setPlayer('');
    setAuthor('');
    setDateFrom('');
    setDateTo('');
    setIncludeDeleted(false);
  }

  // Слот сброса у `Toolbar` — пара «обработчик + подпись» или ничего.
  const resetProps: ToolbarProps = filtersApplied
    ? { onReset: resetFilters, resetLabel: 'Сбросить фильтр' }
    : {};

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Заметки"
        subtitle="Кросс-игровая лента заметок админов по всем игрокам: накопленное знание о игроках и подотчётность стаффа."
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить заметки"
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
            value={q}
            onCommit={setQ}
            label="Поиск по тексту"
            placeholder="фрагмент заметки"
            clearLabel="Очистить поиск"
          />
        }
        filters={
          <>
            <label htmlFor={playerId} className="text-xs text-ink-3">
              Игрок
            </label>
            <TextInput
              id={playerId}
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              placeholder="ник (с учётом истории)"
              className="w-44"
            />
            <label htmlFor={authorId} className="text-xs text-ink-3">
              Автор
            </label>
            <Select id={authorId} value={author} onChange={(e) => setAuthor(e.target.value)}>
              <option value="">Все</option>
              {authors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <label htmlFor={fromId} className="text-xs text-ink-3">
              С даты
            </label>
            <TextInput
              id={fromId}
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-36"
            />
            <label htmlFor={toId} className="text-xs text-ink-3">
              По дату
            </label>
            <TextInput
              id={toId}
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-36"
            />
            {canViewDeleted ? (
              <Checkbox
                label="Показывать удалённые"
                checked={includeDeleted}
                onChange={(e) => setIncludeDeleted(e.target.checked)}
              />
            ) : null}
          </>
        }
        {...resetProps}
        actions={
          <Button onClick={() => void exportCsv()} loading={busy}>
            Экспорт CSV
          </Button>
        }
      />

      <Card padding="none">
        {loading ? (
          <div className="p-3">
            <SkeletonTable rows={6} cols={4} label="Загрузка заметок" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title={filtersApplied ? 'Ничего не нашлось' : 'Заметок пока нет'}
            description={
              filtersApplied
                ? 'Ни одна заметка не подходит под запрос и выбранные фильтры.'
                : 'Админы ещё не оставили ни одной заметки об игроках.'
            }
            action={filtersApplied ? <Button onClick={resetFilters}>Сбросить фильтр</Button> : null}
          />
        ) : (
          <Table ariaLabel="Лента заметок админов">
            <TableHead>
              <tr>
                <Th>Дата</Th>
                <Th>Автор</Th>
                <Th>Игрок</Th>
                <Th>Заметка</Th>
              </tr>
            </TableHead>
            <TableBody>
              {rows.map((note) => {
                const isExpanded = expanded.has(note.id);
                const isLong = note.body.length > BODY_TRUNCATE;
                const shown =
                  isExpanded || !isLong ? note.body : `${note.body.slice(0, BODY_TRUNCATE)}…`;
                return (
                  <TableRow key={note.id}>
                    <Td className="whitespace-nowrap align-top text-ink-3">
                      {formatDate(note.created_at)}
                      {note.edited ? <span className="ml-1 text-ink-4">(изм.)</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap align-top">
                      <span className="inline-flex items-center gap-2">
                        <RoleColorDot color={note.author.role_color ?? 'neutral'} size="sm" />
                        <span className="text-ink">{note.author.name}</span>
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap align-top">
                      <Link
                        href={`/all-players/${note.player_id}#notes`}
                        className="text-accent no-underline hover:brightness-110"
                      >
                        {note.target.name}
                      </Link>
                    </Td>
                    <Td className="align-top">
                      <span
                        className={`whitespace-pre-wrap break-words ${
                          note.deleted ? 'text-ink-3 line-through' : 'text-ink'
                        }`}
                      >
                        {shown}
                      </span>
                      {isLong ? (
                        <Button
                          variant="plain"
                          size="sm"
                          aria-expanded={isExpanded}
                          onClick={() => toggleExpand(note.id)}
                        >
                          {isExpanded ? 'свернуть' : 'ещё'}
                        </Button>
                      ) : null}
                      {note.deleted ? (
                        <span className="mt-1 block text-xs text-crit">
                          удалено{note.deleted_by?.name ? `: ${note.deleted_by.name}` : ''}
                        </span>
                      ) : null}
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {nextCursor ? (
        <div className="flex justify-center">
          <Button onClick={() => void loadMore()} loading={busy}>
            Показать ещё
          </Button>
        </div>
      ) : null}
    </PageContainer>
  );
}
