'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  FieldRow,
  IconButton,
  InlineBanner,
  Modal,
  PageContainer,
  PlusIcon,
  Select,
  Skeleton,
  TextInput,
} from '@/components/ui';
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
  notify_minutes_before: string;
  recurrence: string;
}

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Служебный ярлык над значением — единственное место, где §1 допускает капслок. */
const CHIP_LABEL = 'block text-2xs uppercase tracking-[0.06em] text-ink-3';

function emptyForm(startsAt: Date, defaultLayer: string): FormState {
  return {
    starts_at: toDatetimeLocalValue(startsAt),
    seed_layer: defaultLayer,
    broadcast_text: '',
    notify_minutes_before: '0',
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
      notify_minutes_before: String(entry.notify_minutes_before),
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
        notify_minutes_before: Number(form.notify_minutes_before),
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
    return (
      <PageContainer width="wide">
        <Skeleton variant="card" count={2} label="Сид-календарь загружается" />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-3">
          Запланированные сид-старты (разовые и по расписанию cron) и исторические окна сидинга из
          событий SEED-1.
        </p>
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              setWeekStart((w) => {
                const prev = new Date(w.getTime());
                prev.setUTCDate(prev.getUTCDate() - 7);
                return prev;
              })
            }
          >
            ← Неделя
          </Button>
          <Button onClick={() => setWeekStart(startOfWeekUtc(new Date()))}>Сегодня</Button>
          <Button
            onClick={() =>
              setWeekStart((w) => {
                const next = new Date(w.getTime());
                next.setUTCDate(next.getUTCDate() + 7);
                return next;
              })
            }
          >
            Неделя →
          </Button>
        </div>
      </div>

      {err ? (
        <InlineBanner
          tone="crit"
          title={err}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {msg ? <InlineBanner tone="good" title={msg} /> : null}
      {!canEdit ? (
        <InlineBanner tone="info" title="Только просмотр — нужна squad-привилегия changemap." />
      ) : null}

      <div data-testid="week-grid" className="grid grid-cols-1 gap-2 sm:grid-cols-7">
        {days.map((day, i) => {
          const key = dayKey(day);
          const dayOccurrences = occurrencesByDay.get(key) ?? [];
          const dayWindows = windowsByDay.get(key) ?? [];
          return (
            <Card key={key} padding="sm" className="min-h-[8rem]">
              <div className="mb-2 flex items-center justify-between gap-1">
                <span className="text-xs font-semibold text-ink-2">
                  {formatDayLabel(day, WEEKDAY_LABELS[i] ?? '')}
                </span>
                {canEdit ? (
                  <IconButton
                    icon={<PlusIcon />}
                    label="Добавить сид-старт"
                    onClick={() => openCreateModal(day)}
                  />
                ) : null}
              </div>
              <div className="space-y-1">
                {dayWindows.map((w, wi) => (
                  <div
                    key={`window-${w.started_at}-${wi}`}
                    className="rounded-ctl border border-warn/40 bg-warn/10 px-1.5 py-1 text-2xs text-amber-300"
                    title={`Сидинг ${formatTime(new Date(w.started_at))}–${
                      w.ended_at ? formatTime(new Date(w.ended_at)) : '…'
                    }${w.layer ? ` · ${w.layer}` : ''}`}
                  >
                    <span className={CHIP_LABEL}>Сидинг</span>
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
                      className="rounded-ctl border border-accent/40 bg-accent-dim px-1.5 py-1 text-2xs text-sky-300"
                    >
                      <span className={CHIP_LABEL}>
                        {entry && !entry.enabled ? 'Выключено' : 'Запланировано'}
                      </span>
                      <button
                        type="button"
                        onClick={() => openEditModal(o)}
                        disabled={!canEdit}
                        className="block w-full text-left disabled:cursor-default"
                      >
                        {formatTime(o.startsAt)} · {o.seedLayer}
                        {o.recurrence ? ' · повтор' : ''}
                      </button>
                      {canEdit && entry ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <Button variant="ghost" size="sm" onClick={() => toggleEnabled(entry)}>
                            {entry.enabled ? 'выключить' : 'включить'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => removeEntry(entry.id)}>
                            удалить
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {dayOccurrences.length === 0 && dayWindows.length === 0 ? (
                  <p className="text-2xs text-ink-3">—</p>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      {modalOpen ? (
        <Modal
          open
          onClose={() => setModalOpen(false)}
          title={editingId ? 'Изменить сид-старт' : 'Новый сид-старт'}
          closeLabel="Закрыть"
        >
          <form onSubmit={submit} className="space-y-4">
            <FieldRow label="Начало (UTC)">
              <TextInput
                type="datetime-local"
                value={form.starts_at}
                onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))}
                required
              />
            </FieldRow>

            <FieldRow label="Сид-слой">
              <Select
                value={form.seed_layer}
                onChange={(e) => setForm((f) => ({ ...f, seed_layer: e.target.value }))}
                required
              >
                {layerPool.length === 0 ? <option value="">Нет сид-слоёв в каталоге</option> : null}
                {layerPool.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </FieldRow>

            <FieldRow
              label="Повтор (cron, необязательно)"
              hint="Например, «0 10 * * 6» — каждую субботу в 10:00 UTC."
            >
              <TextInput
                type="text"
                value={form.recurrence}
                onChange={(e) => setForm((f) => ({ ...f, recurrence: e.target.value }))}
                placeholder="0 10 * * 6"
                className="font-mono"
              />
            </FieldRow>

            <FieldRow label="Текст рассылки (необязательно)">
              <TextInput
                type="text"
                value={form.broadcast_text}
                maxLength={512}
                onChange={(e) => setForm((f) => ({ ...f, broadcast_text: e.target.value }))}
              />
            </FieldRow>

            <FieldRow label="Уведомить за (минут)">
              <TextInput
                type="number"
                min={0}
                max={1440}
                step={1}
                value={form.notify_minutes_before}
                onChange={(e) => setForm((f) => ({ ...f, notify_minutes_before: e.target.value }))}
              />
            </FieldRow>

            <div className="flex justify-end gap-2">
              <Button onClick={() => setModalOpen(false)}>Отмена</Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!form.seed_layer}
                loading={submitting}
              >
                {editingId ? 'Сохранить' : 'Создать'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </PageContainer>
  );
}
