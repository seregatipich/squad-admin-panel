'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
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
  STATUS_BADGE_CLASSES,
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

const ACTION_CLASSES: Record<AppealStatus, string> = {
  pending: 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800',
  in_review: 'border-sky-700 bg-sky-950 text-sky-200 hover:bg-sky-900',
  approved: 'border-emerald-700 bg-emerald-950 text-emerald-200 hover:bg-emerald-900',
  rejected: 'border-red-800 bg-red-950 text-red-200 hover:bg-red-900',
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
  const [busyId, setBusyId] = useState<string | null>(null);
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
    setBusyId(appeal.id);
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
      setBusyId(null);
    }
  }

  if (forbidden) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 px-4 py-6 text-center text-sm text-neutral-400">
        Недостаточно прав для просмотра апелляций.
      </div>
    );
  }

  const pages = totalPages(total);

  return (
    <div className="space-y-6">
      <div className="flex max-w-4xl items-center justify-between gap-3">
        <div className="flex items-baseline gap-4">
          <h1 className="text-2xl font-semibold">Апелляции</h1>
          <span className="text-sm text-neutral-500">всего: {total}</span>
        </div>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="max-w-4xl text-xs text-neutral-500">
        Публичный портал <code>/appeal</code>: забаненный игрок оставляет апелляцию без входа в
        панель и следит за решением по своей ссылке. Одобрение снимает бан и убирает игрока из
        публикуемого банлиста.
      </p>

      {error ? (
        <div className="max-w-4xl rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-400">Статус:</span>
        {STATUS_FILTERS.map((option) => (
          <button
            key={option.value || 'all'}
            type="button"
            onClick={() => navigate({ status: option.value })}
            className={`rounded border px-2 py-1 text-xs ${
              filters.status === option.value
                ? 'border-sky-700 bg-sky-950 text-sky-200'
                : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? <p className="text-sm text-neutral-500">Загрузка…</p> : null}

      {!loading && items.length === 0 ? (
        <p className="max-w-4xl py-6 text-center text-sm text-neutral-500">Апелляций нет.</p>
      ) : (
        <ul className="max-w-4xl space-y-3">
          {items.map((appeal) => (
            <li
              key={appeal.id}
              className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-sm text-neutral-300">
                    {appealNumberLabel(appeal.number)}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] ${STATUS_BADGE_CLASSES[appeal.status]}`}
                  >
                    {STATUS_LABELS[appeal.status]}
                  </span>
                </div>
                <span className="text-xs text-neutral-500">
                  {formatDateTime(appeal.created_at)}
                </span>
              </div>

              <div className="text-xs text-neutral-400">
                <span className="font-mono">{appeal.steam_id64}</span>
                {appeal.player?.name ? ` · ${appeal.player.name}` : ' · игрок не найден в базе'}
                {appeal.contact ? ` · контакт: ${appeal.contact}` : ''}
              </div>

              {appeal.moderation_action ? (
                <div className="text-xs text-neutral-500">
                  Обжалуемый бан от {formatDateTime(appeal.moderation_action.created_at)}
                  {appeal.moderation_action.reason
                    ? ` · причина: ${appeal.moderation_action.reason}`
                    : ''}
                  {appeal.moderation_action.ban_length
                    ? ` · срок: ${appeal.moderation_action.ban_length}`
                    : ''}
                </div>
              ) : (
                <div className="text-xs text-neutral-600">Активный бан не найден.</div>
              )}

              <p className="whitespace-pre-wrap text-sm text-neutral-200">{appeal.body}</p>

              {appeal.internal_note ? (
                <p className="text-xs text-amber-300/80">
                  Внутренняя заметка: {appeal.internal_note}
                </p>
              ) : null}

              {isTerminal(appeal.status) ? (
                <div className="border-t border-neutral-900 pt-2 text-xs text-neutral-500">
                  Решение от {formatDateTime(appeal.decided_at)}
                  {appeal.handler?.name ? ` · ${appeal.handler.name}` : ''}
                  {appeal.decision_note ? ` · «${appeal.decision_note}»` : ''}
                </div>
              ) : (
                <div className="space-y-2 border-t border-neutral-900 pt-3">
                  <label className="block text-xs">
                    <span className="mb-1 block text-neutral-500">
                      Ответ заявителю — его увидит заявитель на публичной странице
                    </span>
                    <input
                      type="text"
                      value={decisionNote[appeal.id] ?? ''}
                      maxLength={NOTE_MAX}
                      onChange={(e) =>
                        setDecisionNote((m) => ({ ...m, [appeal.id]: e.target.value }))
                      }
                      placeholder="Ответ заявителю (необязательно)"
                      className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="mb-1 block text-neutral-500">
                      Внутренняя заметка — наружу не отдаётся
                    </span>
                    <input
                      type="text"
                      value={internalNote[appeal.id] ?? ''}
                      maxLength={NOTE_MAX}
                      onChange={(e) =>
                        setInternalNote((m) => ({ ...m, [appeal.id]: e.target.value }))
                      }
                      placeholder="Внутренняя заметка (необязательно)"
                      className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {allowedTransitions(appeal.status).map((next) => (
                      <button
                        key={next}
                        type="button"
                        disabled={busyId === appeal.id}
                        onClick={() => decide(appeal, next)}
                        className={`rounded-md border px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${ACTION_CLASSES[next]}`}
                      >
                        {ACTION_LABELS[next]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <div className="flex max-w-4xl items-center gap-3 text-sm">
          <button
            type="button"
            disabled={filters.page <= 1}
            onClick={() => navigate({ page: filters.page - 1 })}
            className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 disabled:opacity-40"
          >
            Назад
          </button>
          <span className="text-xs text-neutral-500">
            {filters.page} / {pages}
          </span>
          <button
            type="button"
            disabled={filters.page >= pages}
            onClick={() => navigate({ page: filters.page + 1 })}
            className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 disabled:opacity-40"
          >
            Вперёд
          </button>
        </div>
      ) : null}
    </div>
  );
}
