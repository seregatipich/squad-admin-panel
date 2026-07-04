'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

interface IssueLabel {
  id: string;
  name: string;
  color: string;
}

interface IssueListItem {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'in_progress' | 'closed';
  author_player_id: string;
  assignee_player_id: string | null;
  labels: IssueLabel[];
  created_at: string;
}

interface IssueListResponse {
  items: IssueListItem[];
  total: number;
  page: number;
  per_page: number;
}

const STATE_FILTERS: Array<{ value: '' | IssueListItem['state']; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'open', label: 'Открытые' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'closed', label: 'Закрытые' },
];

const STATE_LABELS: Record<IssueListItem['state'], string> = {
  open: 'Открыт',
  in_progress: 'В работе',
  closed: 'Закрыт',
};

const STATE_CLASSES: Record<IssueListItem['state'], string> = {
  open: 'bg-emerald-950/50 text-emerald-300',
  in_progress: 'bg-amber-950/50 text-amber-300',
  closed: 'bg-neutral-800 text-neutral-400',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

export default function IssuesPage() {
  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stateFilter, setStateFilter] = useState<'' | IssueListItem['state']>('');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const titleInputId = useId();
  const bodyInputId = useId();

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (stateFilter) params.set('state', stateFilter);
    if (query.trim()) params.set('q', query.trim());
    try {
      const res = await fetch(`/api/v1/issues?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as IssueListResponse;
      setIssues(data.items);
      setTotal(data.total);
      setLastUpdate(new Date());
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [stateFilter, query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createIssue(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) {
      setMsg({ kind: 'err', text: 'Заполните заголовок и описание.' });
      return;
    }
    setCreating(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/issues', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${errBody.error ?? 'unknown'}`);
      }
      setTitle('');
      setBody('');
      setMsg({ kind: 'ok', text: 'Тикет создан.' });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Тикеты</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="text-sm text-neutral-400">
        Внутренний трекер тикетов о панели: баги, предложения и вопросы. Любой пользователь панели
        может создать тикет и оставить комментарий.
      </p>

      {msg ? (
        <div
          className={`rounded border p-3 text-sm ${
            msg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Создать тикет</h2>
        <form onSubmit={createIssue} className="space-y-3">
          <div>
            <label htmlFor={titleInputId} className="mb-1 block text-xs text-neutral-500">
              Заголовок
            </label>
            <input
              id={titleInputId}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="Короткое описание проблемы"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor={bodyInputId} className="mb-1 block text-xs text-neutral-500">
              Описание
            </label>
            <textarea
              id={bodyInputId}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
              rows={3}
              placeholder="Что произошло, как воспроизвести"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
          >
            {creating ? 'Создание…' : 'Создать тикет'}
          </button>
        </form>
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Тикеты ({total})</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {STATE_FILTERS.map((filter) => (
                <button
                  key={filter.value || 'all'}
                  type="button"
                  onClick={() => setStateFilter(filter.value)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    stateFilter === filter.value
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs focus:border-neutral-600 focus:outline-none"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Заголовок</th>
                <th className="py-2 pr-2">Метки</th>
                <th className="py-2 pr-2">Статус</th>
                <th className="py-2 pr-2">Создан</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-3 text-center text-xs text-neutral-500">
                    Загрузка…
                  </td>
                </tr>
              ) : issues.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-center text-xs text-neutral-500">
                    Тикетов нет.
                  </td>
                </tr>
              ) : (
                issues.map((issue) => (
                  <tr key={issue.id} className="border-t border-neutral-900 align-top">
                    <td className="py-2 pr-2 font-mono text-xs text-neutral-500">
                      #{issue.number}
                    </td>
                    <td className="py-2 pr-2">{issue.title}</td>
                    <td className="py-2 pr-2">
                      {issue.labels.length === 0 ? (
                        <span className="text-xs text-neutral-500">—</span>
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
                    <td className="py-2 pr-2">
                      <span className={`rounded px-2 py-0.5 text-xs ${STATE_CLASSES[issue.state]}`}>
                        {STATE_LABELS[issue.state]}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">{formatDate(issue.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
