'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  SafeExternalLink,
  Skeleton,
} from '@/components/ui';
import { formatDateTimeRu } from '@/lib/format';
import { moderationActionLabel, moderationActionTone } from '@/lib/moderation-actions';
import {
  authorLabel,
  canDetachEvidence,
  detachEvidenceUrl,
  evidenceLabel,
  MODERATION_HISTORY_PAGE_SIZE,
  type ModerationEvidence,
  type ModerationHistoryAction,
  mediaStreamUrl,
  moderationActionsUrl,
} from './moderation-history';

interface ModerationHistoryResponse {
  actions: ModerationHistoryAction[];
}

interface DetachTarget {
  actionId: string;
  mediaId: string;
  label: string;
}

function EvidenceBody({ item }: { item: ModerationEvidence }) {
  if (item.kind === 'external_link') {
    if (!item.external_url) return null;
    return (
      <SafeExternalLink href={item.external_url} className="mt-2 block break-all text-accent" />
    );
  }
  if (item.kind === 'image') {
    return (
      <img
        src={mediaStreamUrl(item.id)}
        alt={evidenceLabel(item)}
        className="mt-2 max-h-64 w-full rounded-ctl object-contain"
      />
    );
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: evidence clips have no authored captions
    <video controls src={mediaStreamUrl(item.id)} className="mt-2 max-h-64 w-full rounded-ctl" />
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
 * The ledger is paged by the API (#441): the first page is loaded on mount
 * and «Показать ещё» follows the cursor of the last row shown. The header count
 * carries a «+» while more rows exist, so a page is never passed off as the
 * whole history.
 *
 * «Открепить» is offered only on evidence the viewer linked themselves — see
 * `canDetachEvidence` for why the `can_manage_media` case cannot be gated
 * client-side today — and asks for confirmation first (#446). A successful
 * detach calls `onEvidenceDetached` so the page can refresh the «Доказательства»
 * section, which lists the same links. The section self-hides on `401`/`403`,
 * matching the other player-card sections.
 */
export function ModerationHistorySection({
  playerId,
  viewerPlayerId,
  onEvidenceDetached,
}: {
  playerId: string;
  viewerPlayerId: string | null;
  /** Called after an evidence link was detached on the server. */
  onEvidenceDetached?: () => void;
}) {
  const [actions, setActions] = useState<ModerationHistoryAction[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detachError, setDetachError] = useState<string | null>(null);
  const [detachTarget, setDetachTarget] = useState<DetachTarget | null>(null);
  const [detaching, setDetaching] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(moderationActionsUrl(playerId, null), {
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
        if (cancelled || !body) return;
        setActions(body.actions.slice(0, MODERATION_HISTORY_PAGE_SIZE));
        setHasMore(body.actions.length > MODERATION_HISTORY_PAGE_SIZE);
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

  useEffect(() => load(), [load]);

  async function loadMore() {
    const cursor = actions?.at(-1)?.id;
    if (!cursor) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const res = await fetch(moderationActionsUrl(playerId, cursor), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ModerationHistoryResponse;
      const page = body.actions.slice(0, MODERATION_HISTORY_PAGE_SIZE);
      setActions((current) => {
        const known = new Set((current ?? []).map((row) => row.id));
        return [...(current ?? []), ...page.filter((row) => !known.has(row.id))];
      });
      setHasMore(body.actions.length > MODERATION_HISTORY_PAGE_SIZE);
    } catch (err) {
      setLoadMoreError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function detach(target: DetachTarget) {
    const { actionId, mediaId } = target;
    setDetaching(true);
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
      onEvidenceDetached?.();
    } catch (err) {
      setDetachError((err as Error).message);
    } finally {
      setDetaching(false);
      setDetachTarget(null);
    }
  }

  if (hidden) return null;

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="История модерации"
        count={actions && actions.length > 0 ? `${actions.length}${hasMore ? '+' : ''}` : undefined}
      />
      <CardBody className="space-y-3">
        {detachError ? <InlineBanner tone="crit" title={detachError} /> : null}

        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить историю модерации"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading ? (
          <Skeleton variant="block" count={2} label="Загрузка истории модерации" />
        ) : !actions || actions.length === 0 ? (
          <EmptyState
            title="Действий модерации нет"
            description="К этому игроку панель ещё не применяла ни предупреждений, ни банов."
          />
        ) : (
          <ul className="space-y-2">
            {actions.map((action) => (
              <li key={action.id} className="rounded-ctl border border-line p-2 text-[13px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge size="sm" tone={moderationActionTone(action.action_type)}>
                      {moderationActionLabel(action.action_type)}
                    </Badge>
                    {action.reverted_at ? <Badge size="sm">отменено</Badge> : null}
                  </span>
                  <span className="text-xs text-ink-3">{formatDateTimeRu(action.created_at)}</span>
                </div>

                {action.reason ? <p className="mt-1 text-ink-2">{action.reason}</p> : null}

                <div className="mt-1 text-xs text-ink-3">
                  {authorLabel(action.author)}
                  {action.server ? ` · ${action.server.name ?? action.server.id}` : ''}
                </div>

                {action.evidence.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {action.evidence.map((item) => (
                      <li key={item.id} className="rounded-ctl border border-line p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-ink-2">{evidenceLabel(item)}</span>
                          {canDetachEvidence(item.linked_by_player_id, viewerPlayerId) ? (
                            <Button
                              size="sm"
                              onClick={() =>
                                setDetachTarget({
                                  actionId: action.id,
                                  mediaId: item.id,
                                  label: evidenceLabel(item),
                                })
                              }
                            >
                              Открепить
                            </Button>
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

        {actions && hasMore && !error ? (
          <div className="space-y-2">
            {loadMoreError ? (
              <InlineBanner
                tone="crit"
                title="Не удалось загрузить следующую страницу"
                description={loadMoreError}
              />
            ) : null}
            <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>
              Показать ещё
            </Button>
          </div>
        ) : null}
      </CardBody>

      <AlertDialog
        open={detachTarget !== null}
        onClose={() => setDetachTarget(null)}
        title="Открепить доказательство?"
        body={
          detachTarget
            ? `«${detachTarget.label}» больше не будет привязано к этому действию модерации. Сам файл останется в медиатеке.`
            : ''
        }
        confirmLabel="Открепить доказательство"
        cancelLabel="Отмена"
        tone="destructive"
        busy={detaching}
        onConfirm={() => (detachTarget ? detach(detachTarget) : undefined)}
      />
    </Card>
  );
}
