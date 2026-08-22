'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  IconButton,
  InlineBanner,
  Modal,
  Pagination,
  SearchField,
  Select,
  Skeleton,
  SortableTh,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
  type ToolbarProps,
  TrashIcon,
} from '@/components/ui';

export interface RosterMember {
  player_id: string;
  canonical_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  member_role: string;
  has_priority: boolean;
  reserve_from_role: boolean;
  joined_at: string;
  last_seen_at: string | null;
  online_60d_seconds: number;
}

interface RosterResponse {
  clan_id: string;
  items: RosterMember[];
  total: number;
  page: number;
  limit: number;
  priority_count: number;
  max_priority_slots: number;
}

interface PriorityErrorBody {
  error?: string;
  limit?: number;
  used?: number;
}

/**
 * Maps a `PUT .../priority` error body to a Russian message for the error
 * banner. `priority_pool_limit` includes the pool usage when the API
 * returns it; other codes fall back to a fixed message.
 */
export function priorityErrorMessage(body: PriorityErrorBody): string {
  switch (body.error) {
    case 'priority_pool_limit':
      return typeof body.used === 'number' && typeof body.limit === 'number'
        ? `Лимит пула приоритетов исчерпан (${body.used} из ${body.limit})`
        : 'Лимит пула приоритетов исчерпан';
    case 'priority_expired':
      return 'Срок приоритета клана истёк';
    case 'priority_source_conflict':
      return 'Приоритет уже предоставлен через роль игрока';
    default:
      return `Действие не выполнено: ${body.error ?? 'unknown'}`;
  }
}

interface MeResponse {
  player_id: string;
  can_manage_clans: boolean;
}

interface SearchCandidate {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  clan_id: string | null;
  clan_name: string | null;
}

export const ROLE_LABELS: Record<string, string> = {
  leader: 'Глава',
  deputy: 'Зам',
  member: 'Участник',
};

const PAGE_LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 3;
const PRIORITY_LOCK_MS = 3000;

/** Подписи направления сортировки — часть доступного имени заголовка колонки. */
const SORT_DIRECTION_TEXT = { asc: 'по возрастанию', desc: 'по убыванию' } as const;

/*
 * Ссылка на выгрузку остаётся обычным `<a>`, а не `ButtonLink`: `next/link`
 * перехватывает клик и уводит в клиентскую навигацию, из-за чего файл не
 * скачивается. Классы повторяют вторичную кнопку размера `sm` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

export type SortField = 'name' | 'role' | 'priority' | 'joined_at' | 'last_seen' | 'online';

export function memberRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function formatOnlineDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} ч`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин`;
}

/** Формат даты в колонках «Вступил» и «Был(а)»: один и тот же для обеих. */
export function formatMemberDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface Capabilities {
  canAdd: boolean;
  canRemoveMembers: boolean;
  canManageFull: boolean;
  canTogglePriority: boolean;
}

export function deriveCapabilities(me: MeResponse | null, members: RosterMember[]): Capabilities {
  const myRole = me ? members.find((m) => m.player_id === me.player_id)?.member_role : undefined;
  const canManageFull = Boolean(me?.can_manage_clans) || myRole === 'leader';
  const isDeputy = myRole === 'deputy';
  return {
    canManageFull,
    canAdd: canManageFull || isDeputy,
    canRemoveMembers: canManageFull || isDeputy,
    // Mirrors the API gate on PUT .../priority (clanManageLevel !== null):
    // full managers and deputies may toggle, rank-and-file members may not.
    canTogglePriority: canManageFull || isDeputy,
  };
}

/**
 * Ростер клана: состав, роли, слоты приоритета и действия над участниками.
 *
 * Удаление участника и передача лидерства подтверждаются `AlertDialog`, а не
 * нативным `confirm()`: диалог называет игрока по имени, ставит подтверждающую
 * кнопку справа и возвращает фокус на строку, из которой был вызван.
 */
