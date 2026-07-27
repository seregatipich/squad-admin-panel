'use client';

import { useCallback, useEffect, useId, useState } from 'react';

/** Mirrors the `Season` payload of `GET /api/v1/seasons` (LEAD-7, #178). */
export interface Season {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  status: 'upcoming' | 'active' | 'closed';
  finalized: boolean;
}

interface FormState {
  name: string;
  startsAt: string;
  endsAt: string;
  status: 'upcoming' | 'active';
}

const EMPTY_FORM: FormState = { name: '', startsAt: '', endsAt: '', status: 'upcoming' };

const STATUS_LABELS: Record<Season['status'], string> = {
  upcoming: 'Запланирован',
  active: 'Активный',
  closed: 'Закрыт',
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid_bounds: 'Дата окончания должна быть позже даты начала.',
  active_season_exists: 'Активный сезон уже существует — закройте текущий.',
  season_name_taken: 'Сезон с таким названием уже есть.',
  season_finalized: 'Сезон финализирован и больше не редактируется.',
  season_not_found: 'Сезон не найден.',
  forbidden: 'Недостаточно прав.',
};

const inputClass =
  'rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none';

function describeError(code: unknown, status: number): string {
  if (typeof code === 'string' && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return `Ошибка ${status}`;
}

/** `YYYY-MM-DD` from a `<input type="date">` to the ISO instant the API takes. */
function dayToIso(day: string): string {
  return `${day}T00:00:00.000Z`;
}

function isoToDay(iso: string): string {
  return iso.slice(0, 10);
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function formatRange(season: Season): string {
  return `${dateFmt.format(new Date(season.starts_at))} — ${dateFmt.format(new Date(season.ends_at))}`;
}

/**
 * Season management (LEAD-7, #178).
 *
 * Mutations are gated on the `can_edit_roles` capability, which
 * `GET /api/v1/me` does not expose. The page therefore follows the
 * self-hide-on-403 idiom used by `reports/ReportsAnalytics.tsx` and
 * `settings/ban-sources/PublicationSection.tsx`: the management controls render
 * optimistically and disappear for good the first time the API answers 403.
 */
export default function SeasonsSettingsPage() {
  const nameId = useId();
  const startsId = useId();
  const endsId = useId();
  const statusId = useId();

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [canManage, setCanManage] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/seasons', { credentials: 'include', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`Ошибка ${res.status}`);
      const body = (await res.json()) as { items: Season[] };
      setSeasons(body.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setError(null);
  }

  function startEdit(season: Season) {
    setEditingId(season.id);
    setError(null);
    setNotice(null);
    setForm({
      name: season.name,
      startsAt: isoToDay(season.starts_at),
      endsAt: isoToDay(season.ends_at),
      status: season.status === 'closed' ? 'upcoming' : season.status,
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || !form.startsAt || !form.endsAt) {
      setError('Заполните название и обе даты.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: form.name.trim(),
        starts_at: dayToIso(form.startsAt),
        ends_at: dayToIso(form.endsAt),
        status: form.status,
      };
      const res = await fetch(editingId ? `/api/v1/seasons/${editingId}` : '/api/v1/seasons', {
        method: editingId ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401 || res.status === 403) {
        setCanManage(false);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(describeError(body.error, res.status));
        return;
      }
      setNotice(editingId ? 'Сезон обновлён.' : 'Сезон создан.');
      resetForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function closeSeason(season: Season) {
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/v1/seasons/${season.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    });
    if (res.status === 401 || res.status === 403) {
      setCanManage(false);
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      setError(describeError(body.error, res.status));
      return;
    }
    setNotice('Сезон закрыт.');
    await load();
  }

  if (hidden) return null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Сезоны</h1>
        <p className="text-sm text-neutral-400">
          Именованные интервалы для сезонных лидербордов. Активным может быть только один сезон.
        </p>
      </div>

      {notice ? <p className="text-xs text-emerald-400">{notice}</p> : null}

      <section className="rounded border border-neutral-800 bg-neutral-950">
        {loading ? (
          <p className="p-4 text-sm text-neutral-500">Загрузка сезонов…</p>
        ) : seasons.length === 0 ? (
          <p className="p-4 text-sm text-neutral-500">Сезонов пока нет.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="px-4 py-2">Название</th>
                <th className="px-4 py-2">Период</th>
                <th className="px-4 py-2">Статус</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {seasons.map((season) => (
                <tr key={season.id} className="border-t border-neutral-800">
                  <td className="px-4 py-2 text-neutral-100">{season.name}</td>
                  <td className="px-4 py-2 text-neutral-400">{formatRange(season)}</td>
                  <td className="px-4 py-2 text-neutral-400">
                    {STATUS_LABELS[season.status]}
                    {season.finalized ? ' · финализирован' : ''}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canManage && !season.finalized ? (
                      <span className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(season)}
                          className="rounded border border-neutral-800 px-2 py-1 text-xs hover:border-neutral-600"
                        >
                          Изменить
                        </button>
                        {season.status === 'active' ? (
                          <button
                            type="button"
                            onClick={() => void closeSeason(season)}
                            className="rounded border border-neutral-800 px-2 py-1 text-xs hover:border-neutral-600"
                          >
                            Закрыть
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-600">только просмотр</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canManage ? (
        <form onSubmit={submit} className="space-y-3 rounded border border-neutral-800 p-4">
          <h2 className="text-sm font-semibold text-neutral-200">
            {editingId ? 'Изменение сезона' : 'Новый сезон'}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-neutral-400" htmlFor={nameId}>
              Название
              <input
                id={nameId}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className={`w-full ${inputClass}`}
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-400" htmlFor={statusId}>
              Статус
              <select
                id={statusId}
                value={form.status}
                onChange={(event) =>
                  setForm({ ...form, status: event.target.value as FormState['status'] })
                }
                className={`w-full ${inputClass}`}
              >
                <option value="upcoming">Запланирован</option>
                <option value="active">Активный</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-neutral-400" htmlFor={startsId}>
              Начало
              <input
                id={startsId}
                type="date"
                value={form.startsAt}
                onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
                className={`w-full ${inputClass}`}
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-400" htmlFor={endsId}>
              Окончание
              <input
                id={endsId}
                type="date"
                value={form.endsAt}
                onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
                className={`w-full ${inputClass}`}
              />
            </label>
          </div>

          {error ? <p className="text-xs text-red-400">{error}</p> : null}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:border-neutral-500 disabled:opacity-40"
            >
              {submitting ? 'Сохранение…' : editingId ? 'Сохранить' : 'Создать'}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={resetForm}
                className="rounded border border-neutral-800 px-3 py-1.5 text-sm hover:border-neutral-600"
              >
                Отмена
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="text-xs text-neutral-500">
          Управление сезонами требует права на редактирование ролей.
        </p>
      )}
    </div>
  );
}
