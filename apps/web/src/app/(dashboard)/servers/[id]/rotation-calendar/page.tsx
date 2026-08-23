'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
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

/** Служебный ярлык над значением — единственное место, где §1 допускает капслок. */
const CHIP_LABEL = 'text-2xs uppercase tracking-[0.06em] text-ink-3';

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

  if (loading) {
    return (
      <PageContainer width="wide">
        <Skeleton variant="card" count={3} label="Календарь ротации загружается" />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-3">
          История сыгранных карт, запланированные смены и недельные профили LayerRotation.cfg.
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={() => setWeekStart((date) => new Date(date.getTime() - 7 * 86_400_000))}>
            ← Неделя
          </Button>
          <Button onClick={() => setWeekStart(startOfWeekUtc(new Date()))}>Сегодня</Button>
          <Button onClick={() => setWeekStart((date) => new Date(date.getTime() + 7 * 86_400_000))}>
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

      <div data-testid="rotation-calendar-grid" className="grid grid-cols-1 gap-2 sm:grid-cols-7">
        {days.map((day, index) => {
          const key = dayKey(day);
          const dayScheduled = scheduledByDay.get(key) ?? [];
          const dayHistory = historyByDay.get(key) ?? [];
          return (
            <Card key={key} padding="sm" className="min-h-[10rem]">
              <div className="mb-2 flex items-center justify-between gap-1">
                <span className="text-xs font-semibold text-ink-2">
                  {formatDayLabel(day, index)}
                </span>
                {canEdit ? (
                  <IconButton
                    icon={<PlusIcon />}
                    label="Добавить смену ротации"
                    onClick={() => openCreate(day)}
                  />
                ) : null}
              </div>
              <div className="space-y-1">
                {dayHistory.map((match) => (
                  <div
                    key={`history-${match.id}`}
                    className="rounded-ctl border border-warn/40 bg-warn/10 px-1.5 py-1 text-2xs text-warn-ink"
                  >
                    <span className={`block ${CHIP_LABEL}`}>Сыграно</span>
                    {formatTime(new Date(match.started_at))} · {match.layer ?? match.map ?? 'карта'}
                  </div>
                ))}
                {dayScheduled.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-ctl border border-accent/40 bg-accent-dim px-1.5 py-1 text-2xs text-accent-ink"
                  >
                    <span className={`block ${CHIP_LABEL}`}>
                      {entry.enabled ? 'Запланировано' : 'Выключено'}
                    </span>
                    <button
                      type="button"
                      onClick={() => openEdit(entry)}
                      disabled={!canEdit}
                      className="block w-full text-left disabled:cursor-default"
                    >
                      {formatTime(new Date(entry.scheduled_at))} · {entry.layer} ·{' '}
                      {entry.mode === 'force_change' ? 'сменить сразу' : 'следующий матч'}
                    </button>
                    {canEdit ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => toggleEntry(entry)}>
                          {entry.enabled ? 'выключить' : 'включить'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => removeEntry(entry)}>
                          удалить
                        </Button>
                      </div>
                    ) : null}
                    {(warnings[entry.id] ?? []).map((warning) => (
                      <p
                        key={`${entry.id}-${warning.type}`}
                        className="mt-1 text-2xs text-warn-ink"
                      >
                        ⚠ {warning.message}
                      </p>
                    ))}
                  </div>
                ))}
                {dayHistory.length === 0 && dayScheduled.length === 0 ? (
                  <p className="text-2xs text-ink-3">—</p>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Обёртка держит `data-testid`: `Card` намеренно не пробрасывает
          произвольные атрибуты, чтобы поверхность оставалась одной и той же. */}
      <div data-testid="rotation-profiles">
        <Card padding="none">
          <CardHeader
            title="Недельные профили"
            description="Профиль дня применяется в 04:00 по часовому поясу сервера."
            actions={
              canEdit ? (
                <Button size="sm" onClick={addProfile}>
                  Добавить профиль
                </Button>
              ) : undefined
            }
          />
          <CardBody className="space-y-3">
            <div className="space-y-2">
              {profiles.map((profile, profileIndex) => (
                <div
                  key={`${profile.weekday ?? 'default'}-${profileIndex}`}
                  className="grid gap-2 rounded-ctl border border-line p-3 lg:grid-cols-[1fr_10rem_2fr_auto]"
                >
                  <TextInput
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
                  />
                  <Select
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
                                  event.target.value === 'default'
                                    ? null
                                    : Number(event.target.value),
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="default">По умолчанию</option>
                    {WEEKDAY_LABELS.map((label, day) => (
                      <option key={label} value={day}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  {/* Множественный выбор растёт вниз и не помещается в 32px
                    высоты примитива `Select`, поэтому здесь нативный
                    `<select multiple>` на тех же токенах поверхности. */}
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
                    className="min-h-20 w-full rounded-ctl border border-line bg-raised px-2 py-2 font-mono text-xs text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {layerPool.map((layer) => (
                      <option key={layer.name} value={layer.name}>
                        {layer.name}
                      </option>
                    ))}
                  </select>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      onClick={() =>
                        setProfiles((current) =>
                          current.filter((_, index) => index !== profileIndex),
                        )
                      }
                    >
                      удалить
                    </Button>
                  ) : null}
                </div>
              ))}
              {profiles.length === 0 ? (
                <p className="text-xs text-ink-3">Профили не настроены.</p>
              ) : null}
            </div>
            {canEdit ? (
              <Button variant="primary" onClick={saveProfiles} loading={profileSaving}>
                Сохранить профили
              </Button>
            ) : null}
          </CardBody>
        </Card>
      </div>

      {modalOpen ? (
        <Modal
          open
          onClose={() => setModalOpen(false)}
          title={editingId ? 'Изменить смену' : 'Новая смена'}
          closeLabel="Закрыть"
        >
          <form onSubmit={submit} className="space-y-4">
            <FieldRow label="Время (UTC)">
              <TextInput
                type="datetime-local"
                value={form.scheduled_at}
                required
                onChange={(event) =>
                  setForm((current) => ({ ...current, scheduled_at: event.target.value }))
                }
              />
            </FieldRow>
            <FieldRow label="Слой">
              <Select
                value={form.layer}
                required
                onChange={(event) =>
                  setForm((current) => ({ ...current, layer: event.target.value }))
                }
              >
                {layerPool.map((layer) => (
                  <option key={layer.name} value={layer.name}>
                    {layer.name}
                  </option>
                ))}
              </Select>
            </FieldRow>
            <FieldRow label="Действие">
              <Select
                value={form.mode}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    mode: event.target.value as FormState['mode'],
                  }))
                }
              >
                <option value="set_next">Следующий матч (AdminSetNextLayer)</option>
                <option value="force_change">Сменить сразу (AdminChangeLayer)</option>
              </Select>
            </FieldRow>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setModalOpen(false)}>Отмена</Button>
              <Button type="submit" variant="primary" disabled={!form.layer} loading={submitting}>
                {editingId ? 'Сохранить' : 'Создать'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </PageContainer>
  );
}
