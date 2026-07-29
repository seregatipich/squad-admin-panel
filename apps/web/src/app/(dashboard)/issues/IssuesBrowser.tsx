'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import type { IssueLabel, IssueView } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  authorLabel,
  BODY_MAX,
  buildApiQuery,
  buildQueryString,
  formatDateTime,
  type IssueFilters,
  issueMatchesFilters,
  PER_PAGE,
  parseFilters,
  removeIssue,
  STATE_BADGE_CLASSES,
  STATE_FILTERS,
  STATE_LABELS,
  TITLE_MAX,
  totalPages,
  upsertIssue,
  validateCreateForm,
} from './helpers';
import { type PickedPlayer, PlayerSearchSelect } from './PlayerSearchSelect';

interface IssueListResponse {
  items: IssueView[];
  total: number;
  page: number;
  per_page: number;
}

export function IssuesBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [issues, setIssues] = useState<IssueView[]>([]);
  const [total, setTotal] = useState(0);
  const [labels, setLabels] = useState<IssueLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assigneeName, setAssigneeName] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const idsRef = useRef<Set<string>>(new Set());

  const navigate = useCallback(
    (partial: Partial<IssueFilters>) => {
      const next: IssueFilters = {
        ...filters,
        ...partial,
        page: partial.page ?? 1,
      };
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    setSearchDraft(filters.q);
  }, [filters.q]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/issues/labels', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data: { items: IssueLabel[] }) => {
        if (!cancelled) setLabels(data.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/issues?${buildApiQuery(filters)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as IssueListResponse;
      idsRef.current = new Set(data.items.map((issue) => issue.id));
      setIssues(data.items);
      setTotal(data.total);
      setLastUpdate(new Date());
      const assigned = filters.assignee
        ? (data.items.find((issue) => issue.assignee_player_id === filters.assignee)?.assignee ??
          null)
        : null;
      if (assigned) setAssigneeName(assigned.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const onIssueEvent = useCallback(
    (event: { data: { issue: IssueView } }) => {
      if (filters.page !== 1) return;
      const issue = event.data.issue;
      const matches = issueMatchesFilters(issue, filters);
      const existed = idsRef.current.has(issue.id);
      if (matches && !existed) {
        idsRef.current.add(issue.id);
        setTotal((t) => t + 1);
      } else if (!matches && existed) {
        idsRef.current.delete(issue.id);
        setTotal((t) => Math.max(0, t - 1));
      }
      setIssues((prev) =>
        matches ? upsertIssue(prev, issue).slice(0, PER_PAGE) : removeIssue(prev, issue.id),
      );
    },
    [filters],
  );
  useLiveSubscription('issue.created', onIssueEvent);
  useLiveSubscription('issue.updated', onIssueEvent);

  const pages = totalPages(total);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Тикеты</h1>
        <div className="flex items-center gap-3">
          <LiveIndicator lastUpdate={lastUpdate} />
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700"
          >
            {showCreate ? 'Скрыть форму' : 'Создать'}
          </button>
        </div>
      </div>

      <p className="text-sm text-neutral-400">
        Внутренний трекер тикетов о панели: баги, предложения и вопросы. Любой пользователь панели
        может создать тикет и оставить комментарий.
      </p>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      {showCreate ? (
        <CreateIssueForm
          labels={labels}
          onCreated={(issue) => {
            setShowCreate(false);
            router.push(`/issues/${issue.id}`);
          }}
        />
      ) : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Тикеты ({total})</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ q: searchDraft.trim() });
            }}
            className="flex items-center gap-2"
          >
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Поиск по тикетам"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs focus:border-neutral-600 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-600"
            >
              Найти
            </button>
          </form>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {STATE_FILTERS.map((filter) => (
              <button
                key={filter.value || 'all'}
                type="button"
                onClick={() => navigate({ state: filter.value })}
                className={`rounded px-2 py-0.5 text-xs ${
                  filters.state === filter.value
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-1 text-xs text-neutral-500">
            Метка
            <select
              value={filters.label}
              onChange={(e) => navigate({ label: e.target.value })}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
            >
              <option value="">все</option>
              {labels.map((label) => (
                <option key={label.id} value={label.name}>
                  {label.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-2">
            {filters.assignee ? (
              <span className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200">
                {assigneeName
                  ? `Исполнитель: ${assigneeName}`
                  : `Исполнитель: ${filters.assignee.slice(0, 8)}…`}
                <button
                  type="button"
                  onClick={() => {
                    setAssigneeName(null);
                    navigate({ assignee: '' });
                  }}
                  className="text-neutral-400 hover:text-neutral-200"
                  aria-label="Сбросить исполнителя"
                >
                  ×
                </button>
              </span>
            ) : (
              <div className="w-52">
                <PlayerSearchSelect
                  placeholder="Фильтр по исполнителю"
                  onSelect={(player: PickedPlayer) => {
                    setAssigneeName(player.canonical_name);
                    navigate({ assignee: player.id });
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="py-8 text-center text-sm text-neutral-500">Загрузка…</div>
          ) : issues.length === 0 ? (
            <EmptyState onCreate={() => setShowCreate(true)} />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Заголовок</th>
                  <th className="py-2 pr-2">Метки</th>
                  <th className="py-2 pr-2">Автор</th>
                  <th className="py-2 pr-2">Исполнитель</th>
                  <th className="py-2 pr-2">Статус</th>
                  <th className="py-2 pr-2">Обновлён</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => (
                  <tr
                    key={issue.id}
                    className="border-t border-neutral-900 align-top hover:bg-neutral-900/40"
                  >
                    <td className="py-2 pr-2 font-mono text-xs text-neutral-500">
                      #{issue.number}
                    </td>
                    <td className="py-2 pr-2">
                      <Link
                        href={`/issues/${issue.id}`}
                        className="text-sky-400 hover:text-sky-300"
                      >
                        {issue.title}
                      </Link>
                    </td>
                    <td className="py-2 pr-2">
                      {issue.labels.length === 0 ? (
                        <span className="text-xs text-neutral-600">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {issue.labels.map((label) => (
                            <span
                              key={label.id}
                              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-neutral-100"
                              style={{ backgroundColor: label.color }}
                            >
                              {label.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-xs">
                      <Link
                        href={`/all-players/${issue.author_player_id}`}
                        className="text-neutral-300 hover:text-neutral-100"
                      >
                        {authorLabel(issue.author, issue.author_player_id)}
                      </Link>
                    </td>
                    <td className="py-2 pr-2 text-xs text-neutral-400">
                      {issue.assignee ? (
                        <Link
                          href={`/all-players/${issue.assignee.id}`}
                          className="hover:text-neutral-100"
                        >
                          {issue.assignee.name}
                        </Link>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${STATE_BADGE_CLASSES[issue.state]}`}
                      >
                        {STATE_LABELS[issue.state]}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-xs text-neutral-400">
                      {formatDateTime(issue.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!loading && issues.length > 0 ? (
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>
              Страница {filters.page} из {pages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={filters.page <= 1}
                onClick={() => navigate({ page: filters.page - 1 })}
                className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
              >
                Назад
              </button>
              <button
                type="button"
                disabled={filters.page >= pages}
                onClick={() => navigate({ page: filters.page + 1 })}
                className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
              >
                Вперёд
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded border border-dashed border-neutral-800 py-12 text-center">
      <p className="text-sm text-neutral-400">Тикетов пока нет.</p>
      <button
        type="button"
        onClick={onCreate}
        className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700"
      >
        Создать тикет
      </button>
    </div>
  );
}

function CreateIssueForm({
  labels,
  onCreated,
}: {
  labels: IssueLabel[];
  onCreated: (issue: IssueView) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();

  function toggleLabel(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const check = validateCreateForm({ title, body, labelCount: selected.size });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/issues', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          labels: Array.from(selected),
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${errBody.error ?? 'unknown'}`);
      }
      onCreated((await res.json()) as IssueView);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const titleOver = title.length > TITLE_MAX;
  const bodyOver = body.length > BODY_MAX;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Создать тикет</h2>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor={titleId} className="mb-1 flex justify-between text-xs text-neutral-500">
            <span>Заголовок</span>
            <span className={titleOver ? 'text-red-400' : 'text-neutral-600'}>
              {title.length}/{TITLE_MAX}
            </span>
          </label>
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Короткое описание проблемы"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor={bodyId} className="mb-1 flex justify-between text-xs text-neutral-500">
            <span>Описание</span>
            <span className={bodyOver ? 'text-red-400' : 'text-neutral-600'}>
              {body.length}/{BODY_MAX}
            </span>
          </label>
          <textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Что произошло, как воспроизвести"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        {labels.length > 0 ? (
          <div className="space-y-1">
            <span className="text-xs text-neutral-500">Метки</span>
            <div className="flex flex-wrap gap-2">
              {labels.map((label) => {
                const active = selected.has(label.name);
                return (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => toggleLabel(label.name)}
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      active ? 'text-neutral-950' : 'text-neutral-300 border border-neutral-700'
                    }`}
                    style={active ? { backgroundColor: label.color } : undefined}
                  >
                    {label.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={submitting || titleOver || bodyOver}
          className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
        >
          {submitting ? 'Создание…' : 'Создать тикет'}
        </button>
      </form>
    </section>
  );
}
