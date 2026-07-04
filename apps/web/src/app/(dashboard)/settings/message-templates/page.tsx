'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import { TemplatePicker } from '@/components/TemplatePicker';
import {
  CATEGORY_LABELS,
  LOCALE_LABELS,
  MESSAGE_BODY_MAX,
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_LOCALES,
  type MessageTemplate,
  type MessageTemplateCategory,
  type MessageTemplateLocale,
  substituteTokens,
} from '@/lib/messageTemplates';

interface Me {
  permissions: string[];
}

interface DraftForm {
  title: string;
  body: string;
  category: MessageTemplateCategory;
  locale: MessageTemplateLocale;
  sortOrder: number;
}

const EMPTY_DRAFT: DraftForm = {
  title: '',
  body: '',
  category: 'warn',
  locale: 'ru',
  sortOrder: 0,
};

export default function MessageTemplatesPage() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [samplePlayer, setSamplePlayer] = useState('Игрок42');
  const [sampleServer, setSampleServer] = useState('Squad #1');
  const [composed, setComposed] = useState('');

  const titleId = useId();
  const bodyId = useId();
  const canEdit = useMemo(() => me?.permissions.includes('role:edit') ?? false, [me]);
  const sampleContext = useMemo(
    () => ({ player: samplePlayer, server: sampleServer }),
    [samplePlayer, sampleServer],
  );

  async function loadTemplates() {
    const res = await fetch('/api/v1/message-templates', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setTemplates((await res.json()) as MessageTemplate[]);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, tplRes] = await Promise.all([
          fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/message-templates', { credentials: 'include', cache: 'no-store' }),
        ]);
        if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
        if (!tplRes.ok) throw new Error(`HTTP ${tplRes.status}`);
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setTemplates((await tplRes.json()) as MessageTemplate[]);
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

  function startEdit(template: MessageTemplate) {
    setEditingId(template.id);
    setDraft({
      title: template.title,
      body: template.body,
      category: template.category,
      locale: template.locale,
      sortOrder: template.sort_order,
    });
    setMsg(null);
  }

  async function submitDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.title.trim()) {
      setMsg({ kind: 'err', text: 'Укажите название шаблона.' });
      return;
    }
    if (!draft.body.trim()) {
      setMsg({ kind: 'err', text: 'Текст шаблона не может быть пустым.' });
      return;
    }
    if (draft.body.length > MESSAGE_BODY_MAX) {
      setMsg({ kind: 'err', text: `Текст длиннее ${MESSAGE_BODY_MAX} символов.` });
      return;
    }
    setBusy(true);
    setMsg(null);
    const payload = {
      title: draft.title.trim(),
      body: draft.body,
      category: draft.category,
      locale: draft.locale,
      sort_order: draft.sortOrder,
    };
    try {
      const res = await fetch(
        editingId ? `/api/v1/message-templates/${editingId}` : '/api/v1/message-templates',
        {
          method: editingId ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${body.error ?? 'ошибка'}`);
      }
      await loadTemplates();
      resetDraft();
      setMsg({ kind: 'ok', text: editingId ? 'Шаблон обновлён.' : 'Шаблон создан.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(template: MessageTemplate) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/message-templates/${template.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_enabled: !template.is_enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadTemplates();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(template: MessageTemplate) {
    if (!confirm(`Удалить шаблон «${template.title}»?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/message-templates/${template.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (editingId === template.id) resetDraft();
      await loadTemplates();
      setMsg({ kind: 'ok', text: 'Шаблон удалён.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  const bodyPreview = substituteTokens(draft.body, sampleContext);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Шаблоны сообщений</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Заготовленные фразы для модерации. Токены{' '}
          <code className="rounded bg-neutral-800 px-1 text-xs">{'{player}'}</code> и{' '}
          <code className="rounded bg-neutral-800 px-1 text-xs">{'{server}'}</code> подставляются
          при отправке. Отключённые шаблоны не показываются в композере.
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
            {editingId ? 'Редактировать шаблон' : 'Новый шаблон'}
          </h2>
          <form onSubmit={submitDraft} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <label htmlFor={titleId} className="mb-1 block text-xs text-neutral-500">
                  Название
                </label>
                <input
                  id={titleId}
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  maxLength={120}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${titleId}-cat`}>
                  Категория
                </label>
                <select
                  id={`${titleId}-cat`}
                  value={draft.category}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      category: e.target.value as MessageTemplateCategory,
                    }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                >
                  {MESSAGE_TEMPLATE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${titleId}-loc`}>
                  Язык
                </label>
                <select
                  id={`${titleId}-loc`}
                  value={draft.locale}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, locale: e.target.value as MessageTemplateLocale }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                >
                  {MESSAGE_TEMPLATE_LOCALES.map((locale) => (
                    <option key={locale} value={locale}>
                      {LOCALE_LABELS[locale]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label
                htmlFor={bodyId}
                className="mb-1 flex justify-between text-xs text-neutral-500"
              >
                <span>Текст</span>
                <span className={draft.body.length > MESSAGE_BODY_MAX ? 'text-red-400' : ''}>
                  {draft.body.length} / {MESSAGE_BODY_MAX}
                </span>
              </label>
              <textarea
                id={bodyId}
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                maxLength={MESSAGE_BODY_MAX}
                rows={3}
                placeholder="{player}, освободите технику без экипажа на {server}."
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
              {draft.body ? (
                <p className="mt-1 text-xs text-neutral-500">
                  Предпросмотр: <span className="text-neutral-300">{bodyPreview}</span>
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <div>
                <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${titleId}-sort`}>
                  Порядок
                </label>
                <input
                  id={`${titleId}-sort`}
                  type="number"
                  min={0}
                  value={draft.sortOrder}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, sortOrder: Number(e.target.value) || 0 }))
                  }
                  className="w-24 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
              </div>
              <div className="flex items-end gap-2 self-stretch pt-5">
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
          Шаблоны ({templates.length})
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">Название</th>
                <th className="py-2 pr-2">Категория</th>
                <th className="py-2 pr-2">Язык</th>
                <th className="py-2 pr-2">Текст</th>
                <th className="py-2 pr-2">Порядок</th>
                <th className="py-2 pr-2">Статус</th>
                {canEdit ? <th className="py-2 pr-2"></th> : null}
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td
                    colSpan={canEdit ? 7 : 6}
                    className="py-3 text-center text-xs text-neutral-500"
                  >
                    Шаблонов пока нет.
                  </td>
                </tr>
              ) : (
                templates.map((template) => (
                  <tr key={template.id} className="border-t border-neutral-900 align-top">
                    <td className="py-2 pr-2 text-neutral-200">{template.title}</td>
                    <td className="py-2 pr-2 text-neutral-400">
                      {CATEGORY_LABELS[template.category]}
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">{LOCALE_LABELS[template.locale]}</td>
                    <td className="max-w-md py-2 pr-2 text-neutral-400">{template.body}</td>
                    <td className="py-2 pr-2 text-neutral-500">{template.sort_order}</td>
                    <td className="py-2 pr-2">
                      {template.is_enabled ? (
                        <span className="rounded bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-300">
                          включён
                        </span>
                      ) : (
                        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                          отключён
                        </span>
                      )}
                    </td>
                    {canEdit ? (
                      <td className="py-2 pr-2 text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => toggleEnabled(template)}
                            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
                          >
                            {template.is_enabled ? 'Выкл' : 'Вкл'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(template)}
                            className="rounded border border-sky-900 px-2 py-0.5 text-xs text-sky-300 hover:border-sky-700 disabled:opacity-40"
                          >
                            Изм.
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => deleteTemplate(template)}
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

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Пробный композер</h2>
        <p className="text-xs text-neutral-500">
          Выбор шаблона подставляет токены и заполняет поле. Отключённые шаблоны здесь не
          показываются.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-neutral-500">
              {'{player}'}
              <input
                type="text"
                value={samplePlayer}
                onChange={(e) => setSamplePlayer(e.target.value)}
                className="mt-1 w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </label>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">
              {'{server}'}
              <input
                type="text"
                value={sampleServer}
                onChange={(e) => setSampleServer(e.target.value)}
                className="mt-1 w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </label>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="max-h-80 overflow-y-auto pr-1">
            <TemplatePicker templates={templates} context={sampleContext} onSelect={setComposed} />
          </div>
          <textarea
            value={composed}
            onChange={(e) => setComposed(e.target.value)}
            rows={6}
            placeholder="Выберите шаблон слева…"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
      </section>
    </div>
  );
}
