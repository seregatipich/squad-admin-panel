'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Pagination,
  SearchField,
  SegmentedControl,
  Select,
  SkeletonTable,
  StatusBadge,
  type StatusState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  TextInput,
  Th,
  Toolbar,
} from '@/components/ui';
import type { IssueLabel, IssueState, IssueView } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  authorLabel,
  BODY_MAX,
  buildApiQuery,
  buildQueryString,
  formatDateTime,
  type IssueFilters,
  issueMatchesFilters,
  PER_PAGE,
  parseFilters,
  removeIssue,
  STATE_FILTERS,
  STATE_LABELS,
  TITLE_MAX,
  totalPages,
  upsertIssue,
  validateCreateForm,
} from './helpers';
import { type PickedPlayer, PlayerSearchSelect } from './PlayerSearchSelect';

interface IssueListResponse {
  items: IssueView[];
  total: number;
  page: number;
  per_page: number;
}

/**
 * Состояние тикета в терминах индикаторов дизайн-системы: открытый тикет жив,
 * взятый в работу ждёт исполнителя, закрытый выведен из наблюдения. Смысл
 * несёт подпись бейджа, тон её только дублирует (§5).
 */
const STATE_STATE: Record<IssueState, StatusState> = {
  open: 'good',
  in_progress: 'warn',
  closed: 'idle',
};

const PAGINATION_LABELS = {
  previous: 'Назад',
  next: 'Вперёд',
  page: (page: number, of: number) => `Страница ${page} из ${of}`,
};

