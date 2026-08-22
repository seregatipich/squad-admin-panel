'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  type AltCandidate,
  buildLinkPayload,
  formatRejectedMark,
  LINK_TYPE_LABELS_RU,
  PLAYER_LINK_TYPES,
  type PlayerLink,
  type PlayerLinkStatus,
  type PlayerLinkType,
  splitCandidates,
} from './alt-links';

const CONFIDENCE_BADGE_CLASSES: Record<AltCandidate['confidence'], string> = {
  high: 'bg-red-950/50 text-red-300 border border-red-900',
  medium: 'bg-amber-950/50 text-amber-300 border border-amber-900',
  low: 'bg-neutral-800 text-neutral-400 border border-neutral-700',
};

const CONFIDENCE_LABELS_RU: Record<AltCandidate['confidence'], string> = {
  high: 'высокая',
  medium: 'средняя',
  low: 'низкая',
};

interface DecisionModalState {
  candidate: AltCandidate;
  status: PlayerLinkStatus;
}

/**
 * "Возможные альты и связи" player-card section (ALT-2, issue #120): shows
 * durable admin verdicts on top (`player_links`, via GET .../links) and the
 * ALT-1 candidate engine below it, with «Подтвердить связь»/«Отклонить»
 * actions that write those verdicts. Rejected candidates are collapsed and
 * marked rather than hidden (AC: still visible in the full ALT-1 output).
 * Hidden entirely without `player:view_ips` (401/403), matching the other
 * IP-gated player-card sections.
 */
export function AltLinksSection({ playerId }: { playerId: string }) {
  const [links, setLinks] = useState<PlayerLink[] | null>(null);
  const [candidates, setCandidates] = useState<AltCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<DecisionModalState | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setHidden(false);
    setError(null);
    try {
      const [linksRes, candidatesRes] = await Promise.all([
        fetch(`/api/v1/players/${playerId}/links`, { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/v1/players/${playerId}/alt-candidates`, {
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
      const linksBody = (await linksRes.json()) as { links: PlayerLink[] };
      const candidatesBody = (await candidatesRes.json()) as { candidates: AltCandidate[] };
      setLinks(linksBody.links);
      setCandidates(candidatesBody.candidates);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [playerId]);

  useEffect(() => {
    load();
  }, [load]);

  if (hidden) return null;

  const confirmedLinks = (links ?? []).filter((link) => link.status === 'confirmed');
  const { unresolved, rejected } = splitCandidates(candidates ?? []);
  const undecided = unresolved.filter((candidate) => candidate.link === null);

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">
        Возможные альты и связи
      </h2>

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
              Подтверждённые связи{confirmedLinks.length > 0 ? ` (${confirmedLinks.length})` : ''}
            </h3>
            {confirmedLinks.length === 0 ? (
              <div className="text-sm text-neutral-500">Подтверждённых связей нет.</div>
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
                    <span className="font-medium">{link.other_player?.current_name ?? '—'}</span>
                    {link.note ? <span className="text-neutral-400">— {link.note}</span> : null}
                    <span className="ml-auto text-xs text-neutral-500">
                      {link.created_by ? `подтвердил ${link.created_by.name}, ` : ''}
                      {new Date(link.updated_at).toLocaleDateString('ru-RU')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500">
              Возможные альты{undecided.length > 0 ? ` (${undecided.length})` : ''}
            </h3>
            {undecided.length === 0 ? (
              <div className="text-sm text-neutral-500">Кандидатов не найдено.</div>
            ) : (
              <ul className="space-y-1.5">
                {undecided.map((candidate) => (
                  <li
                    key={candidate.player_id}
                    className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5 text-sm"
                  >
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${CONFIDENCE_BADGE_CLASSES[candidate.confidence]}`}
                    >
                      {CONFIDENCE_LABELS_RU[candidate.confidence]} ({candidate.score})
                    </span>
                    <span className="font-medium">{candidate.current_name ?? '—'}</span>
                    <span className="text-xs text-neutral-500">
                      Общих IP: {candidate.shared_ip_count}
                    </span>
                    <div className="ml-auto flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setModal({ candidate, status: 'confirmed' })}
                        className="rounded border border-emerald-900 px-2 py-1 text-xs text-emerald-300 hover:border-emerald-700"
                      >
                        Подтвердить связь
                      </button>
                      <button
                        type="button"
                        onClick={() => setModal({ candidate, status: 'rejected' })}
                        className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:border-red-700"
                      >
                        Отклонить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {rejected.length > 0 ? (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowRejected((v) => !v)}
                  className="text-xs text-neutral-500 hover:text-neutral-300"
                >
                  {showRejected ? 'Скрыть' : 'Показать'} отклонённые ({rejected.length})
                </button>
                {showRejected ? (
                  <ul className="mt-1.5 space-y-1.5">
                    {rejected.map((candidate) => (
                      <li
                        key={candidate.player_id}
                        className="flex flex-wrap items-center gap-2 rounded border border-neutral-900 bg-neutral-900/20 px-2 py-1.5 text-sm text-neutral-500"
                      >
                        <span className="font-medium text-neutral-400">
                          {candidate.current_name ?? '—'}
                        </span>
                        {candidate.link ? (
                          <span className="text-xs">{formatRejectedMark(candidate.link)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}

      {modal ? (
        <DecisionModal
          playerId={playerId}
          state={modal}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

function DecisionModal({
  playerId,
  state,
  onClose,
  onDone,
}: {
  playerId: string;
  state: DecisionModalState;
  onClose: () => void;
  onDone: () => void;
}) {
  const [linkType, setLinkType] = useState<PlayerLinkType>(
    state.status === 'rejected' ? 'unrelated' : 'alt',
  );
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const linkTypeId = useId();
  const noteId = useId();

  const submit = useCallback(async () => {
    setSubmitting(true);
    setModalError(null);
    try {
      const payload = buildLinkPayload(
        state.candidate.player_id,
        linkType,
        state.status,
        note,
        state.candidate,
      );
      const res = await fetch(`/api/v1/players/${playerId}/links`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        setModalError('Связь уже существует.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDone();
    } catch (err) {
      setModalError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [playerId, linkType, note, state, onDone]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <div className="mt-16 w-full max-w-md rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {state.status === 'confirmed' ? 'Подтвердить связь' : 'Отклонить кандидата'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            Закрыть
          </button>
        </div>

        <p className="text-sm text-neutral-400">
          {state.candidate.current_name ?? state.candidate.player_id}
        </p>

        <div>
          <label htmlFor={linkTypeId} className="mb-1 block text-xs text-neutral-500">
            Тип связи
          </label>
          <select
            id={linkTypeId}
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as PlayerLinkType)}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          >
            {PLAYER_LINK_TYPES.map((type) => (
              <option key={type} value={type}>
                {LINK_TYPE_LABELS_RU[type]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={noteId} className="mb-1 block text-xs text-neutral-500">
            Заметка (необязательно)
          </label>
          <textarea
            id={noteId}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>

        {modalError ? <p className="text-xs text-red-400">{modalError}</p> : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className={`rounded border px-4 py-1.5 text-sm disabled:opacity-40 ${
              state.status === 'confirmed'
                ? 'border-emerald-900 text-emerald-300 hover:border-emerald-700'
                : 'border-red-900 text-red-300 hover:border-red-700'
            }`}
          >
            {state.status === 'confirmed' ? 'Подтвердить' : 'Отклонить'}
          </button>
        </div>
      </div>
    </div>
  );
}
