'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

interface ClanMember {
  player_id: string;
  canonical_name: string;
  member_role: string;
  has_priority: boolean;
}

interface ClanDetail {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
  members: ClanMember[];
}

interface OnlineMember {
  player_id: string;
  name: string;
  team: string | null;
  squad: string | null;
  session_started_at: string;
}

interface OnlineServer {
  server_id: string;
  server_name: string;
  server_slug: string;
  members: OnlineMember[];
}

interface OnlineResponse {
  clan_id: string;
  servers: OnlineServer[];
}

interface MatchParticipant {
  player_id: string;
  name: string;
  member_role: string;
}

interface ClanMatch {
  id: string;
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  layer: string | null;
  map: string | null;
  team1_faction: string | null;
  team2_faction: string | null;
  team1_tickets: number | null;
  team2_tickets: number | null;
  winner: 'team1' | 'team2' | 'draw' | null;
  is_seed: boolean;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  clan_participants_count: number;
  participants: MatchParticipant[];
}

interface ClanMatchesResponse {
  clan_id: string;
  items: ClanMatch[];
  next_cursor: string | null;
  limit: number;
}

const ONLINE_POLL_MS = 8000;
const MATCHES_PAGE_LIMIT = 20;
const ROLE_LABELS: Record<string, string> = {
  leader: 'Глава',
  deputy: 'Зам',
  member: 'Участник',
};

function formatMatchDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${secs}с`;
  return `${secs}с`;
}

function formatMatchStart(iso: string): string {
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

const TICKET_TONE = {
  winner: 'text-emerald-400 font-semibold',
  loser: 'text-red-400',
  neutral: 'text-neutral-300',
} as const;

function ticketTone(
  team: 'team1' | 'team2',
  winner: ClanMatch['winner'],
): keyof typeof TICKET_TONE {
  if (winner === null || winner === 'draw') return 'neutral';
  return winner === team ? 'winner' : 'loser';
}

function winnerLabel(match: Pick<ClanMatch, 'winner' | 'ended_at'>): string {
  if (match.ended_at === null) return 'В процессе';
  if (match.winner === 'team1') return 'Команда 1';
  if (match.winner === 'team2') return 'Команда 2';
  if (match.winner === 'draw') return 'Ничья';
  return '—';
}

function formatSessionDuration(startedAt: string, nowMs: number): string {
  const startedMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedMs)) return '—';
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function ClanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: clanId } = use(params);
  const [clan, setClan] = useState<ClanDetail | null>(null);
  const [online, setOnline] = useState<OnlineResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [matchRows, setMatchRows] = useState<ClanMatch[]>([]);
  const [matchCursor, setMatchCursor] = useState<string | null>(null);
  const [matchServerFilter, setMatchServerFilter] = useState<string>('');
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesLoaded, setMatchesLoaded] = useState(false);
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);
  const [serverOptions, setServerOptions] = useState<Array<{ id: string; name: string }>>([]);

  const loadClan = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/clans/${clanId}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 404) {
        setErr('Клан не найден.');
        return;
      }
      if (!res.ok) throw new Error(`Не удалось загрузить клан (${res.status})`);
      setClan((await res.json()) as ClanDetail);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [clanId]);

  const loadOnline = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/clans/${clanId}/online`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) return;
      setOnline((await res.json()) as OnlineResponse);
      setLastUpdate(new Date());
    } catch {
      /* keep the previous snapshot on transient failures */
    }
  }, [clanId]);

  const loadMatches = useCallback(
    async (cursor: string | null, serverId: string, replace: boolean) => {
      setMatchesLoading(true);
      try {
        const query = new URLSearchParams({ limit: String(MATCHES_PAGE_LIMIT) });
        if (cursor) query.set('cursor', cursor);
        if (serverId) query.set('server_id', serverId);
        const res = await fetch(`/api/v1/clans/${clanId}/matches?${query.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const body = (await res.json()) as ClanMatchesResponse;
        setMatchRows((prev) => (replace ? body.items : [...prev, ...body.items]));
        setMatchCursor(body.next_cursor);
        setMatchesLoaded(true);
        setServerOptions((prev) => {
          const seen = new Map(prev.map((option) => [option.id, option]));
          for (const match of body.items) {
            if (!seen.has(match.server_id)) {
              seen.set(match.server_id, {
                id: match.server_id,
                name: match.server_name ?? match.server_slug ?? match.server_id,
              });
            }
          }
          return Array.from(seen.values());
        });
      } catch {
        /* keep the current match list on transient failures */
      } finally {
        setMatchesLoading(false);
      }
    },
    [clanId],
  );

  useEffect(() => {
    void loadClan();
  }, [loadClan]);

  useEffect(() => {
    void loadMatches(null, matchServerFilter, true);
  }, [loadMatches, matchServerFilter]);

  useEffect(() => {
    void loadOnline();
    const poll = setInterval(() => void loadOnline(), ONLINE_POLL_MS);
    return () => clearInterval(poll);
  }, [loadOnline]);

  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const onlineCount = online?.servers.reduce((sum, group) => sum + group.members.length, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/clans" className="text-sm text-sky-400 hover:text-sky-300">
            ← Кланы
          </Link>
          <h1 className="text-2xl font-semibold">{clan?.name ?? 'Клан'}</h1>
          <div className="flex flex-wrap gap-1">
            {clan?.tags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-300"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Онлайн</h2>
          <div className="text-xs text-neutral-500">участников онлайн: {onlineCount}</div>
        </div>

        {online && online.servers.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
            Ни один участник клана сейчас не в игре.
          </div>
        ) : null}

        <div className="space-y-4">
          {online?.servers.map((group) => (
            <div key={group.server_id} className="rounded border border-neutral-800">
              <div className="flex items-center justify-between border-b border-neutral-900 bg-neutral-950 px-3 py-2">
                <span className="font-medium">{group.server_name}</span>
                <span className="text-xs text-neutral-500">{group.members.length} онлайн</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-widest text-neutral-500">
                    <tr>
                      <th className="text-left p-2">Участник</th>
                      <th className="text-left p-2">Команда</th>
                      <th className="text-left p-2">Отряд</th>
                      <th className="text-left p-2">В сессии</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.members.map((member) => (
                      <tr key={member.player_id} className="border-t border-neutral-900">
                        <td className="p-2">
                          <Link
                            href={`/players/${member.player_id}`}
                            className="text-sky-400 hover:text-sky-300"
                          >
                            {member.name}
                          </Link>
                        </td>
                        <td className="p-2 text-neutral-400">{member.team ?? '—'}</td>
                        <td className="p-2 text-neutral-400">{member.squad ?? '—'}</td>
                        <td className="p-2 font-mono tabular-nums text-emerald-400">
                          {formatSessionDuration(member.session_started_at, nowMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Ростер</h2>
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2">Участник</th>
                <th className="text-left p-2">Роль</th>
                <th className="text-left p-2">Приоритет</th>
              </tr>
            </thead>
            <tbody>
              {clan?.members.map((member) => (
                <tr key={member.player_id} className="border-t border-neutral-900">
                  <td className="p-2">
                    <Link
                      href={`/players/${member.player_id}`}
                      className="text-sky-400 hover:text-sky-300"
                    >
                      {member.canonical_name}
                    </Link>
                  </td>
                  <td className="p-2 text-neutral-400">
                    {ROLE_LABELS[member.member_role] ?? member.member_role}
                  </td>
                  <td className="p-2 text-neutral-400">{member.has_priority ? 'да' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">История матчей</h2>
          {serverOptions.length > 1 ? (
            <label className="flex items-center gap-2 text-sm text-neutral-400">
              Сервер
              <select
                value={matchServerFilter}
                onChange={(event) => {
                  setExpandedMatchId(null);
                  setMatchServerFilter(event.target.value);
                }}
                className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-200"
              >
                <option value="">Все серверы</option>
                {serverOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {matchesLoaded && matchRows.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
            У клана пока нет матчей.
          </div>
        ) : null}

        {matchRows.length > 0 ? (
          <div className="overflow-x-auto rounded border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="text-left p-2">Начало</th>
                  <th className="text-left p-2">Карта</th>
                  <th className="text-left p-2">Сервер</th>
                  <th className="text-left p-2">Счёт</th>
                  <th className="text-left p-2">Победитель</th>
                  <th className="text-left p-2">Участники клана</th>
                  <th className="text-left p-2">Длительность</th>
                </tr>
              </thead>
              <tbody>
                {matchRows.map((match) => (
                  <MatchHistoryRow
                    key={match.id}
                    match={match}
                    isExpanded={expandedMatchId === match.id}
                    onToggle={() =>
                      setExpandedMatchId((current) => (current === match.id ? null : match.id))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {matchCursor ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void loadMatches(matchCursor, matchServerFilter, false)}
              disabled={matchesLoading}
              className="rounded border border-neutral-800 bg-neutral-900 px-4 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            >
              {matchesLoading ? 'Загрузка…' : 'Показать ещё'}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function MatchHistoryRow({
  match,
  isExpanded,
  onToggle,
}: {
  match: ClanMatch;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-t border-neutral-900">
        <td className="p-2 whitespace-nowrap text-neutral-400">
          {formatMatchStart(match.started_at)}
        </td>
        <td className="p-2">
          <div className="flex items-center gap-2">
            <span className="text-neutral-200">{match.map ?? match.layer ?? '—'}</span>
            {match.is_seed ? (
              <span className="rounded bg-amber-950 px-1.5 py-0.5 text-xs text-amber-300">
                seed
              </span>
            ) : null}
          </div>
        </td>
        <td className="p-2 text-neutral-400">{match.server_name ?? match.server_slug ?? '—'}</td>
        <td className="p-2 font-mono tabular-nums">
          <span className={TICKET_TONE[ticketTone('team1', match.winner)]}>
            {match.team1_tickets ?? '—'}
          </span>
          <span className="text-neutral-600"> : </span>
          <span className={TICKET_TONE[ticketTone('team2', match.winner)]}>
            {match.team2_tickets ?? '—'}
          </span>
        </td>
        <td className="p-2">
          <span
            className={
              match.winner && match.winner !== 'draw'
                ? 'text-emerald-400 font-medium'
                : 'text-neutral-400'
            }
          >
            {winnerLabel(match)}
          </span>
        </td>
        <td className="p-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex flex-wrap items-center gap-1"
            title="Показать участников"
          >
            {match.participants.slice(0, 4).map((participant) => (
              <span
                key={participant.player_id}
                className="rounded-full bg-sky-950 px-2 py-0.5 text-xs text-sky-300"
              >
                {participant.name}
              </span>
            ))}
            {match.clan_participants_count > 4 ? (
              <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                +{match.clan_participants_count - 4}
              </span>
            ) : null}
          </button>
        </td>
        <td className="p-2 whitespace-nowrap text-neutral-400">
          <div className="flex items-center gap-2">
            <span>{formatMatchDuration(match.duration_seconds)}</span>
            <Link href={`/matches/${match.id}`} className="text-sky-400 hover:text-sky-300">
              →
            </Link>
          </div>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="border-t border-neutral-900 bg-neutral-950/60">
          <td colSpan={7} className="p-3">
            <div className="text-xs uppercase tracking-widest text-neutral-500">
              Участники клана в матче ({match.clan_participants_count})
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {match.participants.map((participant) => (
                <Link
                  key={participant.player_id}
                  href={`/players/${participant.player_id}`}
                  className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-sky-300 hover:bg-neutral-800"
                >
                  {participant.name}
                  <span className="ml-1 text-neutral-500">
                    {ROLE_LABELS[participant.member_role] ?? participant.member_role}
                  </span>
                </Link>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
