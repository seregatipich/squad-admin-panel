'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LiveEvent } from '@/lib/live-bus';
import {
  type MarkTone,
  type MarkTypeOption,
  markIconEmoji,
  markTypeMenuItems,
  type PlayerMark,
  partitionMarks,
  severityTone,
} from '@/lib/marks';
import { useLiveSubscription } from '@/lib/use-live-bus';

const bannerToneClasses: Record<MarkTone, string> = {
  red: 'border-red-800 bg-red-950/60',
  amber: 'border-amber-800 bg-amber-950/50',
  neutral: 'border-neutral-700 bg-neutral-900/60',
};

const dotToneClasses: Record<MarkTone, string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  neutral: 'bg-neutral-400',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function PlayerMarks({ playerId }: { playerId: string }) {
  const [types, setTypes] = useState<MarkTypeOption[]>([]);
  const [marks, setMarks] = useState<PlayerMark[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [typesRes, marksRes] = await Promise.all([
      fetch('/api/v1/mark-types', { credentials: 'include', cache: 'no-store' }),
      fetch(`/api/v1/players/${playerId}/marks?include_cleared=true`, {
        credentials: 'include',
        cache: 'no-store',
      }),
    ]);
    if (typesRes.ok) setTypes((await typesRes.json()) as MarkTypeOption[]);
    if (marksRes.ok) {
      const body = (await marksRes.json()) as { items: PlayerMark[] };
      setMarks(body.items);
    }
  }, [playerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onLiveChange = useCallback(
    (event: Extract<LiveEvent, { type: 'mark.changed' }>) => {
      if (event.data.player_id !== playerId) return;
      void reload();
    },
    [playerId, reload],
  );
  useLiveSubscription('mark.changed', onLiveChange);

  const { active } = partitionMarks(marks);
  const menuItems = markTypeMenuItems(types, active);
  const bannerTone = active.reduce<MarkTone>((tone, mark) => {
    const next = severityTone(mark.mark_type.severity);
    if (tone === 'red' || next === 'red') return 'red';
    if (tone === 'amber' || next === 'amber') return 'amber';
    return next;
  }, 'neutral');

  async function setMark(type: MarkTypeOption) {
    setMenuOpen(false);
    if (busy) return;
    setBusy(true);
    setError(null);
    const optimistic: PlayerMark = {
      id: `optimistic-${type.id}-${Date.now()}`,
      player_id: playerId,
      mark_type_id: type.id,
      comment: null,
      created_by: '',
      created_by_name: null,
      created_at: new Date().toISOString(),
      cleared_by: null,
      cleared_by_name: null,
      cleared_at: null,
      clear_reason: null,
      active: true,
      mark_type: {
        id: type.id,
        slug: type.slug,
        label_en: type.label_en,
        label_ru: type.label_ru,
        icon: type.icon,
        severity: type.severity,
      },
    };
    setMarks((prev) => [optimistic, ...prev]);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/marks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mark_type_id: type.id }),
      });
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await reload();
      setBusy(false);
    }
  }

  async function clearMark(mark: PlayerMark) {
    if (busy) return;
    if (!confirm(`Снять метку «${mark.mark_type.label_ru}»?`)) return;
    setBusy(true);
    setError(null);
    setMarks((prev) =>
      prev.map((entry) => (entry.id === mark.id ? { ...entry, active: false } : entry)),
    );
    try {
      const res = await fetch(`/api/v1/players/${playerId}/marks/${mark.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await reload();
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Метки подозрения ({active.length})
        </h2>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            disabled={busy}
            className="rounded border border-neutral-700 px-3 py-1 text-xs hover:border-neutral-500 disabled:opacity-40"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            Метки ▾
          </button>
          {menuOpen ? (
            <>
              <button
                type="button"
                aria-label="Закрыть меню"
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setMenuOpen(false)}
              />
              <ul className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-auto rounded border border-neutral-700 bg-neutral-900 py-1 text-sm shadow-xl">
                {menuItems.map(({ type, activeMark }) => (
                  <li key={type.id}>
                    <button
                      type="button"
                      onClick={() => (activeMark ? clearMark(activeMark) : setMark(type))}
                      disabled={busy}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-800 disabled:opacity-40"
                    >
                      <span className="w-4 text-center text-emerald-400">
                        {activeMark ? '✓' : ''}
                      </span>
                      <span aria-hidden>{markIconEmoji(type.icon)}</span>
                      <span className="flex-1">
                        {type.label_ru}
                        <span className="ml-1 text-[11px] text-neutral-500">{type.label_en}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      {active.length > 0 ? (
        <ul className={`space-y-2 rounded border p-2 ${bannerToneClasses[bannerTone]}`}>
          {active.map((mark) => (
            <li key={mark.id} className="flex items-start justify-between gap-3 text-sm">
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1.5 inline-block h-2 w-2 flex-none animate-pulse rounded-full ${dotToneClasses[severityTone(mark.mark_type.severity)]}`}
                  aria-hidden
                />
                <span aria-hidden className="text-base leading-none">
                  {markIconEmoji(mark.mark_type.icon)}
                </span>
                <div>
                  <div className="font-medium text-neutral-100">
                    {mark.mark_type.label_ru}
                    <span className="ml-1 text-[11px] font-normal text-neutral-500">
                      {mark.mark_type.label_en}
                    </span>
                  </div>
                  <div className="text-[11px] text-neutral-400">
                    поставил {mark.created_by_name ?? '—'} · {formatWhen(mark.created_at)}
                  </div>
                  {mark.comment ? (
                    <div className="mt-0.5 text-xs text-neutral-300">{mark.comment}</div>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => clearMark(mark)}
                disabled={busy}
                className="flex-none rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
              >
                Снять
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-neutral-500">активных меток нет</div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-xs uppercase tracking-widest text-neutral-400">
          История меток ({marks.length})
        </summary>
        {marks.length === 0 ? (
          <div className="mt-2 text-sm text-neutral-500">пусто</div>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="p-1 text-left">Тип</th>
                  <th className="p-1 text-left">Поставил</th>
                  <th className="p-1 text-left">Снял</th>
                  <th className="p-1 text-left">Причина</th>
                </tr>
              </thead>
              <tbody>
                {marks.map((mark) => (
                  <tr key={mark.id} className="border-t border-neutral-900 align-top">
                    <td className="p-1">
                      <span aria-hidden className="mr-1">
                        {markIconEmoji(mark.mark_type.icon)}
                      </span>
                      <span className={mark.active ? 'text-neutral-100' : 'text-neutral-500'}>
                        {mark.mark_type.label_ru}
                      </span>
                    </td>
                    <td className="p-1 text-neutral-400">
                      {mark.created_by_name ?? '—'}
                      <div className="text-neutral-500">{formatWhen(mark.created_at)}</div>
                    </td>
                    <td className="p-1 text-neutral-400">
                      {mark.active ? (
                        <span className="text-emerald-400">активна</span>
                      ) : (
                        <>
                          {mark.cleared_by_name ?? '—'}
                          <div className="text-neutral-500">{formatWhen(mark.cleared_at)}</div>
                        </>
                      )}
                    </td>
                    <td className="p-1 text-neutral-400">{mark.clear_reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