export function IssuesBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [issues, setIssues] = useState<IssueView[]>([]);
  const [total, setTotal] = useState(0);
  const [labels, setLabels] = useState<IssueLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assigneeName, setAssigneeName] = useState<string | null>(null);
  const idsRef = useRef<Set<string>>(new Set());

  const navigate = useCallback(
    (partial: Partial<IssueFilters>) => {
      const next: IssueFilters = {
        ...filters,
        ...partial,
        page: partial.page ?? 1,
      };
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/issues/labels', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data: { items: IssueLabel[] }) => {
        if (!cancelled) setLabels(data.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/issues?${buildApiQuery(filters)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as IssueListResponse;
      idsRef.current = new Set(data.items.map((issue) => issue.id));
      setIssues(data.items);
      setTotal(data.total);
      const assigned = filters.assignee
        ? (data.items.find((issue) => issue.assignee_player_id === filters.assignee)?.assignee ??
          null)
        : null;
      if (assigned) setAssigneeName(assigned.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const onIssueEvent = useCallback(
    (event: { data: { issue: IssueView } }) => {
      if (filters.page !== 1) return;
      const issue = event.data.issue;
      const matches = issueMatchesFilters(issue, filters);
      const existed = idsRef.current.has(issue.id);
      if (matches && !existed) {
        idsRef.current.add(issue.id);
        setTotal((t) => t + 1);
      } else if (!matches && existed) {
        idsRef.current.delete(issue.id);
        setTotal((t) => Math.max(0, t - 1));
      }
      setIssues((prev) =>
        matches ? upsertIssue(prev, issue).slice(0, PER_PAGE) : removeIssue(prev, issue.id),
      );
    },
    [filters],
  );
  useLiveSubscription('issue.created', onIssueEvent);
  useLiveSubscription('issue.updated', onIssueEvent);

  const pages = totalPages(total);
  const filtered = Boolean(filters.state || filters.label || filters.assignee || filters.q);

  const resetFilters = () => {
    setAssigneeName(null);
    navigate({ state: '', label: '', assignee: '', q: '' });
  };

  const searchSlot = (
    <SearchField
      value={filters.q}
      onCommit={(value) => navigate({ q: value })}
      placeholder="Поиск по тикетам"
      label="Поиск по тикетам"
      clearLabel="Очистить поиск"
    />
  );

  const filterSlot = (
    <>
      <SegmentedControl
        ariaLabel="Состояние тикета"
        value={filters.state}
        onChange={(value) => navigate({ state: value as '' | IssueState })}
        items={STATE_FILTERS.map((filter) => ({
          value: filter.value,
          label: filter.label,
        }))}
      />
      <Select
        aria-label="Метка"
        value={filters.label}
        onChange={(event) => navigate({ label: event.target.value })}
      >
        <option value="">Все метки</option>
        {labels.map((label) => (
          <option key={label.id} value={label.name}>
            {label.name}
          </option>
        ))}
      </Select>
      {filters.assignee ? (
        <>
          <Badge tone="accent">
            Исполнитель: {assigneeName ?? `${filters.assignee.slice(0, 8)}…`}
          </Badge>
          <Button
            variant="plain"
            size="sm"
            onClick={() => {
              setAssigneeName(null);
              navigate({ assignee: '' });
            }}
          >
            Сбросить исполнителя
          </Button>
        </>
      ) : (
        <div className="w-52">
          <PlayerSearchSelect
            placeholder="Фильтр по исполнителю"
            onSelect={(player: PickedPlayer) => {
              setAssigneeName(player.canonical_name);
              navigate({ assignee: player.id });
            }}
          />
        </div>
      )}
    </>
  );

  return (
    <PageContainer>
      <PageHeader
        title="Тикеты"
        subtitle="Внутренний трекер тикетов о панели: баги, предложения и вопросы. Любой пользователь панели может создать тикет и оставить комментарий."
        actions={
          <Button variant="primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Скрыть форму' : 'Создать тикет'}
          </Button>
        }
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить тикеты"
          description={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {showCreate ? (
        <CreateIssueForm
          labels={labels}
          onCreated={(issue) => {
            setShowCreate(false);
            router.push(`/issues/${issue.id}`);
          }}
        />
      ) : null}

      {/* Кнопка сброса существует только в паре со своим обработчиком — это
          навязывает союз типов `Toolbar`, — поэтому вариантов панели два, а
          общие слоты вынесены в переменные выше. */}
      {filtered ? (
        <Toolbar
          search={searchSlot}
          filters={filterSlot}
          summary={`Найдено: ${total}`}
          onReset={resetFilters}
          resetLabel="Сбросить фильтры"
        />
      ) : (
        <Toolbar search={searchSlot} filters={filterSlot} summary={`Найдено: ${total}`} />
      )}

      {loading ? (
        <Card padding="sm">
          <SkeletonTable rows={8} cols={6} label="Загрузка тикетов" />
        </Card>
      ) : issues.length === 0 ? (
        <Card padding="none">
          {filtered ? (
            <EmptyState
              variant="filtered"
              title="Ничего не нашлось"
              description="Ни один тикет не подходит под текущие фильтры."
              action={
                <Button size="sm" onClick={resetFilters}>
                  Сбросить фильтры
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Тикетов пока нет"
              description="Заведите первый тикет о баге, предложении или вопросе по панели."
              action={
                <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                  Создать тикет
                </Button>
              }
            />
          )}
        </Card>
      ) : (
        <Card padding="none">
          <Table ariaLabel="Тикеты">
            <TableHead>
              <TableRow>
                <Th align="right">№</Th>
                <Th>Заголовок</Th>
                <Th>Метки</Th>
                <Th>Автор</Th>
                <Th>Исполнитель</Th>
                <Th>Статус</Th>
                <Th>Обновлён</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {issues.map((issue) => (
                <TableRow key={issue.id} interactive>
                  <Td numeric className="text-ink-3">
                    #{issue.number}
                  </Td>
                  <Td>
                    <Link
                      href={`/issues/${issue.id}`}
                      className="text-accent no-underline hover:brightness-110"
                    >
                      {issue.title}
                    </Link>
                  </Td>
                  <Td>
                    {issue.labels.length === 0 ? (
                      <span className="text-xs text-ink-3">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {issue.labels.map((label) => (
                          <IssueLabelChip key={label.id} label={label} />
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td className="text-xs">
                    <Link
                      href={`/all-players/${issue.author_player_id}`}
                      className="text-ink-2 no-underline hover:text-ink"
                    >
                      {authorLabel(issue.author, issue.author_player_id)}
                    </Link>
                  </Td>
                  <Td className="text-xs text-ink-2">
                    {issue.assignee ? (
                      <Link
                        href={`/all-players/${issue.assignee.id}`}
                        className="text-ink-2 no-underline hover:text-ink"
                      >
                        {issue.assignee.name}
                      </Link>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </Td>
                  <Td>
                    <StatusBadge
                      state={STATE_STATE[issue.state]}
                      label={STATE_LABELS[issue.state]}
                      size="sm"
                    />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-2">
                    {formatDateTime(issue.updated_at)}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {!loading && issues.length > 0 && pages > 1 ? (
        <Pagination
          page={filters.page}
          pageCount={pages}
          onChange={(page) => navigate({ page })}
          labels={PAGINATION_LABELS}
          allowJump
        />
      ) : null}
    </PageContainer>
  );
}

/**
 * Метка тикета. Цвет приходит из базы вместе с меткой, поэтому `Badge` здесь
 * не подходит — его тона перечислены заранее и произвольный `background` он
 * не принимает. Форма и кегль всё равно повторяют пилюлю дизайн-системы.
 */
function IssueLabelChip({ label }: { label: IssueLabel }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-px text-2xs font-medium text-ink"
      style={{ backgroundColor: label.color }}
    >
      {label.name}
    </span>
  );
}

function CreateIssueForm({
  labels,
  onCreated,
}: {
  labels: IssueLabel[];
  onCreated: (issue: IssueView) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleLabel(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const check = validateCreateForm({ title, body, labelCount: selected.size });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/issues', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          labels: Array.from(selected),
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${errBody.error ?? 'unknown'}`);
      }
      onCreated((await res.json()) as IssueView);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const titleOver = title.length > TITLE_MAX;
  const bodyOver = body.length > BODY_MAX;

  return (
    <Card padding="none" as="section">
      <CardHeader title="Создать тикет" />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <FieldRow
            label="Заголовок"
            hint={`${title.length}/${TITLE_MAX}`}
            error={titleOver ? 'Заголовок длиннее допустимого.' : undefined}
          >
            <TextInput
              value={title}
              invalid={titleOver}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Короткое описание проблемы"
            />
          </FieldRow>

          <FieldRow
            label="Описание"
            hint={`${body.length}/${BODY_MAX}`}
            error={bodyOver ? 'Описание длиннее допустимого.' : undefined}
          >
            <Textarea
              value={body}
              invalid={bodyOver}
              rows={4}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Что произошло, как воспроизвести"
            />
          </FieldRow>

          {labels.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-ink-2">Метки</legend>
              <div className="flex flex-wrap gap-2">
                {labels.map((label) => {
                  const active = selected.has(label.name);
                  return (
                    <button
                      key={label.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleLabel(label.name)}
                      className={`h-7 rounded-ctl px-2.5 text-2xs font-medium transition-colors duration-150 ${
                        active ? 'text-bg' : 'border border-line bg-raised text-ink-2'
                      }`}
                      style={active ? { backgroundColor: label.color } : undefined}
                    >
                      {label.name}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {error ? <InlineBanner tone="crit" title="Тикет не создан" description={error} /> : null}

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              disabled={titleOver || bodyOver}
            >
              Создать тикет
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
