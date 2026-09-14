'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import type { BadgeTone as PriorityTone } from '../helpers';
import { priorityBadge } from '../helpers';
import ClanSettingsPanel from './ClanSettingsPanel';
import ClanStatsPanel from './ClanStatsPanel';
import RosterPanel from './RosterPanel';
import TagProtectionCard from './TagProtectionCard';

interface ClanDetail {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
  is_tag_protected: boolean;
  is_public: boolean;
  max_priority_slots: number;
  priority_count: number;
  priority_expires_at: string | null;
  primary_server_id: string | null;
}

interface ServerOption {
  id: string;
  display_name: string;
}

interface MeResponse {
  can_manage_clans: boolean;
}

/** Тон срока приоритета из `helpers.ts` в тонах дизайн-системы. */
const PRIORITY_TONE: Record<PriorityTone, BadgeTone> = {
  neutral: 'neutral',
  danger: 'crit',
  warning: 'warn',
};

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

/**
 * Победа и поражение подкрашиваются, но никогда не остаются одним лишь цветом:
 * рядом стоит колонка «Победитель», которая называет исход словом (§5).
 */
const TICKET_TONE = {
  winner: 'font-semibold text-good',
  loser: 'text-crit',
  neutral: 'text-ink-2',
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [matchRows, setMatchRows] = useState<ClanMatch[]>([]);
  const [matchCursor, setMatchCursor] = useState<string | null>(null);
  const [matchServerFilter, setMatchServerFilter] = useState<string>('');
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesLoaded, setMatchesLoaded] = useState(false);
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);
  const [serverOptions, setServerOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [allServers, setAllServers] = useState<ServerOption[]>([]);
  const [canManageClans, setCanManageClans] = useState(false);

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
    void (async () => {
      try {
        const res = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { items: ServerOption[] };
        setAllServers(body.items);
      } catch {
        /* server names are a display nicety only */
      }
    })();
    void (async () => {
      try {
        const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as MeResponse;
        setCanManageClans(body.can_manage_clans);
      } catch {
        /* leave the settings panel hidden on failure */
      }
    })();
  }, []);

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
  const expiryBadge = useMemo(
    () => (clan ? priorityBadge(clan.priority_expires_at) : null),
    [clan],
  );

  return (
    <PageContainer width="wide">
      <PageHeader
        title={clan?.name ?? 'Клан'}
        backHref="/clans"
        backLabel="Все кланы"
        meta={
          clan ? (
            <>
              {clan.tags.map((tag) => (
                <Badge key={tag} size="sm">
                  {tag}
                </Badge>
              ))}
              <Badge size="sm">
                Приоритет: {clan.priority_count} из {clan.max_priority_slots}
              </Badge>
              {expiryBadge ? (
                <Badge size="sm" tone={PRIORITY_TONE[expiryBadge.tone]}>
                  {expiryBadge.label}
                </Badge>
              ) : null}
              {clan.is_tag_protected ? (
                <Badge size="sm" tone="good">
                  Тег защищён
                </Badge>
              ) : null}
              {!clan.is_public ? <Badge size="sm">Скрытый</Badge> : null}
            </>
          ) : undefined
        }
      />

      {err ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить клан"
          description={err}
          action={
            <Button size="sm" onClick={() => void loadClan()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold text-ink">Онлайн</h2>
          <span className="text-xs tabular-nums text-ink-3">Участников онлайн: {onlineCount}</span>
        </div>

        {online === null ? (
          <Card padding="none">
            <div className="p-3">
              <Skeleton variant="row" count={3} label="Загружаем список онлайна" />
            </div>
          </Card>
        ) : online.servers.length === 0 ? (
          <Card padding="none">
            <EmptyState
              title="Никого нет в игре"
              description="Ни один участник клана сейчас не находится на серверах."
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {online.servers.map((group) => (
              <Card key={group.server_id} padding="none">
                <CardHeader
                  headingLevel={3}
                  title={group.server_name}
                  count={`${group.members.length} онлайн`}
                />
                <Table ariaLabel={`Участники клана на сервере ${group.server_name}`}>
                  <TableHead sticky={false}>
                    <TableRow>
                      <Th>Участник</Th>
                      <Th>Команда</Th>
                      <Th>Отряд</Th>
                      <Th align="right">В сессии</Th>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {group.members.map((member) => (
                      <TableRow key={member.player_id} interactive>
                        <Td>
                          <Link
                            href={`/all-players/${member.player_id}`}
                            className="text-accent no-underline hover:brightness-110"
                          >
                            {member.name}
                          </Link>
                        </Td>
                        <Td className="text-ink-2">{member.team ?? '—'}</Td>
                        <Td className="text-ink-2">{member.squad ?? '—'}</Td>
                        <Td numeric className="font-mono text-good">
                          {formatSessionDuration(member.session_started_at, nowMs)}
                        </Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            ))}
          </div>
        )}
      </section>

      <ClanStatsPanel clanId={clanId} />

      {clan ? <TagProtectionCard clanId={clanId} initialProtected={clan.is_tag_protected} /> : null}

      {clan && canManageClans ? (
        <ClanSettingsPanel
          clanId={clanId}
          initial={{
            name: clan.name,
            description: clan.description,
            tags: clan.tags,
            max_priority_slots: clan.max_priority_slots,
            primary_server_id: clan.primary_server_id,
            is_public: clan.is_public,
            priority_expires_at: clan.priority_expires_at,
          }}
          servers={allServers}
          onSaved={() => void loadClan()}
        />
      ) : null}

      <RosterPanel clanId={clanId} />

      <section className="space-y-3">
        <h2 className="text-[17px] font-semibold text-ink">История матчей</h2>

        {serverOptions.length > 1 ? (
          <Toolbar
            filters={
              <Select
                aria-label="Сервер матча"
                value={matchServerFilter}
                onChange={(event) => {
                  setExpandedMatchId(null);
                  setMatchServerFilter(event.target.value);
                }}
              >
                <option value="">Все серверы</option>
                {serverOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            }
          />
        ) : null}

        <Card padding="none">
          {!matchesLoaded ? (
            <div className="p-3">
              <Skeleton variant="row" count={5} label="Загружаем историю матчей" />
            </div>
          ) : matchRows.length === 0 ? (
            <EmptyState
              variant={matchServerFilter ? 'filtered' : 'initial'}
              title={matchServerFilter ? 'Ничего не нашлось' : 'У клана пока нет матчей'}
              description={
                matchServerFilter
                  ? 'На выбранном сервере участники клана ещё не играли.'
                  : 'Как только участники клана сыграют матч, он появится здесь.'
              }
              action={
                matchServerFilter ? (
                  <Button onClick={() => setMatchServerFilter('')}>Сбросить фильтр</Button>
                ) : null
              }
            />
          ) : (
            <>
              <Table ariaLabel="История матчей клана">
                <TableHead>
                  <TableRow>
                    <Th>Начало</Th>
                    <Th>Карта</Th>
                    <Th>Сервер</Th>
                    <Th>Счёт</Th>
                    <Th>Победитель</Th>
                    <Th>Участники клана</Th>
                    <Th align="right">Длительность</Th>
                  </TableRow>
                </TableHead>
                <TableBody>
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
                </TableBody>
              </Table>

              {matchCursor ? (
                <div className="flex justify-center border-t border-line p-3">
                  <Button
                    onClick={() => void loadMatches(matchCursor, matchServerFilter, false)}
                    loading={matchesLoading}
                  >
                    Показать ещё
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </section>
    </PageContainer>
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
  const mapLabel = match.map ?? match.layer ?? '—';
  return (
    <>
      <TableRow interactive>
        <Td className="whitespace-nowrap text-ink-2">{formatMatchStart(match.started_at)}</Td>
        <Td>
          <div className="flex items-center gap-2">
            <Link
              href={`/matches/${match.id}`}
              className="text-accent no-underline hover:brightness-110"
            >
              {mapLabel}
            </Link>
            {match.is_seed ? (
              <Badge size="sm" tone="warn">
                Сидинг
              </Badge>
            ) : null}
          </div>
        </Td>
        <Td className="text-ink-2">{match.server_name ?? match.server_slug ?? '—'}</Td>
        <Td numeric className="font-mono">
          <span className={TICKET_TONE[ticketTone('team1', match.winner)]}>
            {match.team1_tickets ?? '—'}
          </span>
          <span className="text-ink-3"> : </span>
          <span className={TICKET_TONE[ticketTone('team2', match.winner)]}>
            {match.team2_tickets ?? '—'}
          </span>
        </Td>
        <Td className={match.winner && match.winner !== 'draw' ? 'text-good' : 'text-ink-2'}>
          {winnerLabel(match)}
        </Td>
        <Td>
          <Button
            variant="plain"
            size="sm"
            aria-expanded={isExpanded}
            onClick={onToggle}
            title={`Участники клана в матче на карте ${mapLabel}`}
          >
            {match.participants
              .slice(0, 4)
              .map((participant) => participant.name)
              .join(', ')}
            {match.clan_participants_count > 4 ? ` +${match.clan_participants_count - 4}` : ''}
          </Button>
        </Td>
        <Td numeric className="whitespace-nowrap text-ink-2">
          {formatMatchDuration(match.duration_seconds)}
        </Td>
      </TableRow>
      {isExpanded ? (
        <TableRow>
          {/* Раскрытая строка занимает всю ширину: `Td` не принимает `colSpan`,
              а семь пустых ячеек скринридер прочитал бы как семь пустых ячеек. */}
          <td colSpan={7} className="bg-raised/40 px-3 py-3">
            <p className="text-xs text-ink-3">
              Участники клана в матче ({match.clan_participants_count})
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {match.participants.map((participant) => (
                <Link
                  key={participant.player_id}
                  href={`/all-players/${participant.player_id}`}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-xs text-accent no-underline hover:bg-line-2"
                >
                  {participant.name}
                  <span className="text-ink-3">
                    {ROLE_LABELS[participant.member_role] ?? participant.member_role}
                  </span>
                </Link>
              ))}
            </div>
          </td>
        </TableRow>
      ) : null}
    </>
  );
}
