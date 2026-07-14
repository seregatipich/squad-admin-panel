'use client';

import { use, useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  bucketByDay,
  dayKey,
  expandOccurrences,
  type ScheduleOccurrence,
  type SeedingWindow,
  type SeedScheduleEntry,
  startOfWeekUtc,
  weekDays,
} from './helpers';

interface LayerOption {
  name: string;
}

interface ScheduleListResponse {
  entries: SeedScheduleEntry[];
  can_edit: boolean;
}

interface HistoryResponse {
  windows: SeedingWindow[];
}

interface FormState {
  starts_at: string; // datetime-local value
  seed_layer: string;
  broadcast_text: string;
  recurrence: string;
}

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function emptyForm(startsAt: Date, defaultLayer: string): FormState {
  return {
    starts_at: toDatetimeLocalValue(startsAt),
    seed_layer: defaultLayer,
    broadcast_text: '',
    recurrence: '',
  };
}

/** Converts a UTC instant to the `YYYY-MM-DDTHH:mm` value a `datetime-local` input expects, in UTC. */
function toDatetimeLocalValue(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function formatTime(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function formatDayLabel(date: Date, weekdayLabel: string): string {
  return `${weekdayLabel} ${date.toISOString().slice(8, 10)}.${date.toISOString().slice(5, 7)}`;
}

export default function SeedCalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [entries, setEntries] = useState<SeedScheduleEntry[]>([]);
  const [windows, setWindows] = useState<SeedingWindow[]>([]);
  const [layerPool, setLayerPool] = useState<LayerOption[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [weekStart, setWeekStart] = useState(() => startOfWeekUtc(new Date()));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm(new Date(), ''));

  const startsAtId = useId();
  const layerId = useId();
  const broadcastId = useId();
  const recurrenceId = useId();

  const rangeTo = useMemo(() => {
    const end = new Date(weekStart.getTime());
    end.setUTCDate(end.getUTCDate() + 7);
    end.setUTCSeconds(-60); // last minute of the 7th day
    return end;
  }, [weekStart]);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [listRes, historyRes, layersRes] = await Promise.all([
        fetch(`/api/v1/servers/${id}/seed-schedule`, { credentials: 'include', cache: 'no-store' }),
        fetch(
          `/api/v1/servers/${id}/seed-schedule/history?from=${weekStart.toISOString()}&to=${rangeTo.toISOString()}`,
          { credentials: 'include', cache: 'no-store' },
        ),
        fetch('/api/v1/layers?is_seed=true', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      if (!historyRes.ok) throw new Error(`HTTP ${historyRes.status}`);
      if (!layersRes.ok) throw new Error(`HTTP ${layersRes.status}`);
      const list = (await listRes.json()) as ScheduleListResponse;
      const history = (await historyRes.json()) as HistoryResponse;
      const layersBody = (await layersRes.json()) as { rows: LayerOption[] };
      setEntries(list.entries);
      setCanEdit(list.can_edit);
      setWindows(history.windows);
      setLayerPool(layersBody.rows);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, weekStart, rangeTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const occurrences = useMemo(
    () => expandOccurrences(entries, weekStart, rangeTo),
    [entries, weekStart, rangeTo],
  );
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const occurrencesByDay = useMemo(
    () => bucketByDay(occurrences, (o) => o.startsAt),
    [occurrences],
  );
  const windowsByDay = useMemo(
    () => bucketByDay(windows, (w) => new Date(w.started_at)),
    [windows],
  );
  const entriesById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  function openCreateModal(dayStart: Date) {
    if (!canEdit) return;
    const prefill = new Date(dayStart.getTime());
    prefill.setUTCHours(10, 0, 0, 0);
    setEditingId(null);
    setForm(emptyForm(prefill, layerPool[0]?.name ?? ''));
    setModalOpen(true);
  }

  function openEditModal(occurrence: ScheduleOccurrence) {
    if (!canEdit) return;
    const entry = entriesById.get(occurrence.entryId);
    if (!entry) return;
    setEditingId(entry.id);
    setForm({
      starts_at: toDatetimeLocalValue(new Date(entry.starts_at)),
      seed_layer: entry.seed_layer,
      broadcast_text: entry.broadcast_text ?? '',
      recurrence: entry.recurrence ?? '',
    });
    setModalOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    setMsg(null);
    try {
      const payload = {
        starts_at: new Date(`${form.starts_at}:00.000Z`).toISOString(),
        seed_layer: form.seed_layer,
        broadcast_text: form.broadcast_text.trim() || null,
        recurrence: form.recurrence.trim() || null,
      };
      const url = editingId
        ? `/api/v1/servers/${id}/seed-schedule/${editingId}`
        : `/api/v1/servers/${id}/seed-schedule`;
      const res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setModalOpen(false);
      setMsg(editingId ? 'Запись обновлена' : 'Запись создана');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEnabled(entry: SeedScheduleEntry) {
    if (!canEdit) return;
    setErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/seed-schedule/${entry.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !entry.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function removeEntry(entryId: string) {
    if (!canEdit) return;
    setErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/seed-schedule/${entryId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMsg('Запись удалена');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (loading) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="max-w-6xl space-y-4 pb-20">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Сид-календарь</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Запланированные сид-старты (разовые и по расписанию cron) и исторические окна сидинга из
            событий SEED-1.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() =>
              setWeekStart((w) => {
                const prev = new Date(w.getTime());
                prev.setUTCDate(prev.getUTCDate() - 7);
                return prev;
              })
            }
            className="rounded border border-neutral-800 px-3 py-1.5 text-neutral-300 hover:border-neutral-600"
          >
            ← Неделя
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(startOfWeekUtc(new Date()))}
            className="rounded border border-neutral-800 px-3 py-1.5 text-neutral-300 hover:border-neutral-600"
          >
            Сегодня
          </button>
          <button
            type="button"
            onClick={() =>
              setWeekStart((w) => {
                const next = new Date(w.getTime());
                next.setUTCDate(next.getUTCDate() + 7);
                return next;
              })
            }
            className="rounded border border-neutral-800 px-3 py-1.5 text-neutral-300 hover:border-neutral-600"
          >
            Неделя →
          </button>
        </div>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-sm text-emerald-200">
          {msg}
        </div>
      ) : null}
      {!canEdit ? (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-400">
          Только просмотр — нужна squad-привилегия changemap.
        </div>
      ) : null}

      <div data-testid="week-grid" className="grid grid-cols-1 gap-2 sm:grid-cols-7">
        {days.map((day, i) => {
          const key = dayKey(day);
          const dayOccurrences = occurrencesByDay.get(key) ?? [];
          const dayWindows = windowsByDay.get(key) ?? [];
          return (
            <div
              key={key}
              className="min-h-[8rem] rounded border border-neutral-800 bg-neutral-950 p-2"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-300">
                  {formatDayLabel(day, WEEKDAY_LABELS[i] ?? '')}
                </span>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => openCreateModal(day)}
                    aria-label="Добавить сид-старт"
                    className="rounded px-1.5 text-xs text-sky-400 hover:bg-neutral-800"
                  >
                    +
                  </button>
                ) : null}
              </div>
              <div className="space-y-1">
                {dayWindows.map((w, wi) => (
                  <div
                    key={`window-${w.started_at}-${wi}`}
                    className="rounded border border-amber-900 bg-amber-950/60 px-1.5 py-1 text-[11px] text-amber-200"
                    title={`Сидинг ${formatTime(new Date(w.started_at))}–${
                      w.ended_at ? formatTime(new Date(w.ended_at)) : '…'
                    }${w.layer ? ` · ${w.layer}` : ''}`}
                  >
                    {formatTime(new Date(w.started_at))}
                    {w.ended_at ? `–${formatTime(new Date(w.ended_at))}` : ' (идёт)'}
                    {w.layer ? ` · ${w.layer}` : ''}
                  </div>
                ))}
                {dayOccurrences.map((o, oi) => {
                  const entry = entriesById.get(o.entryId);
                  return (
                    <div
                      key={`occ-${o.entryId}-${o.startsAt.toISOString()}-${oi}`}
                      className="rounded border border-sky-900 bg-sky-950/60 px-1.5 py-1 text-[11px] text-sky-200"
                    >
                      <button
                        type="button"
                        onClick={() => openEditModal(o)}
                        disabled={!canEdit}
                        className="block w-full text-left disabled:cursor-default"
                      >
                        {formatTime(o.startsAt)} · {o.seedLayer}
                        {o.recurrence ? ' ⟳' : ''}
                      </button>
                      {canEdit && entry ? (
                        <div className="mt-1 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleEnabled(entry)}
                            className="text-[10px] text-neutral-400 hover:text-neutral-200"
                          >
                            {entry.enabled ? 'выключить' : 'включить'}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeEntry(entry.id)}
                            className="text-[10px] text-red-400 hover:text-red-300"
                          >
                            удалить
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {dayOccurrences.length === 0 && dayWindows.length === 0 ? (
                  <p className="text-[11px] text-neutral-600">—</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="mt-16 w-full max-w-lg space-y-4 rounded border border-neutral-800 bg-neutral-950 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editingId ? 'Изменить сид-старт' : 'Новый сид-старт'}
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
                <label htmlFor={startsAtId} className="mb-1 block text-xs text-neutral-500">
                  Начало (UTC)
                </label>
                <input
                  id={startsAtId}
                  type="datetime-local"
                  value={form.starts_at}
                  onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))}
                  required
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor={layerId} className="mb-1 block text-xs text-neutral-500">
                  Сид-слой
                </label>
                <select
                  id={layerId}
                  value={form.seed_layer}
                  onChange={(e) => setForm((f) => ({ ...f, seed_layer: e.target.value }))}
                  required
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                >
                  {layerPool.length === 0 ? (
                    <option value="">Нет сид-слоёв в каталоге</option>
                  ) : null}
                  {layerPool.map((l) => (
                    <option key={l.name} value={l.name}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor={recurrenceId} className="mb-1 block text-xs text-neutral-500">
                  Повтор (cron, необязательно) — напр. «0 10 * * 6» — каждую субботу в 10:00 UTC
                </label>
                <input
                  id={recurrenceId}
                  type="text"
                  value={form.recurrence}
                  onChange={(e) => setForm((f) => ({ ...f, recurrence: e.target.value }))}
                  placeholder="0 10 * * 6"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm focus:border-neutral-600 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor={broadcastId} className="mb-1 block text-xs text-neutral-500">
                  Текст рассылки (необязательно)
                </label>
                <input
                  id={broadcastId}
                  type="text"
                  value={form.broadcast_text}
                  maxLength={512}
                  onChange={(e) => setForm((f) => ({ ...f, broadcast_text: e.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
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
                  disabled={submitting || !form.seed_layer}
                  className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
                >
                  {submitting ? 'Сохраняю…' : editingId ? 'Сохранить' : 'Создать'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
