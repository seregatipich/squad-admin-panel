'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
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

const CONFIDENCE_BADGE_CLASSES: Record<AltCandidate['confidence'], string> = {
  high: 'border border-red-900 bg-red-950/50 text-red-300',
  medium: 'border border-amber-900 bg-amber-950/50 text-amber-300',
  low: 'border border-neutral-700 bg-neutral-800 text-neutral-400',
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

  return (
    <details
      className="rounded border border-neutral-800 bg-neutral-950 p-4"
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (nextOpen) void load();
      }}
    >
      <summary className="cursor-pointer list-none text-xs uppercase tracking-widest text-neutral-400">
        Возможные альты
      </summary>

      <div className="mt-4 space-y-4">
        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            Ошибка: {error}
          </div>
        ) : loading ? (
          <div className="text-sm text-neutral-500">Загрузка…</div>
        ) : (
          <>
            <div className="space-y-2">
              <h3 className="text-[11px] uppercase tracking-widest text-neutral-500">
                Подтверждённые связи{confirmedLinks.length ? ` (${confirmedLinks.length})` : ''}
              </h3>
              {confirmedLinks.length === 0 ? (
                <p className="text-sm text-neutral-500">Подтверждённых связей нет.</p>
              ) : (
                <ul className="space-y-1.5">
                  {confirmedLinks.map((link) => (
                    <li
                      key={link.id}
                      className="flex flex-wrap items-center gap-2 rounded border border-emerald-900/70 bg-emerald-950/30 px-2 py-1.5 text-sm"
                    >
                      <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">
                        {LINK_TYPE_LABELS_RU[link.link_type]}
                      </span>
                      {link.other_player ? (
                        <Link
                          href={`/players/${link.other_player.id}`}
                          className="font-medium text-sky-400 hover:text-sky-300"
                        >
                          {link.other_player.current_name}
                        </Link>
                      ) : (
                        <span className="font-medium">—</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-[11px] uppercase tracking-widest text-neutral-500">
                Топ кандидатов{unresolved.length ? ` (${unresolved.length})` : ''}
              </h3>
              {candidateRows.length === 0 ? (
                <p className="text-sm text-neutral-500">Кандидатов не найдено.</p>
              ) : (
                <ul className="space-y-1.5">
                  {candidateRows.map((candidate) => {
                    const isRejected = candidate.link?.status === 'rejected';
                    return (
                      <li
                        key={candidate.player_id}
                        className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-sm ${
                          isRejected
                            ? 'border-neutral-900 bg-neutral-900/20 text-neutral-500'
                            : 'border-neutral-800 bg-neutral-900/40'
                        }`}
                      >
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${CONFIDENCE_BADGE_CLASSES[candidate.confidence]}`}
                        >
                          {CONFIDENCE_LABELS_RU[candidate.confidence]} ({candidate.score})
                        </span>
                        <Link
                          href={`/players/${candidate.player_id}`}
                          className="font-medium text-sky-400 hover:text-sky-300"
                        >
                          {candidate.current_name ?? '—'}
                        </Link>
                        <span className="text-xs text-neutral-500">
                          Общих IP: {candidate.shared_ip_count}
                        </span>
                        <span className="text-xs text-neutral-500">
                          Δ: {formatElapsed(candidate.min_time_delta_seconds)}
                        </span>
                        {candidate.has_permanent_ban ? (
                          <span className="rounded border border-red-900 bg-red-950/50 px-1.5 py-0.5 text-[10px] uppercase text-red-300">
                            перманентный бан
                          </span>
                        ) : null}
                        {!isRejected ? (
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
                        ) : null}
                        {isRejected ? (
                          <span className="text-xs">
                            {candidate.link ? formatRejectedMark(candidate.link) : 'Отклонено'}
                          </span>
                        ) : showAll ? (
                          <div className="ml-auto flex gap-1.5">
                            <button
                              type="button"
                              disabled={savingCandidate !== null}
                              onClick={() => void saveDecision(candidate, 'confirmed')}
                              className="rounded border border-emerald-900 px-2 py-1 text-xs text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
                            >
                              Подтвердить
                            </button>
                            <button
                              type="button"
                              disabled={savingCandidate !== null}
                              onClick={() => void saveDecision(candidate, 'rejected')}
                              className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:border-red-700 disabled:opacity-40"
                            >
                              Отклонить
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {candidates.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                  className="text-xs text-sky-400 hover:text-sky-300"
                >
                  {showAll ? 'Свернуть список' : 'Все кандидаты →'}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
