'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  FieldRow,
  InlineBanner,
  PageHeader,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';

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

/** Тон дублирует подпись статуса, а не заменяет её (§5). */
const STATUS_TONE: Record<Season['status'], 'good' | 'accent' | 'neutral'> = {
  upcoming: 'accent',
  active: 'good',
  closed: 'neutral',
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid_bounds: 'Дата окончания должна быть позже даты начала.',
  active_season_exists: 'Активный сезон уже существует — закройте текущий.',
  season_name_taken: 'Сезон с таким названием уже есть.',
  season_finalized: 'Сезон финализирован и больше не редактируется.',
  season_not_found: 'Сезон не найден.',
  forbidden: 'Недостаточно прав.',
};

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
    <>
      <PageHeader
        title="Сезоны"
        subtitle="Именованные интервалы для сезонных лидербордов. Активным может быть только один сезон."
      />

      {notice ? <InlineBanner tone="good" title={notice} /> : null}
      {error ? <InlineBanner tone="crit" title={error} /> : null}

      <Card padding="none" as="section">
        <CardHeader title="Все сезоны" count={seasons.length > 0 ? seasons.length : undefined} />
        {loading ? (
          <CardBody padding="sm">
            <SkeletonTable rows={3} cols={4} label="Загрузка сезонов" />
          </CardBody>
        ) : seasons.length === 0 ? (
          <EmptyState
            title="Сезонов пока нет"
            description="Создайте первый сезон формой ниже — до этого сезонные лидерборды пусты."
          />
        ) : (
          <Table ariaLabel="Сезоны">
            <TableHead>
              <tr>
                <Th>Название</Th>
                <Th>Период</Th>
                <Th>Статус</Th>
                <Th align="right">Действия</Th>
              </tr>
            </TableHead>
            <TableBody>
              {seasons.map((season) => (
                <TableRow key={season.id}>
                  <Td>{season.name}</Td>
                  <Td className="whitespace-nowrap text-ink-2">{formatRange(season)}</Td>
                  <Td>
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={STATUS_TONE[season.status]} size="sm">
                        {STATUS_LABELS[season.status]}
                      </Badge>
                      {season.finalized ? <Badge size="sm">финализирован</Badge> : null}
                    </span>
                  </Td>
                  <Td align="right">
                    {canManage && !season.finalized ? (
                      <span className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => startEdit(season)}>
                          Изменить
                        </Button>
                        {season.status === 'active' ? (
                          <Button size="sm" onClick={() => void closeSeason(season)}>
                            Закрыть
                          </Button>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-ink-3">только просмотр</span>
                    )}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card padding="none" as="section">
          <CardHeader title={editingId ? 'Изменение сезона' : 'Новый сезон'} />
          <form onSubmit={submit}>
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <FieldRow label="Название">
                <TextInput
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </FieldRow>
              <FieldRow label="Статус">
                <Select
                  value={form.status}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as FormState['status'] })
                  }
                >
                  <option value="upcoming">Запланирован</option>
                  <option value="active">Активный</option>
                </Select>
              </FieldRow>
              <FieldRow label="Начало">
                <TextInput
                  type="date"
                  value={form.startsAt}
                  onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
                />
              </FieldRow>
              <FieldRow label="Окончание">
                <TextInput
                  type="date"
                  value={form.endsAt}
                  onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
                />
              </FieldRow>
            </CardBody>
            <CardFooter>
              {editingId ? (
                <Button variant="secondary" onClick={resetForm}>
                  Отмена
                </Button>
              ) : null}
              <Button type="submit" variant="primary" loading={submitting}>
                {editingId ? 'Сохранить' : 'Создать'}
              </Button>
            </CardFooter>
          </form>
        </Card>
      ) : (
        <InlineBanner
          tone="info"
          title="Управление сезонами требует права на редактирование ролей."
        />
      )}
    </>
  );
}