export default function RosterPanel({ clanId }: { clanId: string }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortField>('role');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);
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
      const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return;
      setMe((await res.json()) as MeResponse);
    } catch {
      /* ignore */
    }
  }, []);

  const loadRoster = useCallback(async () => {
    try {
      const query = new URLSearchParams({
        sort,
        order,
        page: String(page),
        limit: String(PAGE_LIMIT),
      });
      if (q.trim().length > 0) query.set('q', q.trim());
      const res = await fetch(`/api/v1/clans/${clanId}/members?${query.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Не удалось загрузить ростер (${res.status})`);
      setRoster((await res.json()) as RosterResponse);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [clanId, q, sort, order, page]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const members = roster?.items ?? [];
  const caps = useMemo(() => deriveCapabilities(me, members), [me, members]);

  const mutate = useCallback(
    async (
      playerId: string,
      run: () => Promise<Response>,
      mapError: (body: PriorityErrorBody) => string = (body) =>
        `Действие не выполнено: ${body.error ?? 'unknown'}`,
    ) => {
      setBusyPlayerId(playerId);
      try {
        const res = await run();
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as PriorityErrorBody;
          setErr(mapError(body));
          return false;
        }
        setErr(null);
        await loadRoster();
        return true;
      } catch (e) {
        setErr((e as Error).message);
        return false;
      } finally {
        setBusyPlayerId(null);
      }
    },
    [loadRoster],
  );

  const changeRole = useCallback(
    (playerId: string, role: string) =>
      mutate(playerId, () =>
        fetch(`/api/v1/clans/${clanId}/members/${playerId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ member_role: role }),
        }),
      ),
    [clanId, mutate],
  );

  const confirmRemove = useCallback(async () => {
    const member = pendingRemove;
    if (!member) return;
    await mutate(member.player_id, () =>
      fetch(`/api/v1/clans/${clanId}/members/${member.player_id}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
    setPendingRemove(null);
  }, [clanId, mutate, pendingRemove]);

  const confirmTransfer = useCallback(async () => {
    const member = pendingTransfer;
    if (!member) return;
    await mutate(member.player_id, () =>
      fetch(`/api/v1/clans/${clanId}/transfer-leadership`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ player_id: member.player_id }),
      }),
    );
    setPendingTransfer(null);
  }, [clanId, mutate, pendingTransfer]);

  const togglePriority = useCallback(
    async (member: RosterMember, enabled: boolean) => {
      const ok = await mutate(
        member.player_id,
        () =>
          fetch(`/api/v1/clans/${clanId}/members/${member.player_id}/priority`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
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
      const ok = await mutate(playerId, () =>
        fetch(`/api/v1/clans/${clanId}/members`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ player_id: playerId, member_role: role }),
        }),
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
          <Table ariaLabel="Участники клана">
            <TableHead>
              <TableRow>
                <SortableTh
                  sortKey="name"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Участник"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <SortableTh
                  sortKey="role"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Роль"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <SortableTh
                  sortKey="priority"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Приоритет"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <SortableTh
                  sortKey="joined_at"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Вступил"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <SortableTh
                  sortKey="last_seen"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Был(а)"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <SortableTh
                  sortKey="online"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Наиграно (60 дн.)"
                  directionText={SORT_DIRECTION_TEXT}
                  align="right"
                />
                <Th align="right">Действия</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((member) => (
                <RosterRow
                  key={member.player_id}
                  member={member}
                  caps={caps}
                  busy={busyPlayerId === member.player_id}
                  locked={lockedPlayerIds.has(member.player_id)}
                  onChangeRole={changeRole}
                  onRemove={setPendingRemove}
                  onTransfer={setPendingTransfer}
                  onTogglePriority={togglePriority}
                />
              ))}
            </TableBody>
          </Table>
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
        busy={pendingRemove !== null && busyPlayerId === pendingRemove.player_id}
        onConfirm={() => void confirmRemove()}
      />

      <AlertDialog
        open={pendingTransfer !== null}
        onClose={() => setPendingTransfer(null)}
        title="Передать лидерство?"
        body={
          pendingTransfer
            ? `${pendingTransfer.canonical_name} станет главой клана, а вы — заместителем.`
            : ''
        }
        confirmLabel="Передать"
        cancelLabel="Отмена"
        tone="default"
        busy={pendingTransfer !== null && busyPlayerId === pendingTransfer.player_id}
        onConfirm={() => void confirmTransfer()}
      />
    </section>
  );
}

