'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
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
  SegmentedControl,
  Skeleton,
  StatusBadge,
  type StatusState,
  TextInput,
  Toolbar,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  type AppealFilters,
  type AppealStatus,
  allowedTransitions,
  appealNumberLabel,
  buildApiQuery,
  buildQueryString,
  formatDateTime,
  isTerminal,
  NOTE_MAX,
  parseFilters,
  STATUS_FILTERS,
  STATUS_LABELS,
  totalPages,
} from './helpers';

interface AppealItem {
  id: string;
  number: number;
  status: AppealStatus;
  steam_id64: string;
  body: string;
  contact: string | null;
  decision_note: string | null;
  internal_note: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  player: { id: string; name: string | null; steam_id64: string | null } | null;
  moderation_action: {
    id: string;
    action_type: string | null;
    reason: string | null;
    created_at: string;
    ban_length: string | null;
  } | null;
  handler: { id: string; name: string | null } | null;
}

interface AppealListResponse {
  items: AppealItem[];
  total: number;
  page: number;
  page_size: number;
}

const ACTION_LABELS: Record<AppealStatus, string> = {
  pending: 'В очередь',
  in_review: 'В работу',
  approved: 'Одобрить',
  rejected: 'Отклонить',
};

/**
 * Одобрение — это разбан, то есть подтверждающее действие карточки, поэтому
 * оно первично. Отклонение ничего не разрушает необратимо (§5 дизайн-системы
 * оставляет `destructive` за уничтожением данных), поэтому остаётся вторичным
 * и отличается от одобрения подписью, а не цветом.
 */
const ACTION_VARIANT: Record<AppealStatus, 'primary' | 'secondary'> = {
  pending: 'secondary',
  in_review: 'secondary',
  approved: 'primary',
  rejected: 'secondary',
};

/**
 * Состояние заявки в терминах индикаторов дизайн-системы.
 *
 * `in_review` и `rejected` делят тон `idle`: ни то, ни другое не требует от
 * оператора действия прямо сейчас, а различает их подпись бейджа — состояние
 * никогда не кодируется одним цветом (§5).
 */
const STATUS_STATE: Record<AppealStatus, StatusState> = {
  pending: 'warn',
  in_review: 'idle',
  approved: 'good',
  rejected: 'idle',
};

const PAGINATION_LABELS = {
  previous: 'Назад',
  next: 'Вперёд',
  page: (page: number, of: number) => `Страница ${page} из ${of}`,
};

/**
 * «Апелляции» (MOD-5, #62) — очередь рассмотрения апелляций на бан.
 *
 * Гейт — каталожный ключ `mod:unban`; отдельного capability-флага в
 * `GET /api/v1/me` нет, поэтому доступ определяется ответом самого списка:
 * `403` от `GET /api/v1/appeals` прячет очередь целиком (self-hide-on-403).
 *
 * Одобрение здесь — это разбан: API снимает бан через общий путь MOD-2, и
 * игрок исчезает из публикуемого банлиста. Публичный `decision_note` видит
 * заявитель на странице `/appeal/<token>`, `internal_note` — только панель.
 */
