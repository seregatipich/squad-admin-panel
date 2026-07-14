'use client';

import { use, useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  bucketByDay,
  dayKey,
  entriesInRange,
  type RotationHistoryEntry,
  type RotationProfile,
  type RotationScheduleEntry,
  type RotationWarning,
  startOfWeekUtc,
  toDatetimeLocalValue,
  weekDays,
} from './helpers';

interface LayerOption {
  name: string;
}

interface CalendarResponse {
  entries: RotationScheduleEntry[];
  history: RotationHistoryEntry[];
  profiles: RotationProfile[];
  warnings: Record<string, RotationWarning[]>;
  can_edit: boolean;
}

interface FormState {
  scheduled_at: string;
  layer: string;
  mode: 'set_next' | 'force_change';
}

interface ProfileDraft {
  name: string;
  weekday: number | null;
  layers: string[];
}

const WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function emptyForm(date: Date, layer: string): FormState {
  return { scheduled_at: toDatetimeLocalValue(date), layer, mode: 'set_next' };
}

function formatTime(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function formatDayLabel(date: Date, index: number): string {
  return `${WEEKDAY_LABELS[index === 6 ? 0 : index + 1] ?? ''} ${date.toISOString().slice(8, 10)}.${date.toISOString().slice(5, 7)}`;
}

function profileDrafts(profiles: RotationProfile[]): ProfileDraft[] {
  return profiles.map((profile) => ({
    name: profile.name,
    weekday: profile.weekday,
    layers: profile.layers,
  }));
}

export default function RotationCalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [entries, setEntries] = useState<RotationScheduleEntry[]>([]);
  const [history, setHistory] = useState<RotationHistoryEntry[]>([]);
  const [profiles, setProfiles] = useState<ProfileDraft[]>([]);
  const [layerPool, setLayerPool] = useState<LayerOption[]>([]);
  const [warnings, setWarnings] = useState<Record<string, RotationWarning[]>>({});
  const [canEdit, setCanEdit] = useState(false);
  const [weekStart, setWeekStart] = useState(() => startOfWeekUtc(new Date()));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm(new Date(), ''));

  const startsAtId = useId();
  const layerId = useId();
  const modeId = useId();
  const rangeTo = useMemo(() => {
    const end = new Date(weekStart.getTime());
    end.setUTCDate(end.getUTCDate() + 7);
    end.setUTCSeconds(-60);
    return end;
  }, [weekStart]);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [calendarRes, layersRes] = await Promise.all([
        fetch(
          `/api/v1/servers/${id}/rotation-schedule?from=${weekStart.toISOString()}&to=${rangeTo.toISOString()}`,
          { credentials: 'include', cache: 'no-store' },
        ),
        fetch('/api/v1/layers', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!calendarRes.ok) throw new Error(`HTTP ${calendarRes.status}`);
      if (!layersRes.ok) throw new Error(`HTTP ${layersRes.status}`);
      const calendar = (await calendarRes.json()) as CalendarResponse;
      const layers = (await layersRes.json()) as { rows: LayerOption[] };
      setEntries(calendar.entries);
      setHistory(calendar.history);
      setProfiles(profileDrafts(calendar.profiles));
      setWarnings(calendar.warnings);
      setCanEdit(calendar.can_edit);
      setLayerPool(layers.rows);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, rangeTo, weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduled = useMemo(
    () => entriesInRange(entries, weekStart, rangeTo),
    [entries, rangeTo, weekStart],
  );
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const scheduledByDay = useMemo(
    () => bucketByDay(scheduled, (entry) => new Date(entry.scheduled_at)),
    [scheduled],
  );
  const historyByDay = useMemo(
    () => bucketByDay(history, (entry) => new Date(entry.started_at)),
    [history],
  );

  function openCreate(day: Date) {
    if (!canEdit) return;
    const date = new Date(day.getTime());
    date.setUTCHours(10, 0, 0, 0);
    setEditingId(null);
    setForm(emptyForm(date, layerPool[0]?.name ?? ''));
    setModalOpen(true);
  }

  function openEdit(entry: RotationScheduleEntry) {
    if (!canEdit) return;
    setEditingId(entry.id);
    setForm({
      scheduled_at: toDatetimeLocalValue(new Date(entry.scheduled_at)),
      layer: entry.layer,
      mode: entry.mode,
    });
    setModalOpen(true);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setErr(null);
    setMsg(null);
    try {
      const payload = {
        scheduled_at: new Date(`${form.scheduled_at}:00.000Z`).toISOString(),
        layer: form.layer,
        mode: form.mode,
      };
      const url = editingId
        ? `/api/v1/servers/${id}/rotation-schedule/${editingId}`
        : `/api/v1/servers/${id}/rotation-schedule`;
      const response = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const saved = (await response.json()) as { warnings?: RotationWarning[] };
      setModalOpen(false);
      setMsg(
        saved.warnings?.length
          ? `Сохранено с предупреждением: ${saved.warnings.map((warning) => warning.message).join('; ')}`
          : editingId
            ? 'Запись обновлена'
            : 'Запись создана',
      );
      await load();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEntry(entry: RotationScheduleEntry) {
    if (!canEdit) return;
    await updateEntry(entry, { enabled: !entry.enabled });
  }

  async function updateEntry(entry: RotationScheduleEntry, body: Record<string, unknown>) {
    setErr(null);
    try {
      const response = await fetch(`/api/v1/servers/${id}/rotation-schedule/${entry.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await load();
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function removeEntry(entry: RotationScheduleEntry) {
    if (!canEdit) return;
    setErr(null);
    try {
      const response = await fetch(`/api/v1/servers/${id}/rotation-schedule/${entry.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setMsg('Запись удалена');
      await load();
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function saveProfiles() {
    if (!canEdit) return;
    setProfileSaving(true);
    setErr(null);
    try {
      const response = await fetch(`/api/v1/servers/${id}/rotation-profiles`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profiles }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      setMsg('Профили сохранены — применятся со следующего матча');
      await load();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setProfileSaving(false);
    }
  }

  function addProfile() {
    const usedDays = new Set(profiles.map((profile) => profile.weekday));
    const weekday = [1, 2, 3, 4, 5, 6, 0].find((day) => !usedDays.has(day)) ?? null;
    setProfiles((current) => [...current, { name: 'Новый профиль', weekday, layers: [] }]);
  }

  if (loading) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="max-w-7xl space-y-5 pb-20">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Календарь ротации</h1>
          <p className="mt-1 text-sm text-neutral-400">
            История сыгранных карт, запланированные смены и недельные профили LayerRotation.cfg.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setWeekStart((date) => new Date(date.getTime() - 7 * 86_400_000))}
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
            onClick={() => setWeekStart((date) => new Date(date.getTime() + 7 * 86_400_000))}
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

      <div data-testid="rotation-calendar-grid" className="grid grid-cols-1 gap-2 sm:grid-cols-7">
        {days.map((day, index) => {
          const key = dayKey(day);
          const dayScheduled = scheduledByDay.get(key) ?? [];
          const dayHistory = historyByDay.get(key) ?? [];
          return (
            <div
              key={key}
              className="min-h-[10rem] rounded border border-neutral-800 bg-neutral-950 p-2"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-300">
                  {formatDayLabel(day, index)}
                </span>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => openCreate(day)}
                    aria-label="Добавить смену ротации"
                    className="rounded px-1.5 text-xs text-sky-400 hover:bg-neutral-800"
                  >
                    +
                  </button>
                ) : null}
              </div>
              <div className="space-y-1">
                {dayHistory.map((match) => (
                  <div
                    key={`history-${match.id}`}
                    className="rounded border border-amber-900 bg-amber-950/60 px-1.5 py-1 text-[11px] text-amber-200"
                  >
                    {formatTime(new Date(match.started_at))} · {match.layer ?? match.map ?? 'карта'}
                  </div>
                ))}
                {dayScheduled.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded border border-sky-900 bg-sky-950/60 px-1.5 py-1 text-[11px] text-sky-200"
                  >
                    <button
                      type="button"
                      onClick={() => openEdit(entry)}
                      disabled={!canEdit}
                      className="block w-full text-left disabled:cursor-default"
                    >
                      {formatTime(new Date(entry.scheduled_at))} · {entry.layer}
                      {entry.mode === 'force_change' ? ' ⚡' : ' →'}
                    </button>
                    {canEdit ? (
                      <div className="mt-1 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleEntry(entry)}
                          className="text-[10px] text-neutral-400"
                        >
                          {entry.enabled ? 'выключить' : 'включить'}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeEntry(entry)}
                          className="text-[10px] text-red-400"
                        >
                          удалить
                        </button>
                      </div>
                    ) : null}
                    {(warnings[entry.id] ?? []).map((warning) => (
                      <div
                        key={`${entry.id}-${warning.type}`}
                        className="mt-1 text-[10px] text-amber-300"
                      >
                        ⚠ {warning.message}
                      </div>
                    ))}
                  </div>
                ))}
                {dayHistory.length === 0 && dayScheduled.length === 0 ? (
                  <p className="text-[11px] text-neutral-600">—</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <section
        data-testid="rotation-profiles"
        className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Недельные профили</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Профиль дня применяется в 04:00 по часовому поясу сервера.
            </p>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={addProfile}
              className="rounded border border-sky-900 px-3 py-1.5 text-xs text-sky-300"
            >
              Добавить профиль
            </button>
          ) : null}
        </div>
        <div className="space-y-2">
          {profiles.map((profile, profileIndex) => (
            <div
              key={`${profile.weekday ?? 'default'}-${profileIndex}`}
              className="grid gap-2 rounded border border-neutral-900 p-3 lg:grid-cols-[1fr_10rem_2fr_auto]"
            >
              <input
                value={profile.name}
                aria-label="Название профиля"
                disabled={!canEdit}
                onChange={(event) =>
                  setProfiles((current) =>
                    current.map((item, index) =>
                      index === profileIndex ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              />
              <select
                value={profile.weekday == null ? 'default' : String(profile.weekday)}
                aria-label="День профиля"
                disabled={!canEdit}
                onChange={(event) =>
                  setProfiles((current) =>
                    current.map((item, index) =>
                      index === profileIndex
                        ? {
                            ...item,
                            weekday:
                              event.target.value === 'default' ? null : Number(event.target.value),
                          }
                        : item,
                    ),
                  )
                }
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              >
                <option value="default">По умолчанию</option>
                {WEEKDAY_LABELS.map((label, day) => (
                  <option key={label} value={day}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                multiple
                value={profile.layers}
                aria-label="Слои профиля"
                disabled={!canEdit}
                onChange={(event) =>
                  setProfiles((current) =>
                    current.map((item, index) =>
                      index === profileIndex
                        ? {
                            ...item,
                            layers: Array.from(
                              event.target.selectedOptions,
                              (option) => option.value,
                            ),
                          }
                        : item,
                    ),
                  )
                }
                className="min-h-20 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs"
              >
                {layerPool.map((layer) => (
                  <option key={layer.name} value={layer.name}>
                    {layer.name}
                  </option>
                ))}
              </select>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() =>
                    setProfiles((current) => current.filter((_, index) => index !== profileIndex))
                  }
                  className="self-start rounded px-2 py-1 text-xs text-red-400"
                >
                  удалить
                </button>
              ) : null}
            </div>
          ))}
          {profiles.length === 0 ? (
            <p className="text-sm text-neutral-500">Профили не настроены.</p>
          ) : null}
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={saveProfiles}
            disabled={profileSaving}
            className="rounded bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {profileSaving ? 'Сохраняю…' : 'Сохранить профили'}
          </button>
        ) : null}
      </section>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="mt-16 w-full max-w-lg space-y-4 rounded border border-neutral-800 bg-neutral-950 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editingId ? 'Изменить смену' : 'Новая смена'}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-sm text-neutral-400"
              >
                Закрыть
              </button>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label htmlFor={startsAtId} className="mb-1 block text-xs text-neutral-500">
                  Время (UTC)
                </label>
                <input
                  id={startsAtId}
                  type="datetime-local"
                  value={form.scheduled_at}
                  required
                  onChange={(event) =>
                    setForm((current) => ({ ...current, scheduled_at: event.target.value }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor={layerId} className="mb-1 block text-xs text-neutral-500">
                  Слой
                </label>
                <select
                  id={layerId}
                  value={form.layer}
                  required
                  onChange={(event) =>
                    setForm((current) => ({ ...current, layer: event.target.value }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
                >
                  {layerPool.map((layer) => (
                    <option key={layer.name} value={layer.name}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={modeId} className="mb-1 block text-xs text-neutral-500">
                  Действие
                </label>
                <select
                  id={modeId}
                  value={form.mode}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      mode: event.target.value as FormState['mode'],
                    }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
                >
                  <option value="set_next">Следующий матч (AdminSetNextLayer)</option>
                  <option value="force_change">Сменить сразу (AdminChangeLayer)</option>
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={submitting || !form.layer}
                  className="rounded bg-emerald-700 px-4 py-1.5 text-sm text-white disabled:opacity-40"
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
