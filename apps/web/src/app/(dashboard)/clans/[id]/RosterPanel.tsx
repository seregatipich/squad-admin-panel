'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

export function formatLastSeen(iso: string | null): string {
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

  const removeMember = useCallback(
    (member: RosterMember) => {
      if (!window.confirm(`Удалить ${member.canonical_name} из клана?`)) return;
      void mutate(member.player_id, () =>
        fetch(`/api/v1/clans/${clanId}/members/${member.player_id}`, {
          method: 'DELETE',
          credentials: 'include',
        }),
      );
    },
    [clanId, mutate],
  );

  const transferLeadership = useCallback(
    (member: RosterMember) => {
      if (!window.confirm(`Передать лидерство игроку ${member.canonical_name}?`)) return;
      void mutate(member.player_id, () =>
        fetch(`/api/v1/clans/${clanId}/transfer-leadership`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ player_id: member.player_id }),
        }),
      );
    },
    [clanId, mutate],
  );

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

  const total = roster?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-lg font-medium">Ростер</h2>
          {roster ? (
            <span className="text-sm text-neutral-400">
              Приоритет: {roster.priority_count} из {roster.max_priority_slots}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/v1/clans/${clanId}/roster/export?format=csv`}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Экспорт CSV
          </a>
          {caps.canAdd ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
            >
              Добавить участника
            </button>
          ) : null}
        </div>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
          placeholder="Поиск участника по нику / SteamID / EOS…"
          className="flex-1 min-w-[240px] rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          Сортировка
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortField)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-200"
          >
            <option value="role">Роль</option>
            <option value="name">Имя</option>
            <option value="priority">Приоритет</option>
            <option value="joined_at">Дата вступления</option>
            <option value="last_seen">Последний онлайн</option>
            <option value="online">Онлайн 60 дней</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
          className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-300 hover:bg-neutral-800"
          title="Направление сортировки"
        >
          {order === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      <div className="overflow-x-auto rounded border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
            <tr>
              <th className="text-left p-2">Участник</th>
              <th className="text-left p-2">Роль</th>
              <th className="text-left p-2">Приоритет</th>
              <th className="text-left p-2">Последний онлайн</th>
              <th className="text-left p-2">Онлайн (60 дн.)</th>
              <th className="text-right p-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <RosterRow
                key={member.player_id}
                member={member}
                caps={caps}
                busy={busyPlayerId === member.player_id}
                locked={lockedPlayerIds.has(member.player_id)}
                onChangeRole={changeRole}
                onRemove={removeMember}
                onTransfer={transferLeadership}
                onTogglePriority={togglePriority}
              />
            ))}
          </tbody>
        </table>
      </div>

      {members.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          {q.trim() ? 'Нет совпадений.' : 'В клане пока нет участников.'}
        </div>
      ) : null}

      {pageCount > 1 ? (
        <div className="flex items-center justify-center gap-3 text-sm text-neutral-400">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1 hover:bg-neutral-800 disabled:opacity-40"
          >
            Назад
          </button>
          <span>
            Стр. {page} из {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
            disabled={page >= pageCount}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1 hover:bg-neutral-800 disabled:opacity-40"
          >
            Вперёд
          </button>
        </div>
      ) : null}

      {addOpen ? (
        <AddMemberModal
          onClose={() => setAddOpen(false)}
          onAdd={addMember}
          allowDeputy={caps.canManageFull}
        />
      ) : null}
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
    <tr className="border-t border-neutral-900">
      <td className="p-2">
        <Link href={`/players/${member.player_id}`} className="text-sky-400 hover:text-sky-300">
          {member.canonical_name}
        </Link>
      </td>
      <td className="p-2">
        {canEditThisRole ? (
          <select
            value={member.member_role}
            disabled={busy}
            onChange={(e) => onChangeRole(member.player_id, e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-200 disabled:opacity-50"
          >
            <option value="deputy">Зам</option>
            <option value="member">Участник</option>
          </select>
        ) : (
          <span
            className={
              isLeader
                ? 'rounded bg-amber-950 px-2 py-0.5 text-xs text-amber-300'
                : 'text-neutral-400'
            }
          >
            {memberRoleLabel(member.member_role)}
          </span>
        )}
      </td>
      <td className="p-2">
        {member.reserve_from_role ? (
          <span
            className="inline-flex items-center gap-1.5 text-neutral-500"
            title="Приоритет из другого источника"
          >
            <input type="checkbox" checked disabled className="h-4 w-4 accent-neutral-600" />
            <span className="text-xs">роль</span>
          </span>
        ) : caps.canTogglePriority ? (
          <input
            type="checkbox"
            checked={member.has_priority}
            disabled={busy || locked}
            onChange={(e) => onTogglePriority(member, e.target.checked)}
            className="h-4 w-4 accent-sky-500 disabled:opacity-50"
            aria-label="Приоритет в очереди"
            title={locked ? 'Подождите несколько секунд перед следующим изменением' : undefined}
          />
        ) : (
          <span className="text-neutral-400">{member.has_priority ? 'да' : '—'}</span>
        )}
      </td>
      <td className="p-2 whitespace-nowrap text-neutral-400">
        {formatLastSeen(member.last_seen_at)}
      </td>
      <td className="p-2 tabular-nums text-neutral-300">
        {formatOnlineDuration(member.online_60d_seconds)}
      </td>
      <td className="p-2">
        <div className="flex items-center justify-end gap-2">
          {caps.canManageFull && !isLeader ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onTransfer(member)}
              className="rounded border border-amber-800 bg-amber-950/40 px-2 py-1 text-xs text-amber-300 hover:bg-amber-900/40 disabled:opacity-50"
            >
              Передать лидерство
            </button>
          ) : null}
          {canRemoveThis ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(member)}
              className="rounded border border-red-900 bg-red-950/40 px-2 py-1 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-50"
            >
              Удалить
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function AddMemberModal({
  onClose,
  onAdd,
  allowDeputy,
}: {
  onClose: () => void;
  onAdd: (playerId: string, role: string) => void;
  allowDeputy: boolean;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [role, setRole] = useState('member');
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg space-y-3 rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium">Добавить участника</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Ник, SteamID64 или EOS ID (мин. 3 символа)…"
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
        />

        <label className="flex items-center gap-2 text-sm text-neutral-400">
          Роль при добавлении
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
          >
            <option value="member">Участник</option>
            {allowDeputy ? <option value="deputy">Зам</option> : null}
          </select>
        </label>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {searching ? <div className="p-2 text-sm text-neutral-500">Поиск…</div> : null}
          {!searching && term.trim().length >= SEARCH_MIN_CHARS && results.length === 0 ? (
            <div className="p-2 text-sm text-neutral-500">Ничего не найдено.</div>
          ) : null}
          {results.map((candidate) => {
            const alreadyInClan = candidate.clan_id !== null;
            return (
              <div
                key={candidate.id}
                className="flex items-center justify-between gap-2 rounded border border-neutral-900 bg-neutral-900/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-neutral-200">
                    {candidate.canonical_name}
                  </div>
                  <div className="truncate text-xs text-neutral-500">
                    {candidate.steam_id64 ?? candidate.eos_id ?? '—'}
                    {alreadyInClan ? (
                      <span className="ml-2 text-amber-400">
                        уже в клане{candidate.clan_name ? ` «${candidate.clan_name}»` : ''}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={alreadyInClan}
                  onClick={() => onAdd(candidate.id, role)}
                  className="shrink-0 rounded bg-sky-700 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Добавить
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
