'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  Button,
  Card,
  CardHeader,
  EmptyState,
  InlineBanner,
  Pagination,
  SearchField,
  Skeleton,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';
import { ApiError, ApiResponseError, apiFetch, apiSend } from '@/lib/api';
import { AddMemberModal } from './AddMemberModal';
import { RosterTable } from './RosterTable';
import {
  deriveCapabilities,
  type MeResponse,
  PAGE_LIMIT,
  PRIORITY_LOCK_MS,
  type PriorityErrorBody,
  priorityErrorMessage,
  type RosterMember,
  type RosterResponse,
  type SortField,
  transferLeadershipMessage,
} from './roster-model';

/*
 * Ссылка на выгрузку остаётся обычным `<a>`, а не `ButtonLink`: `next/link`
 * перехватывает клик и уводит в клиентскую навигацию, из-за чего файл не
 * скачивается. Классы повторяют вторичную кнопку размера `sm` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

/**
 * Ростер клана: состав, роли, слоты приоритета и действия над участниками.
 *
 * Удаление участника и передача лидерства подтверждаются `AlertDialog`, а не
 * нативным `confirm()`: диалог называет игрока по имени, ставит подтверждающую
 * кнопку справа и возвращает фокус на строку, из которой был вызван.
 */
export default function RosterPanel({
  clanId,
  canManageClans,
}: {
  clanId: string;
  /**
   * The viewer's global `can_manage_clans` flag when the parent already knows
   * it (`null` while the parent is still loading it). When omitted the panel
   * fetches `/api/v1/me` itself.
   */
  canManageClans?: boolean | null;
}) {
  const [fetchedMe, setMe] = useState<MeResponse | null>(null);
  const me = useMemo<MeResponse | null>(
    () =>
      typeof canManageClans === 'boolean'
        ? { player_id: '', can_manage_clans: canManageClans }
        : fetchedMe,
    [canManageClans, fetchedMe],
  );
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortField>('role');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [busyPlayerIds, setBusyPlayerIds] = useState<Set<string>>(new Set());
  const latestRosterRequestRef = useRef(0);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<RosterMember | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<RosterMember | null>(null);
  const [lockedPlayerIds, setLockedPlayerIds] = useState<Set<string>>(new Set());
  const lockTimeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timeouts = lockTimeoutsRef.current;
    return () => {
      for (const timeout of timeouts.values()) clearTimeout(timeout);
    };
  }, []);

  const lockRow = useCallback((playerId: string) => {
    setLockedPlayerIds((prev) => new Set(prev).add(playerId));
    const existing = lockTimeoutsRef.current.get(playerId);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      setLockedPlayerIds((prev) => {
        const next = new Set(prev);
        next.delete(playerId);
        return next;
      });
      lockTimeoutsRef.current.delete(playerId);
    }, PRIORITY_LOCK_MS);
    lockTimeoutsRef.current.set(playerId, timeout);
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setMe(await apiFetch<MeResponse>('/api/v1/me'));
    } catch {
      /* ignore */
    }
  }, []);

  const loadRoster = useCallback(async () => {
    const requestId = ++latestRosterRequestRef.current;
    try {
      const query = new URLSearchParams({
        sort,
        order,
        page: String(page),
        limit: String(PAGE_LIMIT),
      });
      if (q.trim().length > 0) query.set('q', q.trim());
      const body = await apiFetch<RosterResponse>(
        `/api/v1/clans/${clanId}/members?${query.toString()}`,
      );
      // Ответ на устаревший запрос (другой поиск, сортировка, страница) не применяем.
      if (requestId !== latestRosterRequestRef.current) return;
      const lastPage = Math.max(1, Math.ceil(body.total / PAGE_LIMIT));
      if (page > lastPage) {
        // Последняя строка последней страницы удалена: переходим на новую последнюю.
        setPage(lastPage);
        return;
      }
      setRoster(body);
      setErr(null);
    } catch (e) {
      if (requestId !== latestRosterRequestRef.current) return;
      setErr(
        e instanceof ApiError ? `Не удалось загрузить ростер (${e.status})` : (e as Error).message,
      );
    }
  }, [clanId, q, sort, order, page]);

  useEffect(() => {
    if (canManageClans === undefined) void loadMe();
  }, [loadMe, canManageClans]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const members = roster?.items ?? [];
  const caps = useMemo(
    () => deriveCapabilities(me, roster?.viewer_manage_level ?? null),
    [me, roster],
  );

  const mutate = useCallback(
    async (
      playerId: string,
      run: () => Promise<unknown>,
      mapError: (body: PriorityErrorBody) => string = (body) =>
        `Действие не выполнено: ${body.error ?? 'unknown'}`,
      onSuccess?: (body: unknown) => void,
    ) => {
      setBusyPlayerIds((prev) => new Set(prev).add(playerId));
      setInfo(null);
      try {
        let body: unknown;
        try {
          body = await run();
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          setErr(mapError((e.jsonBody() ?? {}) as PriorityErrorBody));
          return false;
        }
        setErr(null);
        onSuccess?.(body ?? {});
        await loadRoster();
        return true;
      } catch (e) {
        setErr((e as Error).message);
        return false;
      } finally {
        setBusyPlayerIds((prev) => {
          const next = new Set(prev);
          next.delete(playerId);
          return next;
        });
      }
    },
    [loadRoster],
  );

  const changeRole = useCallback(
    (playerId: string, role: string) =>
      mutate(playerId, () =>
        apiSend(`/api/v1/clans/${clanId}/members/${playerId}`, {
          method: 'PATCH',
          json: { member_role: role },
        }),
      ),
    [clanId, mutate],
  );

  const confirmRemove = useCallback(async () => {
    const member = pendingRemove;
    if (!member) return;
    await mutate(member.player_id, () =>
      apiSend(`/api/v1/clans/${clanId}/members/${member.player_id}`, { method: 'DELETE' }),
    );
    setPendingRemove(null);
  }, [clanId, mutate, pendingRemove]);

  const confirmTransfer = useCallback(async () => {
    const member = pendingTransfer;
    if (!member) return;
    await mutate(member.player_id, () =>
      apiSend(`/api/v1/clans/${clanId}/transfer-leadership`, {
        method: 'POST',
        json: { player_id: member.player_id },
      }),
    );
    setPendingTransfer(null);
  }, [clanId, mutate, pendingTransfer]);

  const togglePriority = useCallback(
    async (member: RosterMember, enabled: boolean) => {
      const ok = await mutate(
        member.player_id,
        () =>
          apiSend(`/api/v1/clans/${clanId}/members/${member.player_id}/priority`, {
            method: 'PUT',
            json: { enabled },
          }),
        priorityErrorMessage,
      );
      // Mirrors SQSTAT: briefly lock the row after a successful toggle so
      // rapid re-clicks can't race the pool-limit check on the server.
      if (ok) lockRow(member.player_id);
    },
    [clanId, mutate, lockRow],
  );

  const addMember = useCallback(
    async (playerId: string, role: string) => {
      const ok = await mutate(
        playerId,
        () =>
          apiFetch<unknown>(`/api/v1/clans/${clanId}/members`, {
            method: 'POST',
            json: { player_id: playerId, member_role: role },
          }).catch((e: unknown) => {
            // A 2xx without a JSON body still counts as success.
            if (e instanceof ApiResponseError) return {};
            throw e;
          }),
        undefined,
        (body) => {
          // #14 follow-up: the first member of an empty clan is always
          // forced to 'leader' regardless of the requested role — the API
          // flags this with role_overridden so the operator isn't left
          // thinking their chosen role was honored.
          if ((body as { role_overridden?: boolean }).role_overridden) {
            setInfo(
              'Первый участник клана всегда становится главой — выбранная роль не применена.',
            );
          }
        },
      );
      if (ok) setAddOpen(false);
    },
    [clanId, mutate],
  );

  // Повторное нажатие по активной колонке разворачивает порядок, переход на
  // другую — начинает с возрастания.
  const changeSort = useCallback(
    (key: string) => {
      const field = key as SortField;
      setPage(1);
      if (field === sort) {
        setOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSort(field);
      setOrder('asc');
    },
    [sort],
  );

  const total = roster?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_LIMIT));
  const searching = q.trim().length > 0;
  const resetProps: ToolbarProps = searching
    ? { onReset: () => setQ(''), resetLabel: 'Сбросить фильтр' }
    : {};

  return (
    <section className="space-y-4">
      <Card padding="none">
        <CardHeader
          title="Ростер"
          count={roster ? total : undefined}
          description={
            roster
              ? `Приоритет: ${roster.priority_count} из ${roster.max_priority_slots}`
              : undefined
          }
          actions={
            <>
              <a
                href={`/api/v1/clans/${clanId}/roster/export?format=csv`}
                className={DOWNLOAD_LINK_CLASS}
              >
                Экспорт CSV
              </a>
              {caps.canAdd ? (
                <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
                  Добавить участника
                </Button>
              ) : null}
            </>
          }
        />

        <div className="space-y-3 p-3">
          {err ? (
            <InlineBanner
              tone="crit"
              title="Действие не выполнено"
              description={err}
              action={
                <Button size="sm" onClick={() => void loadRoster()}>
                  Повторить
                </Button>
              }
            />
          ) : null}

          {info ? (
            <InlineBanner
              tone="info"
              title="Роль изменена автоматически"
              description={info}
              onDismiss={() => setInfo(null)}
              dismissLabel="Скрыть уведомление"
            />
          ) : null}

          <Toolbar
            search={
              <SearchField
                value={q}
                onCommit={(next) => {
                  setPage(1);
                  setQ(next);
                }}
                label="Поиск участника"
                placeholder="Ник, SteamID64 или EOS ID"
                clearLabel="Очистить поиск"
              />
            }
            {...resetProps}
            summary={roster ? `Найдено ${total}` : undefined}
          />
        </div>

        {roster === null ? (
          <div className="p-3">
            <Skeleton variant="row" count={6} label="Загружаем ростер" />
          </div>
        ) : members.length === 0 ? (
          <EmptyState
            variant={searching ? 'filtered' : 'initial'}
            title={searching ? 'Ничего не нашлось' : 'В клане пока нет участников'}
            description={
              searching
                ? 'Ни один участник не подходит под запрос.'
                : 'Добавьте игроков, чтобы вести состав и раздавать слоты приоритета.'
            }
            action={searching ? <Button onClick={() => setQ('')}>Сбросить фильтр</Button> : null}
          />
        ) : (
          <RosterTable
            members={members}
            caps={caps}
            sort={sort}
            order={order}
            onSort={changeSort}
            busyPlayerIds={busyPlayerIds}
            lockedPlayerIds={lockedPlayerIds}
            onChangeRole={changeRole}
            onRemove={setPendingRemove}
            onTransfer={setPendingTransfer}
            onTogglePriority={togglePriority}
          />
        )}

        {pageCount > 1 ? (
          <div className="flex justify-end border-t border-line p-3">
            <Pagination
              page={page}
              pageCount={pageCount}
              onChange={setPage}
              labels={{
                previous: 'Назад',
                next: 'Вперёд',
                page: (current, of) => `Стр. ${current} из ${of}`,
              }}
            />
          </div>
        ) : null}
      </Card>

      <AddMemberModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={addMember}
        allowDeputy={caps.canManageFull}
      />

      <AlertDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        title="Удалить участника?"
        body={
          pendingRemove
            ? `${pendingRemove.canonical_name} потеряет место в ростере и слот приоритета клана.`
            : ''
        }
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="destructive"
        busy={pendingRemove !== null && busyPlayerIds.has(pendingRemove.player_id)}
        onConfirm={() => void confirmRemove()}
      />

      <AlertDialog
        open={pendingTransfer !== null}
        onClose={() => setPendingTransfer(null)}
        title="Передать лидерство?"
        body={
          pendingTransfer
            ? transferLeadershipMessage(caps.isLeader, pendingTransfer.canonical_name)
            : ''
        }
        confirmLabel="Передать"
        cancelLabel="Отмена"
        tone="default"
        busy={pendingTransfer !== null && busyPlayerIds.has(pendingTransfer.player_id)}
        onConfirm={() => void confirmTransfer()}
      />
    </section>
  );
}