export function RosterRow({
  member,
  caps,
  busy,
  locked = false,
  onChangeRole,
  onRemove,
  onTransfer,
  onTogglePriority,
}: {
  member: RosterMember;
  caps: Capabilities;
  busy: boolean;
  /** True for `PRIORITY_LOCK_MS` after a successful toggle, to stop a rapid re-click racing the server's pool-limit check. */
  locked?: boolean;
  onChangeRole: (playerId: string, role: string) => void;
  onRemove: (member: RosterMember) => void;
  onTransfer: (member: RosterMember) => void;
  onTogglePriority: (member: RosterMember, enabled: boolean) => void;
}) {
  const isLeader = member.member_role === 'leader';
  const canEditThisRole = caps.canManageFull && !isLeader;
  const canRemoveThis =
    !isLeader && (caps.canManageFull || (caps.canRemoveMembers && member.member_role === 'member'));

  return (
    <TableRow interactive>
      <Td>
        <Link
          href={`/all-players/${member.player_id}`}
          className="text-accent no-underline hover:brightness-110"
        >
          {member.canonical_name}
        </Link>
      </Td>
      <Td>
        {canEditThisRole ? (
          <Select
            size="sm"
            aria-label={`Роль участника ${member.canonical_name}`}
            value={member.member_role}
            disabled={busy}
            onChange={(e) => onChangeRole(member.player_id, e.target.value)}
          >
            <option value="deputy">Зам</option>
            <option value="member">Участник</option>
          </Select>
        ) : isLeader ? (
          <Badge tone="warn">{memberRoleLabel(member.member_role)}</Badge>
        ) : (
          <span className="text-ink-2">{memberRoleLabel(member.member_role)}</span>
        )}
      </Td>
      <Td>
        {member.reserve_from_role ? (
          <span
            className="inline-flex items-center gap-1.5 text-ink-3"
            title="Приоритет из другого источника"
          >
            <input type="checkbox" checked disabled readOnly className="size-3.5 accent-ink-3" />
            <span className="text-xs">роль</span>
          </span>
        ) : caps.canTogglePriority ? (
          // Подпись скрыта визуально: колонка уже названа заголовком, но без
          // доступного имени флажок нем для скринридера.
          <Checkbox
            label={<span className="sr-only">Приоритет в очереди</span>}
            checked={member.has_priority}
            disabled={busy || locked}
            onChange={(e) => onTogglePriority(member, e.target.checked)}
            title={locked ? 'Подождите несколько секунд перед следующим изменением' : undefined}
          />
        ) : (
          <span className="text-ink-2">{member.has_priority ? 'да' : '—'}</span>
        )}
      </Td>
      <Td className="whitespace-nowrap text-ink-2">{formatMemberDate(member.joined_at)}</Td>
      <Td className="whitespace-nowrap text-ink-2">{formatMemberDate(member.last_seen_at)}</Td>
      <Td numeric className="text-ink-2">
        {formatOnlineDuration(member.online_60d_seconds)}
      </Td>
      <Td align="right">
        <div className="flex items-center justify-end gap-2">
          {caps.canManageFull && !isLeader ? (
            <Button size="sm" disabled={busy} onClick={() => onTransfer(member)}>
              Передать лидерство
            </Button>
          ) : null}
          {canRemoveThis ? (
            <IconButton
              size="sm"
              tone="destructive"
              icon={<TrashIcon />}
              label={`Удалить ${member.canonical_name} из клана`}
              disabled={busy}
              onClick={() => onRemove(member)}
            />
          ) : null}
        </div>
      </Td>
    </TableRow>
  );
}

function AddMemberModal({
  open,
  onClose,
  onAdd,
  allowDeputy,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (playerId: string, role: string) => void;
  allowDeputy: boolean;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [role, setRole] = useState('member');
  const addRoleId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = term.trim();
    if (trimmed.length < SEARCH_MIN_CHARS) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/players/search?q=${encodeURIComponent(trimmed)}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (res.ok) {
          const body = (await res.json()) as { items: SearchCandidate[] };
          setResults(body.items);
        }
      } catch {
        /* ignore */
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [term]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Добавить участника"
      closeLabel="Закрыть"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Отмена
        </Button>
      }
    >
      <div className="space-y-3">
        <SearchField
          value={term}
          onCommit={setTerm}
          label="Поиск игрока"
          placeholder="Ник, SteamID64 или EOS ID (мин. 3 символа)"
          clearLabel="Очистить поиск"
        />

        <div className="flex items-center gap-2 text-xs text-ink-2">
          <label htmlFor={addRoleId}>Роль при добавлении</label>
          <Select
            id={addRoleId}
            size="sm"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-auto"
          >
            <option value="member">Участник</option>
            {allowDeputy ? <option value="deputy">Зам</option> : null}
          </Select>
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {searching ? <Skeleton variant="block" count={2} label="Ищем игроков" /> : null}
          {!searching && term.trim().length >= SEARCH_MIN_CHARS && results.length === 0 ? (
            <EmptyState
              variant="filtered"
              title="Ничего не нашлось"
              description="Ни один игрок не подходит под запрос."
            />
          ) : null}
          {results.map((candidate) => {
            const alreadyInClan = candidate.clan_id !== null;
            return (
              <div
                key={candidate.id}
                className="flex items-center justify-between gap-2 rounded-ctl border border-line bg-raised px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-ink">{candidate.canonical_name}</div>
                  <div className="truncate text-xs text-ink-3">
                    {candidate.steam_id64 ?? candidate.eos_id ?? '—'}
                    {alreadyInClan ? (
                      <span className="ml-2 text-warn">
                        уже в клане{candidate.clan_name ? ` «${candidate.clan_name}»` : ''}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={alreadyInClan}
                  onClick={() => onAdd(candidate.id, role)}
                >
                  Добавить
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
