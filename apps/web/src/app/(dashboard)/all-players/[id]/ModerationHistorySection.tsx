'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  Skeleton,
} from '@/components/ui';
import {
  authorLabel,
  canDetachEvidence,
  detachEvidenceUrl,
  evidenceLabel,
  formatModerationDate,
  type ModerationEvidence,
  type ModerationHistoryAction,
  mediaStreamUrl,
  moderationActionLabel,
} from './moderation-history';

interface ModerationHistoryResponse {
  actions: ModerationHistoryAction[];
}

/**
 * Тяжесть действия модерации. Подпись из {@link moderationActionLabel} всё
 * равно называет его словом, тон лишь помогает найти взглядом бан среди
 * предупреждений (§5).
 */
const ACTION_TONE: Record<string, BadgeTone> = {
  warn: 'warn',
  kick: 'warn',
  ban: 'crit',
  unban: 'good',
  name_kick: 'warn',
  external_ban_kick: 'warn',
  'external_ban.local_ban': 'crit',
  clan_tag_protection: 'accent',
};

function EvidenceBody({ item }: { item: ModerationEvidence }) {
  if (item.kind === 'external_link') {
    if (!item.external_url) return null;
    return (
      <a
        href={item.external_url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block break-all text-accent"
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

  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

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
    <Card padding="none" as="section">
      <CardHeader
        title="История модерации"
        count={actions && actions.length > 0 ? actions.length : undefined}
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
                    <Badge size="sm" tone={ACTION_TONE[action.action_type] ?? 'neutral'}>
                      {moderationActionLabel(action.action_type)}
                    </Badge>
                    {action.reverted_at ? <Badge size="sm">отменено</Badge> : null}
                  </span>
                  <span className="text-xs text-ink-3">
                    {formatModerationDate(action.created_at)}
                  </span>
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
                              onClick={() => void detach(action.id, item.id)}
                              loading={detaching === `${action.id}:${item.id}`}
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
      </CardBody>
    </Card>
  );
}
