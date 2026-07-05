'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  CHAT_FLAG_LOCALES,
  CHAT_FLAG_PATTERN_TYPES,
  type ChatFlagLocale,
  type ChatFlagPatternType,
  type ChatFlagRule,
  countEnabled,
  LOCALE_LABELS,
  PATTERN_TYPE_LABELS,
  type ReindexSummary,
  summarizeReindex,
} from '@/lib/chatFlags';

interface Me {
  permissions: string[];
}

interface DraftForm {
  pattern: string;
  patternType: ChatFlagPatternType;
  locale: ChatFlagLocale;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftForm = {
  pattern: '',
  patternType: 'word',
  locale: 'all',
  enabled: true,
};

export default function ChatFlagsPage() {
  const [rules, setRules] = useState<ChatFlagRule[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [reindexDays, setReindexDays] = useState(7);

  const patternId = useId();
  const canEdit = useMemo(() => me?.permissions.includes('role:edit') ?? false, [me]);

  async function loadRules() {
    const res = await fetch('/api/v1/settings/chat-flag-rules', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setRules((await res.json()).items as ChatFlagRule[]);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, rulesRes] = await Promise.all([
          fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/settings/chat-flag-rules', { credentials: 'include', cache: 'no-store' }),
        ]);
        if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
        if (!rulesRes.ok) throw new Error(`HTTP ${rulesRes.status}`);
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setRules((await rulesRes.json()).items as ChatFlagRule[]);
      } catch (e) {
        if (!cancelled) setMsg({ kind: 'err', text: (e as Error).message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  }

  function startEdit(rule: ChatFlagRule) {
    setEditingId(rule.id);
    setDraft({
      pattern: rule.pattern,
      patternType: rule.pattern_type,
      locale: rule.locale,
      enabled: rule.enabled,
    });
    setMsg(null);
  }

  async function submitDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.pattern.trim()) {
      setMsg({ kind: 'err', text: 'Укажите паттерн правила.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    const payload = {
      pattern: draft.pattern.trim(),
      pattern_type: draft.patternType,
      locale: draft.locale,
      enabled: draft.enabled,
    };
    try {
      const res = await fetch(
        editingId
          ? `/api/v1/settings/chat-flag-rules/${editingId}`
          : '/api/v1/settings/chat-flag-rules',
        {
          method: editingId ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 422) {
          throw new Error(`Недопустимый паттерн: ${body.detail ?? 'ошибка валидации'}`);
        }
        if (res.status === 409) {
          throw new Error('Такое правило уже существует.');
        }
        throw new Error(`HTTP ${res.status}: ${body.error ?? 'ошибка'}`);
      }
      await loadRules();
      resetDraft();
      setMsg({ kind: 'ok', text: editingId ? 'Правило обновлено.' : 'Правило создано.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(rule: ChatFlagRule) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/settings/chat-flag-rules/${rule.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadRules();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(rule: ChatFlagRule) {
    if (!confirm(`Удалить правило «${rule.pattern}»?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/settings/chat-flag-rules/${rule.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (editingId === rule.id) resetDraft();
      await loadRules();
      setMsg({ kind: 'ok', text: 'Правило удалено.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function runReindex() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/settings/chat-flag-rules/reindex', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: reindexDays }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const summary = (await res.json()) as ReindexSummary;
      setMsg({ kind: 'ok', text: summarizeReindex(summary) });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Флаги чата</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Настраиваемые правила для серверной пометки токсичных сообщений. Новые сообщения
          проверяются воркером при записи; кнопка «переиндексировать» пере-помечает историю после
          изменения правил. Включено {countEnabled(rules)} из {rules.length}.
        </p>
      </div>

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

      {canEdit ? (
        <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">
            {editingId ? 'Редактировать правило' : 'Новое правило'}
          </h2>
          <form onSubmit={submitDraft} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <label htmlFor={patternId} className="mb-1 block text-xs text-neutral-500">
                  Паттерн
                </label>
                <input
                  id={patternId}
                  type="text"
                  value={draft.pattern}
                  onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
                  maxLength={200}
                  placeholder={draft.patternType === 'regex' ? 'сволоч[ьи]' : 'мудак'}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs text-neutral-500"
                  htmlFor={`${patternId}-type`}
                >
                  Тип
                </label>
                <select
                  id={`${patternId}-type`}
                  value={draft.patternType}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, patternType: e.target.value as ChatFlagPatternType }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                >
                  {CHAT_FLAG_PATTERN_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {PATTERN_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${patternId}-loc`}>
                  Язык
                </label>
                <select
                  id={`${patternId}-loc`}
                  value={draft.locale}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, locale: e.target.value as ChatFlagLocale }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                >
                  {CHAT_FLAG_LOCALES.map((locale) => (
                    <option key={locale} value={locale}>
                      {LOCALE_LABELS[locale]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  className="h-4 w-4"
                />
                Включено
              </label>
              <div className="ml-auto flex gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
                >
                  {editingId ? 'Сохранить' : 'Создать'}
                </button>
                {editingId ? (
                  <button
                    type="button"
                    onClick={resetDraft}
                    className="rounded border border-neutral-700 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-500"
                  >
                    Отмена
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        </section>
      ) : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Правила ({rules.length})
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">Паттерн</th>
                <th className="py-2 pr-2">Тип</th>
                <th className="py-2 pr-2">Язык</th>
                <th className="py-2 pr-2">Статус</th>
                <th className="py-2 pr-2">Автор</th>
                {canEdit ? <th className="py-2 pr-2"></th> : null}
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td
                    colSpan={canEdit ? 6 : 5}
                    className="py-3 text-center text-xs text-neutral-500"
                  >
                    Правил пока нет.
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr key={rule.id} className="border-t border-neutral-900 align-top">
                    <td className="py-2 pr-2 font-mono text-[12px] text-neutral-200">
                      {rule.pattern}
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">
                      {PATTERN_TYPE_LABELS[rule.pattern_type]}
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">{LOCALE_LABELS[rule.locale]}</td>
                    <td className="py-2 pr-2">
                      {rule.enabled ? (
                        <span className="rounded bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-300">
                          включено
                        </span>
                      ) : (
                        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                          отключено
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-neutral-500">{rule.author_name ?? 'Система'}</td>
                    {canEdit ? (
                      <td className="py-2 pr-2 text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => toggleEnabled(rule)}
                            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
                          >
                            {rule.enabled ? 'Выкл' : 'Вкл'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(rule)}
                            className="rounded border border-sky-900 px-2 py-0.5 text-xs text-sky-300 hover:border-sky-700 disabled:opacity-40"
                          >
                            Изм.
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => deleteRule(rule)}
                            className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                          >
                            Удл.
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {canEdit ? (
        <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Переиндексация</h2>
          <p className="text-xs text-neutral-500">
            Пере-помечает уже сохранённые сообщения за выбранный период по текущим правилам.
            Операция идемпотентна — повторный запуск не меняет уже согласованные строки.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${patternId}-days`}>
                Дней назад
              </label>
              <input
                id={`${patternId}-days`}
                type="number"
                min={1}
                max={365}
                value={reindexDays}
                onChange={(e) =>
                  setReindexDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-28 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={runReindex}
              className="rounded border border-amber-900 px-4 py-1.5 text-sm text-amber-300 hover:border-amber-700 disabled:opacity-40"
            >
              Переиндексировать
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
