'use client';

import {
  BANNED_NAME_ACTIONS,
  BANNED_NAME_MATCH_TYPES,
  BANNED_NAME_PATTERN_MAX,
  type BannedNameAction,
  type BannedNameMatchType,
  matchBannedName,
  validateBannedNamePattern,
} from '@squad/shared-config/banned-names';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

interface BannedNameRule {
  id: string;
  pattern: string;
  match_type: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
  is_active: boolean;
  author_name: string | null;
  created_at: string;
  hit_count: number;
  last_hit_at: string | null;
}

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

interface FormState {
  pattern: string;
  match_type: BannedNameMatchType;
  action: BannedNameAction;
  reason: string;
  is_active: boolean;
}

const EMPTY_FORM: FormState = {
  pattern: '',
  match_type: 'exact',
  action: 'kick',
  reason: '',
  is_active: true,
};

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
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [testNick, setTestNick] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const patternInputId = useId();
  const testInputId = useId();
  const searchId = useId();
  const typeFilterId = useId();
  const activeFilterId = useId();
  const matchTypeId = useId();
  const actionId = useId();
  const reasonId = useId();

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

  const trimmedPattern = form.pattern.trim();
  const patternValidation = useMemo(
    () => validateBannedNamePattern(trimmedPattern, form.match_type),
    [trimmedPattern, form.match_type],
  );
  const previewMatches = useMemo(() => {
    if (!trimmedPattern || testNick.length === 0) return null;
    return matchBannedName(trimmedPattern, form.match_type, testNick);
  }, [trimmedPattern, form.match_type, testNick]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setTestNick('');
    setMsg(null);
    setModalOpen(true);
  }

  function openEdit(rule: BannedNameRule) {
    setEditingId(rule.id);
    setForm({
      pattern: rule.pattern,
      match_type: rule.match_type,
      action: rule.action,
      reason: rule.reason ?? '',
      is_active: rule.is_active,
    });
    setTestNick('');
    setMsg(null);
    setModalOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmedPattern) {
      setMsg({ kind: 'err', text: 'Паттерн не может быть пустым.' });
      return;
    }
    if (!patternValidation.ok) {
      setMsg({ kind: 'err', text: `Некорректный паттерн: ${patternValidation.error}` });
      return;
    }
    setSubmitting(true);
    setMsg(null);
    const payload = {
      pattern: trimmedPattern,
      match_type: form.match_type,
      action: form.action,
      reason: form.reason.trim() ? form.reason.trim() : null,
      is_active: form.is_active,
    };
    try {
      const res = await fetch(
        editingId ? `/api/v1/banned-names/${editingId}` : '/api/v1/banned-names',
        {
          method: editingId ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const detail = body.detail ?? body.error ?? `HTTP ${res.status}`;
        throw new Error(String(detail));
      }
      setModalOpen(false);
      setMsg({ kind: 'ok', text: editingId ? 'Правило обновлено.' : 'Правило добавлено.' });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
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
                <th className="py-2 pr-2">Статус</th>
                {canMutate ? <th className="py-2 pr-2"></th> : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={canMutate ? 9 : 8}
                    className="py-3 text-center text-xs text-neutral-500"
                  >
                    Загрузка…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={canMutate ? 9 : 8}
                    className="py-3 text-center text-xs text-neutral-500"
                  >
                    Правил пока нет.
                  </td>
                </tr>
              ) : (
                rows.map((rule) => (
                  <tr key={rule.id} className="border-t border-neutral-900 align-top">
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

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="mt-16 w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editingId ? 'Изменить правило' : 'Новое правило'}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-sm text-neutral-400 hover:text-neutral-200"
              >
                Закрыть
              </button>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label htmlFor={patternInputId} className="mb-1 block text-xs text-neutral-500">
                  Паттерн
                </label>
                <input
                  id={patternInputId}
                  type="text"
                  value={form.pattern}
                  maxLength={BANNED_NAME_PATTERN_MAX}
                  onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
                  placeholder="напр. AdolfHitler или ^\\[ISIS\\]"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm focus:border-neutral-600 focus:outline-none"
                />
                {trimmedPattern && !patternValidation.ok ? (
                  <p className="mt-1 text-xs text-red-400">{patternValidation.error}</p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={matchTypeId} className="mb-1 block text-xs text-neutral-500">
                    Тип матчинга
                  </label>
                  <select
                    id={matchTypeId}
                    value={form.match_type}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, match_type: e.target.value as BannedNameMatchType }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                  >
                    {BANNED_NAME_MATCH_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {MATCH_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={actionId} className="mb-1 block text-xs text-neutral-500">
                    Действие
                  </label>
                  <select
                    id={actionId}
                    value={form.action}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, action: e.target.value as BannedNameAction }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                  >
                    {BANNED_NAME_ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {ACTION_LABELS[a]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor={reasonId} className="mb-1 block text-xs text-neutral-500">
                  Причина (необязательно)
                </label>
                <input
                  id={reasonId}
                  type="text"
                  value={form.reason}
                  maxLength={512}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                />
                Активно
              </label>

              <div className="rounded border border-neutral-800 bg-neutral-900 p-3 space-y-2">
                <label htmlFor={testInputId} className="block text-xs text-neutral-500">
                  Проверить ник против правила
                </label>
                <input
                  id={testInputId}
                  type="text"
                  value={testNick}
                  onChange={(e) => setTestNick(e.target.value)}
                  placeholder="Введите тестовый ник"
                  className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
                {previewMatches === null ? (
                  <p className="text-xs text-neutral-500">
                    Введите паттерн и тестовый ник, чтобы увидеть результат.
                  </p>
                ) : previewMatches ? (
                  <p className="text-xs text-red-300">Совпадение — ник будет заблокирован.</p>
                ) : (
                  <p className="text-xs text-emerald-300">Нет совпадения — ник пройдёт.</p>
                )}
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={submitting || !trimmedPattern || !patternValidation.ok}
                  className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
                >
                  {submitting ? 'Сохранение…' : editingId ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
