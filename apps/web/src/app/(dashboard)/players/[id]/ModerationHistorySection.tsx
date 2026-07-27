'use client';

import { useEffect, useState } from 'react';
import {
  authorLabel,
  canDetachEvidence,
  detachEvidenceUrl,
  evidenceLabel,
  formatModerationDate,
  type ModerationEvidence,
  type ModerationHistoryAction,
  mediaStreamUrl,
  moderationActionBadgeClass,
  moderationActionLabel,
} from './moderation-history';

interface ModerationHistoryResponse {
  actions: ModerationHistoryAction[];
}

function EvidenceBody({ item }: { item: ModerationEvidence }) {
  if (item.kind === 'external_link') {
    if (!item.external_url) return null;
    return (
      <a
        href={item.external_url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block break-all text-sky-400 no-underline hover:text-sky-300"
      >
        {item.external_url}
      </a>
    );
  }
  if (item.kind === 'image') {
    return (
      <img
        src={mediaStreamUrl(item.id)}
        alt={evidenceLabel(item)}
        className="mt-2 max-h-64 w-full rounded object-contain"
      />
    );
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: evidence clips have no authored captions
    <video controls src={mediaStreamUrl(item.id)} className="mt-2 max-h-64 w-full rounded" />
  );
}

/**
 * «История модерации» player-card section (MOD-3, #60): the per-player
 * `moderation_actions` ledger — action type, reason, author (panel user or
 * worker system label), server and time — with the media evidence attached to
 * each action rendered inline. Uploaded video and image files play/render
 * through the Range-streaming route (`/api/v1/media/:id/stream`, VIDEO-1 #157);
 * external links open in a new tab.
 *
 * «Открепить» is offered only on evidence the viewer linked themselves — see
 * `canDetachEvidence` for why the `can_manage_media` case cannot be gated
 * client-side today. The section self-hides on `401`/`403`, matching the other
 * player-card sections.
 */
export function ModerationHistorySection({
  playerId,
  viewerPlayerId,
}: {
  playerId: string;
  viewerPlayerId: string | null;
}) {
  const [actions, setActions] = useState<ModerationHistoryAction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detachError, setDetachError] = useState<string | null>(null);
  const [detaching, setDetaching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(`/api/v1/players/${playerId}/moderation-actions`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ModerationHistoryResponse;
      })
      .then((body) => {
        if (!cancelled && body) setActions(body.actions);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  async function detach(actionId: string, mediaId: string) {
    setDetaching(`${actionId}:${mediaId}`);
    setDetachError(null);
    try {
      const res = await fetch(detachEvidenceUrl(mediaId, actionId), {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.status === 403) {
        setDetachError('Недостаточно прав, чтобы открепить это доказательство.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setActions((current) =>
        current === null
          ? current
          : current.map((action) => {
              if (action.id !== actionId) return action;
              const evidence = action.evidence.filter((item) => item.id !== mediaId);
              return { ...action, evidence, evidence_count: evidence.length };
            }),
      );
    } catch (err) {
      setDetachError((err as Error).message);
    } finally {
      setDetaching(null);
    }
  }

  if (hidden) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">
        История модерации{actions && actions.length > 0 ? ` (${actions.length})` : ''}
      </h2>

      {detachError ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          {detachError}
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : !actions || actions.length === 0 ? (
        <div className="text-sm text-neutral-500">Действий модерации нет.</div>
      ) : (
        <ul className="space-y-2">
          {actions.map((action) => (
            <li
              key={action.id}
              className="rounded border border-neutral-900 bg-neutral-900/40 p-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${moderationActionBadgeClass(action.action_type)}`}
                  >
                    {moderationActionLabel(action.action_type)}
                  </span>
                  {action.reverted_at ? (
                    <span className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] uppercase text-neutral-400">
                      отменено
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-neutral-500">
                  {formatModerationDate(action.created_at)}
                </span>
              </div>

              {action.reason ? <p className="mt-1 text-neutral-300">{action.reason}</p> : null}

              <div className="mt-1 text-xs text-neutral-500">
                {authorLabel(action.author)}
                {action.server ? ` · ${action.server.name ?? action.server.id}` : ''}
              </div>

              {action.evidence.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {action.evidence.map((item) => (
                    <li key={item.id} className="rounded border border-neutral-800 p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-neutral-300">{evidenceLabel(item)}</span>
                        {canDetachEvidence(item.linked_by_player_id, viewerPlayerId) ? (
                          <button
                            type="button"
                            onClick={() => void detach(action.id, item.id)}
                            disabled={detaching === `${action.id}:${item.id}`}
                            className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                          >
                            Открепить
                          </button>
                        ) : null}
                      </div>
                      <EvidenceBody item={item} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