export function AppealsBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = parseFilters(searchParams);

  const [items, setItems] = useState<AppealItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  // Какое именно решение сейчас уходит на сервер: индикатор обязан остаться на
  // нажатой кнопке, а не появиться сразу на всех решениях карточки (§8).
  const [busyAction, setBusyAction] = useState<{ id: string; status: AppealStatus } | null>(null);
  const [decisionNote, setDecisionNote] = useState<Record<string, string>>({});
  const [internalNote, setInternalNote] = useState<Record<string, string>>({});

  const navigate = useCallback(
    (partial: Partial<AppealFilters>) => {
      const next = { ...filters, ...partial, page: partial.page ?? 1 };
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const { status: filterStatus, page: filterPage } = filters;
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/appeals?${buildApiQuery({ status: filterStatus, page: filterPage })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (res.status === 403 || res.status === 401) {
        setForbidden(true);
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AppealListResponse;
      setForbidden(false);
      setItems(data.items);
      setTotal(data.total);
      setLastUpdate(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAppealChanged = useCallback(() => {
    setLastUpdate(new Date());
    void load();
  }, [load]);
  useLiveSubscription('appeal.created', onAppealChanged);
  useLiveSubscription('appeal.updated', onAppealChanged);

  async function decide(appeal: AppealItem, status: AppealStatus) {
    setBusyAction({ id: appeal.id, status });
    setError(null);
    try {
      const payload: Record<string, unknown> = { status };
      const note = decisionNote[appeal.id]?.trim();
      if (note) payload.decision_note = note;
      const internal = internalNote[appeal.id]?.trim();
      if (internal) payload.internal_note = internal;

      const res = await fetch(`/api/v1/appeals/${appeal.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(`Не удалось обработать апелляцию: ${data.error ?? res.status}`);
        return;
      }
      await load();
    } catch (e) {
      setError(`Ошибка сети: ${(e as Error).message}`);
    } finally {
      setBusyAction(null);
    }
  }

  const pages = totalPages(total);

  // Заголовок страницы остаётся на всех ветках, включая отказ в доступе:
  // единственный `h1` — та опора, по которой оператор понимает, где он.
  const header = (
    <PageHeader
      title="Апелляции"
      subtitle="Публичный портал /appeal: забаненный игрок оставляет апелляцию без входа в панель и следит за решением по своей ссылке. Одобрение снимает бан и убирает игрока из публикуемого банлиста."
      status={<LiveIndicator lastUpdate={lastUpdate} />}
    />
  );

  if (forbidden) {
    return (
      <PageContainer width="wide">
        {header}
        <Card padding="none">
          <EmptyState
            title="Недостаточно прав для просмотра апелляций"
            description="Очередь открывается по праву mod:unban. Запросите его у администратора панели."
          />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      {header}

      <Toolbar
        filters={
          <SegmentedControl
            ariaLabel="Статус апелляции"
            value={filters.status}
            onChange={(value) => navigate({ status: value as '' | AppealStatus })}
            items={STATUS_FILTERS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
        }
        summary={`Всего: ${total}`}
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Ошибка запроса"
          description={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {loading ? (
        <Skeleton variant="card" count={3} label="Загрузка апелляций" />
      ) : items.length === 0 ? (
        <Card padding="none">
          {filters.status ? (
            <EmptyState
              variant="filtered"
              title="Апелляций нет"
              description="По выбранному статусу заявок не нашлось."
              action={
                <Button size="sm" onClick={() => navigate({ status: '' })}>
                  Сбросить фильтр
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Апелляций нет"
              description="Заявки появятся здесь, как только забаненный игрок отправит апелляцию с публичного портала."
            />
          )}
        </Card>
      ) : (
        <ul className="space-y-4">
          {items.map((appeal) => (
            <li key={appeal.id}>
              <AppealCard
                appeal={appeal}
                busyStatus={busyAction?.id === appeal.id ? busyAction.status : null}
                decisionNote={decisionNote[appeal.id] ?? ''}
                internalNote={internalNote[appeal.id] ?? ''}
                onDecisionNoteChange={(value) =>
                  setDecisionNote((map) => ({ ...map, [appeal.id]: value }))
                }
                onInternalNoteChange={(value) =>
                  setInternalNote((map) => ({ ...map, [appeal.id]: value }))
                }
                onDecide={(status) => void decide(appeal, status)}
              />
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
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

function AppealCard({
  appeal,
  busyStatus,
  decisionNote,
  internalNote,
  onDecisionNoteChange,
  onInternalNoteChange,
  onDecide,
}: {
  appeal: AppealItem;
  /** Решение, которое сейчас отправляется по этой заявке, или `null`. */
  busyStatus: AppealStatus | null;
  decisionNote: string;
  internalNote: string;
  onDecisionNoteChange: (value: string) => void;
  onInternalNoteChange: (value: string) => void;
  onDecide: (status: AppealStatus) => void;
}) {
  const transitions = allowedTransitions(appeal.status);

  return (
    <Card padding="none">
      <CardHeader
        title={appealNumberLabel(appeal.number)}
        actions={
          <>
            <span className="text-xs text-ink-3">{formatDateTime(appeal.created_at)}</span>
            <StatusBadge
              state={STATUS_STATE[appeal.status]}
              label={STATUS_LABELS[appeal.status]}
              size="sm"
            />
          </>
        }
      />

      <CardBody className="space-y-3">
        <p className="text-xs text-ink-2">
          <span className="font-mono">{appeal.steam_id64}</span>
          {appeal.player?.name ? ` · ${appeal.player.name}` : ' · игрок не найден в базе'}
          {appeal.contact ? ` · контакт: ${appeal.contact}` : ''}
        </p>

        {appeal.moderation_action ? (
          <p className="text-xs text-ink-3">
            {`Обжалуемый бан от ${formatDateTime(appeal.moderation_action.created_at)}${
              appeal.moderation_action.reason
                ? ` · причина: ${appeal.moderation_action.reason}`
                : ''
            }${
              appeal.moderation_action.ban_length
                ? ` · срок: ${appeal.moderation_action.ban_length}`
                : ''
            }`}
          </p>
        ) : (
          <p className="text-xs text-ink-3">Активный бан не найден.</p>
        )}

        <p className="whitespace-pre-wrap text-[13px] text-ink">{appeal.body}</p>

        {appeal.internal_note ? (
          <p className="text-xs text-warn">Внутренняя заметка: {appeal.internal_note}</p>
        ) : null}

        {isTerminal(appeal.status) ? (
          <p className="border-t border-line pt-3 text-xs text-ink-3">
            {`Решение от ${formatDateTime(appeal.decided_at)}${
              appeal.handler?.name ? ` · ${appeal.handler.name}` : ''
            }${appeal.decision_note ? ` · «${appeal.decision_note}»` : ''}`}
          </p>
        ) : (
          <div className="space-y-3 border-t border-line pt-3">
            <FieldRow label="Ответ заявителю" hint="Его увидит заявитель на публичной странице.">
              <TextInput
                value={decisionNote}
                maxLength={NOTE_MAX}
                onChange={(event) => onDecisionNoteChange(event.target.value)}
                placeholder="Ответ заявителю (необязательно)"
              />
            </FieldRow>
            <FieldRow label="Внутренняя заметка" hint="Наружу не отдаётся.">
              <TextInput
                value={internalNote}
                maxLength={NOTE_MAX}
                onChange={(event) => onInternalNoteChange(event.target.value)}
                placeholder="Внутренняя заметка (необязательно)"
              />
            </FieldRow>
            <div className="flex flex-wrap justify-end gap-2">
              {transitions.map((next) => (
                <Button
                  key={next}
                  variant={ACTION_VARIANT[next]}
                  size="sm"
                  loading={busyStatus === next}
                  disabled={busyStatus !== null}
                  onClick={() => onDecide(next)}
                >
                  {ACTION_LABELS[next]}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
