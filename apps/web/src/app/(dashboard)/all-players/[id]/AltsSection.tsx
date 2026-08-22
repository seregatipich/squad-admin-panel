'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import {
  type AltCandidate,
  formatRejectedMark,
  LINK_TYPE_LABELS_RU,
  type PlayerLink,
  splitCandidates,
} from './alt-links';
import { SteamFriendCheck, type SteamFriendCheckResult } from './SteamFriendCheck';

const CONFIDENCE_LABELS_RU: Record<AltCandidate['confidence'], string> = {
  high: 'высокая',
  medium: 'средняя',
  low: 'низкая',
};

/** Уверенность — состояние оценки, а не украшение: слово рядом с числом несёт тот же смысл (§5). */
const CONFIDENCE_TONE: Record<AltCandidate['confidence'], BadgeTone> = {
  high: 'crit',
  medium: 'warn',
  low: 'neutral',
};

interface CandidateResponse {
  candidates: AltCandidate[];
  total: number;
}

interface LinksResponse {
  links: PlayerLink[];
}

function formatElapsed(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded} с`;
  const minutes = Math.floor(rounded / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

/**
 * Lazy ALT-6 player-card section. It does not request IP-derived data until
 * the operator expands the section, and disappears when either protected
 * endpoint denies the viewer.
 */
export function AltsSection({ playerId }: { playerId: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<PlayerLink[]>([]);
  const [candidates, setCandidates] = useState<AltCandidate[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [savingCandidate, setSavingCandidate] = useState<string | null>(null);
  const [friendResults, setFriendResults] = useState<Record<string, SteamFriendCheckResult>>({});

  const load = useCallback(
    async (force = false) => {
      if ((loaded && !force) || loading) return;
      setLoading(true);
      setError(null);
      try {
        const [linksRes, candidatesRes] = await Promise.all([
          fetch(`/api/v1/players/${playerId}/links`, {
            credentials: 'include',
            cache: 'no-store',
          }),
          fetch(`/api/v1/players/${playerId}/alt-candidates?limit=100`, {
            credentials: 'include',
            cache: 'no-store',
          }),
        ]);
        if (
          linksRes.status === 401 ||
          linksRes.status === 403 ||
          candidatesRes.status === 401 ||
          candidatesRes.status === 403
        ) {
          setHidden(true);
          return;
        }
        if (!linksRes.ok) throw new Error(`HTTP ${linksRes.status}`);
        if (!candidatesRes.ok) throw new Error(`HTTP ${candidatesRes.status}`);
        const linksBody = (await linksRes.json()) as LinksResponse;
        const candidatesBody = (await candidatesRes.json()) as CandidateResponse;
        setLinks(linksBody.links);
        setCandidates(candidatesBody.candidates);
        setLoaded(true);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [loaded, loading, playerId],
  );

  const saveDecision = useCallback(
    async (candidate: AltCandidate, status: 'confirmed' | 'rejected') => {
      setSavingCandidate(candidate.player_id);
      setError(null);
      try {
        const response = await fetch(`/api/v1/players/${playerId}/links`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            other_player_id: candidate.player_id,
            link_type: status === 'confirmed' ? 'alt' : 'unrelated',
            status,
            evidence_snapshot: {
              score: candidate.score,
              confidence: candidate.confidence,
              shared_ip_count: candidate.shared_ip_count,
              signals: candidate.signals,
              steam_friend: friendResults[candidate.player_id] ?? null,
            },
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await load(true);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSavingCandidate(null);
      }
    },
    [friendResults, load, playerId],
  );

  if (hidden) return null;

  const confirmedLinks = links.filter((link) => link.status === 'confirmed');
  const { unresolved, rejected } = splitCandidates(candidates);
  const candidateRows = showAll ? [...unresolved, ...rejected] : unresolved.slice(0, 5);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) void load();
  }

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Возможные альты"
        actions={
          <Button size="sm" aria-expanded={open} onClick={toggleOpen}>
            {open ? 'Скрыть' : 'Показать'}
          </Button>
        }
      />

      {open ? (
        <CardBody className="space-y-6">
          {error ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить возможные альты"
              description={error}
              action={
                <Button size="sm" onClick={() => void load(true)}>
                  Повторить
                </Button>
              }
            />
          ) : loading ? (
            <SkeletonTable rows={4} cols={4} label="Загрузка возможных альтов" />
          ) : (
            <>
              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold text-ink">
                  Подтверждённые связи{confirmedLinks.length ? ` (${confirmedLinks.length})` : ''}
                </h3>
                {confirmedLinks.length === 0 ? (
                  <EmptyState
                    title="Подтверждённых связей нет"
                    description="Ни одна связь с другим аккаунтом ещё не подтверждена администратором."
                  />
                ) : (
                  <ul className="divide-y divide-line rounded-ctl border border-line">
                    {confirmedLinks.map((link) => (
                      <li key={link.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <Badge tone="good" size="sm">
                          {LINK_TYPE_LABELS_RU[link.link_type]}
                        </Badge>
                        {link.other_player ? (
                          <Link
                            href={`/all-players/${link.other_player.id}`}
                            className="font-medium text-accent no-underline hover:brightness-110"
                          >
                            {link.other_player.current_name}
                          </Link>
                        ) : (
                          <span className="font-medium text-ink-3">—</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold text-ink">
                  Топ кандидатов{unresolved.length ? ` (${unresolved.length})` : ''}
                </h3>
                {candidateRows.length === 0 ? (
                  <EmptyState
                    title="Кандидатов не найдено"
                    description="Ни один другой аккаунт не пересекается с этим по IP и времени входа."
                  />
                ) : (
                  <Table ariaLabel="Кандидаты в альты">
                    <TableHead sticky={false}>
                      <tr>
                        <Th>Кандидат</Th>
                        <Th>Уверенность</Th>
                        <Th align="right">Общих IP</Th>
                        <Th align="right">Разница во времени</Th>
                        <Th>Проверка Steam</Th>
                        <Th>Решение</Th>
                      </tr>
                    </TableHead>
                    <TableBody>
                      {candidateRows.map((candidate) => {
                        const isRejected = candidate.link?.status === 'rejected';
                        return (
                          <TableRow key={candidate.player_id}>
                            <Td>
                              <span className="inline-flex flex-wrap items-center gap-2">
                                <Link
                                  href={`/all-players/${candidate.player_id}`}
                                  className="font-medium text-accent no-underline hover:brightness-110"
                                >
                                  {candidate.current_name ?? '—'}
                                </Link>
                                {candidate.has_permanent_ban ? (
                                  <Badge tone="crit" size="sm">
                                    перманентный бан
                                  </Badge>
                                ) : null}
                              </span>
                            </Td>
                            <Td>
                              <Badge tone={CONFIDENCE_TONE[candidate.confidence]} size="sm">
                                {CONFIDENCE_LABELS_RU[candidate.confidence]} ({candidate.score})
                              </Badge>
                            </Td>
                            <Td numeric>{candidate.shared_ip_count}</Td>
                            <Td numeric>{formatElapsed(candidate.min_time_delta_seconds)}</Td>
                            <Td>
                              {isRejected ? (
                                <span className="text-ink-3">—</span>
                              ) : (
                                <SteamFriendCheck
                                  playerId={playerId}
                                  otherPlayerId={candidate.player_id}
                                  onResult={(result) =>
                                    setFriendResults((current) => ({
                                      ...current,
                                      [candidate.player_id]: result,
                                    }))
                                  }
                                />
                              )}
                            </Td>
                            <Td>
                              {isRejected ? (
                                <span className="text-xs text-ink-3">
                                  {candidate.link
                                    ? formatRejectedMark(candidate.link)
                                    : 'Отклонено'}
                                </span>
                              ) : showAll ? (
                                <span className="flex gap-1.5">
                                  <Button
                                    size="sm"
                                    disabled={savingCandidate !== null}
                                    onClick={() => void saveDecision(candidate, 'confirmed')}
                                  >
                                    Подтвердить
                                  </Button>
                                  <Button
                                    size="sm"
                                    disabled={savingCandidate !== null}
                                    onClick={() => void saveDecision(candidate, 'rejected')}
                                  >
                                    Отклонить
                                  </Button>
                                </span>
                              ) : null}
                            </Td>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                {candidates.length > 0 ? (
                  <Button variant="plain" size="sm" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? 'Свернуть список' : 'Все кандидаты'}
                  </Button>
                ) : null}
              </section>
            </>
          )}
        </CardBody>
      ) : null}
    </Card>
  );
}
