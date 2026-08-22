'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { getLiveBus } from '@/lib/live-bus';
import {
  isSameOrder,
  isValidSlug,
  MARK_TYPE_ICONS,
  MARK_TYPE_SEVERITY_MAX,
  MARK_TYPE_SEVERITY_MIN,
  type MarkType,
  moveItem,
  severityLabel,
  sortByOrder,
} from './helpers';

interface Me {
  permissions: string[];
}

interface DraftForm {
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
}

const EMPTY_DRAFT: DraftForm = {
  slug: '',
  label_en: '',
  label_ru: '',
  icon: MARK_TYPE_ICONS[0],
  severity: 3,
};

const SEVERITY_OPTIONS = Array.from(
  { length: MARK_TYPE_SEVERITY_MAX - MARK_TYPE_SEVERITY_MIN + 1 },
  (_, index) => MARK_TYPE_SEVERITY_MIN + index,
);

export default function MarkTypesPage() {
  const [types, setTypes] = useState<MarkType[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Omit<DraftForm, 'slug'>>({
    label_en: '',
    label_ru: '',
    icon: MARK_TYPE_ICONS[0],
    severity: 3,
  });
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const slugId = useId();
  const canEdit = useMemo(() => me?.permissions.includes('role:edit') ?? false, [me]);

  const loadTypes = useCallback(async () => {
    const res = await fetch('/api/v1/mark-types?include_inactive=true', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setTypes(sortByOrder((await res.json()) as MarkType[]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, typesRes] = await Promise.all([
          fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/mark-types?include_inactive=true', {
            credentials: 'include',
            cache: 'no-store',
          }),
        ]);
        if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
        if (!typesRes.ok) throw new Error(`HTTP ${typesRes.status}`);
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setTypes(sortByOrder((await typesRes.json()) as MarkType[]));
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

  useEffect(() => {
    const bus = getLiveBus();
    return bus.subscribe((event) => {
      if (event.type === 'mark_type.changed') void loadTypes();
    });
  }, [loadTypes]);

  async function createType(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidSlug(draft.slug)) {
      setMsg({ kind: 'err', text: 'Слаг: 2–40 символов, только a–z, 0–9 и подчёркивание.' });
      return;
    }
    if (!draft.label_en.trim() || !draft.label_ru.trim()) {
      setMsg({ kind: 'err', text: 'Заполните оба названия.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/mark-types', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: draft.slug.trim(),
          label_en: draft.label_en.trim(),
          label_ru: draft.label_ru.trim(),
          icon: draft.icon,
          severity: draft.severity,
        }),
      });
      if (res.status === 409) {
        setMsg({ kind: 'err', text: 'Тип с таким слагом уже существует.' });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDraft(EMPTY_DRAFT);
      await loadTypes();
      setMsg({ kind: 'ok', text: 'Тип метки создан и уже доступен в модалке установки.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function startEdit(type: MarkType) {
    setEditingId(type.id);
    setEditDraft({
      label_en: type.label_en,
      label_ru: type.label_ru,
      icon: type.icon,
      severity: type.severity,
    });
    setMsg(null);
  }

  async function saveEdit(id: number) {
    if (!editDraft.label_en.trim() || !editDraft.label_ru.trim()) {
      setMsg({ kind: 'err', text: 'Заполните оба названия.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/mark-types/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label_en: editDraft.label_en.trim(),
          label_ru: editDraft.label_ru.trim(),
          icon: editDraft.icon,
          severity: editDraft.severity,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingId(null);
      await loadTypes();
      setMsg({ kind: 'ok', text: 'Тип метки обновлён.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(type: MarkType) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/mark-types/${type.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_active: !type.is_active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadTypes();
      setMsg({
        kind: 'ok',
        text: type.is_active
          ? 'Тип деактивирован: скрыт из модалки, но сохранён в истории и фильтрах.'
          : 'Тип снова активен.',
      });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function persistOrder(next: MarkType[]) {
    const previous = types;
    setTypes(next);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/mark-types/reorder', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ordered_ids: next.map((t) => t.id) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadTypes();
    } catch (err) {
      setTypes(previous);
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = moveItem(types, dragIndex, targetIndex);
    setDragIndex(null);
    if (!isSameOrder(next, types)) void persistOrder(next);
  }

  if (loading) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Типы меток</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Справочник причин для меток подозрения. Порядок задаёт очерёдность в модалке установки.
          Деактивированный тип исчезает из модалки, но остаётся в истории игроков и фильтрах
          вотчлиста.
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
        <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Новый тип</h2>
          <form onSubmit={createType} className="grid grid-cols-1 gap-3 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <label htmlFor={slugId} className="mb-1 block text-xs text-neutral-500">
                Слаг (лат.)
              </label>
              <input
                id={slugId}
                type="text"
                value={draft.slug}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                maxLength={40}
                placeholder="ghost_peek"
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${slugId}-en`}>
                Название (EN)
              </label>
              <input
                id={`${slugId}-en`}
                type="text"
                value={draft.label_en}
                onChange={(e) => setDraft((d) => ({ ...d, label_en: e.target.value }))}
                maxLength={64}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${slugId}-ru`}>
                Название (RU)
              </label>
              <input
                id={`${slugId}-ru`}
                type="text"
                value={draft.label_ru}
                onChange={(e) => setDraft((d) => ({ ...d, label_ru: e.target.value }))}
                maxLength={64}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${slugId}-icon`}>
                Иконка
              </label>
              <select
                id={`${slugId}-icon`}
                value={draft.icon}
                onChange={(e) => setDraft((d) => ({ ...d, icon: e.target.value }))}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              >
                {MARK_TYPE_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {icon}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-neutral-500" htmlFor={`${slugId}-sev`}>
                Тяжесть
              </label>
              <select
                id={`${slugId}-sev`}
                value={draft.severity}
                onChange={(e) => setDraft((d) => ({ ...d, severity: Number(e.target.value) }))}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              >
                {SEVERITY_OPTIONS.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity} — {severityLabel(severity)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end sm:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="rounded border border-emerald-900 px-4 py-2 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
              >
                Создать тип
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Таксономия ({types.length})
        </h2>
        {canEdit ? (
          <p className="text-xs text-neutral-500">
            Перетаскивайте строки за <span className="text-neutral-300">⠿</span>, чтобы изменить
            порядок.
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                {canEdit ? <th className="w-6 py-2" /> : null}
                <th className="py-2 pr-2">Слаг</th>
                <th className="py-2 pr-2">EN</th>
                <th className="py-2 pr-2">RU</th>
                <th className="py-2 pr-2">Иконка</th>
                <th className="py-2 pr-2">Тяжесть</th>
                <th className="py-2 pr-2">Статус</th>
                {canEdit ? <th className="py-2 pr-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {types.length === 0 ? (
                <tr>
                  <td
                    colSpan={canEdit ? 8 : 6}
                    className="py-3 text-center text-xs text-neutral-500"
                  >
                    Типов пока нет.
                  </td>
                </tr>
              ) : (
                types.map((type, index) => {
                  const isEditing = editingId === type.id;
                  return (
                    <tr
                      key={type.id}
                      draggable={canEdit && !isEditing}
                      onDragStart={() => setDragIndex(index)}
                      onDragOver={(e) => {
                        if (dragIndex !== null) e.preventDefault();
                      }}
                      onDrop={() => handleDrop(index)}
                      className={`border-t border-neutral-900 align-top ${
                        dragIndex === index ? 'opacity-40' : ''
                      } ${type.is_active ? '' : 'text-neutral-500'}`}
                    >
                      {canEdit ? (
                        <td className="cursor-grab py-2 pr-1 text-neutral-500" aria-hidden>
                          ⠿
                        </td>
                      ) : null}
                      <td className="py-2 pr-2 font-mono text-xs text-neutral-400">{type.slug}</td>
                      {isEditing ? (
                        <>
                          <td className="py-2 pr-2">
                            <input
                              value={editDraft.label_en}
                              onChange={(e) =>
                                setEditDraft((d) => ({ ...d, label_en: e.target.value }))
                              }
                              maxLength={64}
                              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                            />
                          </td>
                          <td className="py-2 pr-2">
                            <input
                              value={editDraft.label_ru}
                              onChange={(e) =>
                                setEditDraft((d) => ({ ...d, label_ru: e.target.value }))
                              }
                              maxLength={64}
                              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                            />
                          </td>
                          <td className="py-2 pr-2">
                            <select
                              value={editDraft.icon}
                              onChange={(e) =>
                                setEditDraft((d) => ({ ...d, icon: e.target.value }))
                              }
                              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                            >
                              {MARK_TYPE_ICONS.map((icon) => (
                                <option key={icon} value={icon}>
                                  {icon}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 pr-2">
                            <select
                              value={editDraft.severity}
                              onChange={(e) =>
                                setEditDraft((d) => ({ ...d, severity: Number(e.target.value) }))
                              }
                              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                            >
                              {SEVERITY_OPTIONS.map((severity) => (
                                <option key={severity} value={severity}>
                                  {severity}
                                </option>
                              ))}
                            </select>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="py-2 pr-2 text-neutral-300">{type.label_en}</td>
                          <td className="py-2 pr-2 text-neutral-200">{type.label_ru}</td>
                          <td className="py-2 pr-2 font-mono text-xs text-neutral-400">
                            {type.icon}
                          </td>
                          <td className="py-2 pr-2 text-neutral-400">
                            {type.severity} — {severityLabel(type.severity)}
                          </td>
                        </>
                      )}
                      <td className="py-2 pr-2">
                        {type.is_active ? (
                          <span className="rounded bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-300">
                            активен
                          </span>
                        ) : (
                          <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                            деактивирован
                          </span>
                        )}
                      </td>
                      {canEdit ? (
                        <td className="py-2 pr-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => saveEdit(type.id)}
                                  className="rounded border border-emerald-900 px-2 py-0.5 text-xs text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
                                >
                                  Сохранить
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingId(null)}
                                  className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500"
                                >
                                  Отмена
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => startEdit(type)}
                                  className="rounded border border-sky-900 px-2 py-0.5 text-xs text-sky-300 hover:border-sky-700 disabled:opacity-40"
                                >
                                  Изм.
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => toggleActive(type)}
                                  className={`rounded border px-2 py-0.5 text-xs disabled:opacity-40 ${
                                    type.is_active
                                      ? 'border-amber-900 text-amber-300 hover:border-amber-700'
                                      : 'border-emerald-900 text-emerald-300 hover:border-emerald-700'
                                  }`}
                                >
                                  {type.is_active ? 'Деактивировать' : 'Активировать'}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
