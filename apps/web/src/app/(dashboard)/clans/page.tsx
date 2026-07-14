'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ClanSortField, SortOrder } from './helpers';
import { paginate, priorityBadge, sortClans } from './helpers';

interface Clan {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
  member_count: number;
  priority_count: number;
  max_priority_slots: number;
  priority_expires_at: string | null;
  is_tag_protected: boolean;
  is_public: boolean;
  primary_server_id: string | null;
}

interface ClansResponse {
  items: Clan[];
  total: number;
}

interface ServerOption {
  id: string;
  display_name: string;
}

interface MeResponse {
  can_manage_clans: boolean;
}

const PAGE_SIZE = 25;

const BADGE_TONE_CLASSES: Record<'neutral' | 'danger' | 'warning', string> = {
  neutral: 'bg-neutral-800 text-neutral-300',
  danger: 'bg-red-950 text-red-300',
  warning: 'bg-amber-950 text-amber-300',
};

export default function ClansPage() {
  const router = useRouter();
  const [data, setData] = useState<ClansResponse | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [canManageClans, setCanManageClans] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ClanSortField>('name');
  const [order, setOrder] = useState<SortOrder>('asc');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/clans', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(`Не удалось загрузить кланы (${res.status})`);
      setData((await res.json()) as ClansResponse);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const loadServers = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { items: ServerOption[] };
      setServers(body.items);
    } catch {
      /* server names are a display nicety only */
    }
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as MeResponse;
      setCanManageClans(body.can_manage_clans);
    } catch {
      /* leave the create button hidden on failure */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadServers();
    void loadMe();
  }, [load, loadServers, loadMe]);

  const serverNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) map.set(server.id, server.display_name);
    return map;
  }, [servers]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.items;
    return data.items.filter(
      (clan) =>
        clan.name.toLowerCase().includes(needle) ||
        clan.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [data, q]);

  const sorted = useMemo(() => sortClans(filtered, sort, order), [filtered, sort, order]);
  const paged = useMemo(() => paginate(sorted, page, PAGE_SIZE), [sorted, page]);

  useEffect(() => {
    setPage(1);
  }, [q, sort, order]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Кланы</h1>
        <div className="flex items-center gap-3">
          <div className="text-xs text-neutral-500">всего: {data?.total ?? 0}</div>
          {canManageClans ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
            >
              Создать клан
            </button>
          ) : null}
        </div>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по имени или тегу…"
          className="flex-1 min-w-[260px] rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          Сортировка
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as ClanSortField)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-200"
          >
            <option value="name">Название</option>
            <option value="members">Участники</option>
            <option value="priority">Приоритет</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
          className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-300 hover:bg-neutral-800"
          title="Направление сортировки"
        >
          {order === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {paged.items.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          {data?.items.length ? 'Нет совпадений.' : 'Кланы ещё не созданы.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2">Название</th>
                <th className="text-left p-2">Теги</th>
                <th className="text-left p-2">Участников</th>
                <th className="text-left p-2">Приоритет</th>
                <th className="text-left p-2">Срок приоритета</th>
                <th className="text-left p-2">Основной сервер</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((clan) => {
                const badge = priorityBadge(clan.priority_expires_at);
                return (
                  <tr key={clan.id} className="border-t border-neutral-900 hover:bg-neutral-900/40">
                    <td className="p-2">
                      <Link href={`/clans/${clan.id}`} className="text-sky-400 hover:text-sky-300">
                        {clan.name}
                      </Link>
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {clan.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-300"
                          >
                            {tag}
                          </span>
                        ))}
                        {clan.is_tag_protected ? (
                          <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-xs text-emerald-300">
                            Тег защищён
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-2">{clan.member_count}</td>
                    <td className="p-2 text-neutral-400">
                      {clan.priority_count} / {clan.max_priority_slots}
                    </td>
                    <td className="p-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${BADGE_TONE_CLASSES[badge.tone]}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="p-2 text-neutral-400">
                      {clan.primary_server_id
                        ? (serverNameById.get(clan.primary_server_id) ?? '—')
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {paged.pageCount > 1 ? (
        <div className="flex items-center justify-center gap-3 text-sm text-neutral-400">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1 hover:bg-neutral-800 disabled:opacity-40"
          >
            Назад
          </button>
          <span>
            Стр. {paged.page} из {paged.pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((prev) => Math.min(paged.pageCount, prev + 1))}
            disabled={page >= paged.pageCount}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1 hover:bg-neutral-800 disabled:opacity-40"
          >
            Вперёд
          </button>
        </div>
      ) : null}

      {createOpen ? (
        <CreateClanModal
          servers={servers}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => router.push(`/clans/${id}`)}
        />
      ) : null}
    </div>
  );
}

interface CreateClanForm {
  name: string;
  description: string;
  tags: string;
  max_priority_slots: string;
  primary_server_id: string;
  is_public: boolean;
  is_tag_protected: boolean;
}

const EMPTY_CREATE_FORM: CreateClanForm = {
  name: '',
  description: '',
  tags: '',
  max_priority_slots: '10',
  primary_server_id: '',
  is_public: false,
  is_tag_protected: false,
};

function CreateClanModal({
  servers,
  onClose,
  onCreated,
}: {
  servers: ServerOption[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState<CreateClanForm>(EMPTY_CREATE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const descriptionId = useId();
  const tagsId = useId();
  const slotsId = useId();
  const serverId = useId();

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const name = form.name.trim();
      if (!name) {
        setError('Название не может быть пустым.');
        return;
      }
      setSubmitting(true);
      setError(null);
      const tags = form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      const slots = Number.parseInt(form.max_priority_slots, 10);
      try {
        const res = await fetch('/api/v1/clans', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            description: form.description.trim() ? form.description.trim() : null,
            tags,
            max_priority_slots: Number.isFinite(slots) ? slots : undefined,
            primary_server_id: form.primary_server_id || null,
            is_public: form.is_public,
            is_tag_protected: form.is_tag_protected,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(`Не удалось создать клан: ${body.error ?? res.status}`);
          return;
        }
        const created = (await res.json()) as { id: string };
        onCreated(created.id);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="mt-16 w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Новый клан</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            Закрыть
          </button>
        </div>

        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor={nameId} className="mb-1 block text-xs text-neutral-500">
              Название
            </label>
            <input
              id={nameId}
              type="text"
              value={form.name}
              maxLength={32}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor={descriptionId} className="mb-1 block text-xs text-neutral-500">
              Описание (необязательно)
            </label>
            <textarea
              id={descriptionId}
              value={form.description}
              maxLength={2000}
              rows={3}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor={tagsId} className="mb-1 block text-xs text-neutral-500">
              Теги через запятую
            </label>
            <input
              id={tagsId}
              type="text"
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder="напр. TAG, ALT"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={slotsId} className="mb-1 block text-xs text-neutral-500">
                Слотов приоритета
              </label>
              <input
                id={slotsId}
                type="number"
                min={0}
                max={999}
                value={form.max_priority_slots}
                onChange={(e) => setForm((f) => ({ ...f, max_priority_slots: e.target.value }))}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor={serverId} className="mb-1 block text-xs text-neutral-500">
                Основной сервер
              </label>
              <select
                id={serverId}
                value={form.primary_server_id}
                onChange={(e) => setForm((f) => ({ ...f, primary_server_id: e.target.value }))}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              >
                <option value="">Без привязки</option>
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.display_name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={form.is_public}
                onChange={(e) => setForm((f) => ({ ...f, is_public: e.target.checked }))}
              />
              Публичный клан
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={form.is_tag_protected}
                onChange={(e) => setForm((f) => ({ ...f, is_tag_protected: e.target.checked }))}
              />
              Защита тега
            </label>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting || !form.name.trim()}
              className="rounded bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Создание…' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
