'use client';

import {
  BANNED_NAME_MATCH_TYPES,
  type BannedNameAction,
  type BannedNameMatchType,
} from '@squad/shared-config/banned-names';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  type BannedNameRule,
  type BannedNameRuleFormState,
  BannedNameRuleModal,
} from '@/components/BannedNameRuleModal';
import { LiveIndicator } from '@/components/LiveIndicator';

interface ListResponse {
  items: BannedNameRule[];
  total: number;
  page: number;
  page_size: number;
  can_mutate: boolean;
}

const PAGE_SIZE = 50;

const MATCH_TYPE_LABELS: Record<BannedNameMatchType, string> = {
  exact: 'Точное',
  substring: 'Вхождение',
  regex: 'Regex',
};

const ACTION_LABELS: Record<BannedNameAction, string> = {
  kick: 'Кик',
  alert: 'Уведомление',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export default function BannedNamesPage() {
  const [rows, setRows] = useState<BannedNameRule[]>([]);
  const [total, setTotal] = useState(0);
  const [canMutate, setCanMutate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const [search, setSearch] = useState('');
  const [matchTypeFilter, setMatchTypeFilter] = useState<'' | BannedNameMatchType>('');
  const [activeFilter, setActiveFilter] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalInitial, setModalInitial] = useState<Partial<BannedNameRuleFormState>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const searchId = useId();
  const typeFilterId = useId();
  const activeFilterId = useId();

  const searchParams = useSearchParams();
  const highlightedRuleId = searchParams.get('rule');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (matchTypeFilter) params.set('match_type', matchTypeFilter);
    if (activeFilter) params.set('is_active', activeFilter);
    params.set('page', String(page));
    params.set('page_size', String(PAGE_SIZE));
    try {
      const res = await fetch(`/api/v1/banned-names?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ListResponse;
      setRows(body.items);
      setTotal(body.total);
      setCanMutate(body.can_mutate);
      setLastUpdate(new Date());
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [search, matchTypeFilter, activeFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function openCreate() {
    setEditingId(null);
    setModalInitial({});
    setMsg(null);
    setModalOpen(true);
  }

  function openEdit(rule: BannedNameRule) {
    setEditingId(rule.id);
    setModalInitial({
      pattern: rule.pattern,
      match_type: rule.match_type,
      action: rule.action,
      reason: rule.reason ?? '',
      is_active: rule.is_active,
    });
    setMsg(null);
    setModalOpen(true);
  }

  async function handleSaved() {
    setModalOpen(false);
    setMsg({ kind: 'ok', text: editingId ? 'Правило обновлено.' : 'Правило добавлено.' });
    await load();
  }

  async function remove(rule: BannedNameRule) {
    if (!confirm(`Удалить правило «${rule.pattern}»?`)) return;
    setDeletingId(rule.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/banned-names/${rule.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMsg({ kind: 'ok', text: 'Правило удалено.' });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Забаненные ники</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="text-sm text-neutral-400">
        Чёрный список ников: правила проверяются при подключении игрока. Тип матчинга — точное
        совпадение, вхождение подстроки или регулярное выражение (регистр игнорируется для точного
        совпадения и вхождения).
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

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-48">
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={searchId}>
            Поиск по паттерну
          </label>
          <input
            id={searchId}
            type="text"
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            placeholder="напр. isis"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={typeFilterId}>
            Тип
          </label>
          <select
            id={typeFilterId}
            value={matchTypeFilter}
            onChange={(e) => {
              setPage(1);
              setMatchTypeFilter(e.target.value as '' | BannedNameMatchType);
            }}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          >
            <option value="">Все</option>
            {BANNED_NAME_MATCH_TYPES.map((t) => (
              <option key={t} value={t}>
                {MATCH_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={activeFilterId}>
            Статус
          </label>
          <select
            id={activeFilterId}
            value={activeFilter}
            onChange={(e) => {
              setPage(1);
              setActiveFilter(e.target.value as '' | 'true' | 'false');
            }}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          >
            <option value="">Все</option>
            <option value="true">Активные</option>
            <option value="false">Отключённые</option>
          </select>
        </div>
        {canMutate ? (
          <button
            type="button"
            onClick={openCreate}
            className="ml-auto rounded border border-emerald-900 px-4 py-2 text-sm text-emerald-300 hover:border-emerald-700"
          >
            Добавить правило
          </button>
        ) : null}
      </div>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">Паттерн</th>
                <th className="py-2 pr-2">Тип</th>
                <th className="py-2 pr-2">Действие</th>
                <th className="py-2 pr-2">Причина</th>
                <th className="py-2 pr-2">Автор</th>
                <th className="py-2 pr-2">Добавлен</th>
                <th className="py-2 pr-2">Hits</th>
                <th className="py-2 pr-2">Срабатывания</th>
                <th className="py-2 pr-2">Статус</th>
                {canMutate ? <th className="py-2 pr-2"></th> : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={canMutate ? 10 : 9}
                    className="py-3 text-center text-xs text-neutral-500"
                  >
                    Загрузка…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={canMutate ? 10 : 9}
                    className="py-3 text-center text-xs text-neutral-500"
                  >
                    Правил пока нет.
                  </td>
                </tr>
              ) : (
                rows.map((rule) => (
                  <tr
                    key={rule.id}
                    className={`border-t border-neutral-900 align-top ${
                      highlightedRuleId === rule.id
                        ? 'ring-1 ring-inset ring-sky-500 bg-sky-950/20'
                        : ''
                    }`}
                  >
                    <td className="py-2 pr-2 font-mono text-xs text-neutral-200 break-all">
                      {rule.pattern}
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">
                      {MATCH_TYPE_LABELS[rule.match_type]}
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">{ACTION_LABELS[rule.action]}</td>
                    <td className="py-2 pr-2 text-neutral-400">{rule.reason ?? '—'}</td>
                    <td className="py-2 pr-2 text-neutral-400">{rule.author_name ?? '—'}</td>
                    <td className="py-2 pr-2 text-neutral-400">{formatDate(rule.created_at)}</td>
                    <td className="py-2 pr-2 text-neutral-400">{rule.hit_count}</td>
                    <td className="py-2 pr-2">
                      {rule.hit_count > 0 ? (
                        <Link
                          href={`/events?kinds=banname.matched&rule=${rule.id}`}
                          className="text-sky-400 hover:text-sky-300"
                        >
                          Срабатывания
                        </Link>
                      ) : (
                        <span className="text-neutral-500">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      {rule.is_active ? (
                        <span className="rounded bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-300">
                          активно
                        </span>
                      ) : (
                        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                          отключено
                        </span>
                      )}
                    </td>
                    {canMutate ? (
                      <td className="py-2 pr-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openEdit(rule)}
                          className="rounded border border-neutral-700 px-3 py-0.5 text-xs text-neutral-300 hover:border-neutral-500"
                        >
                          Изменить
                        </button>
                        <button
                          type="button"
                          disabled={deletingId === rule.id}
                          onClick={() => remove(rule)}
                          className="ml-2 rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                        >
                          {deletingId === rule.id ? '…' : 'Удалить'}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-neutral-500">
          <span>
            Всего: {total} · Стр. {page} из {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-30"
            >
              Назад
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-30"
            >
              Вперёд
            </button>
          </div>
        </div>
      </section>

      <BannedNameRuleModal
        open={modalOpen}
        editingId={editingId}
        initial={modalInitial}
        onClose={() => setModalOpen(false)}
        onSaved={() => void handleSaved()}
      />
    </div>
  );
}
