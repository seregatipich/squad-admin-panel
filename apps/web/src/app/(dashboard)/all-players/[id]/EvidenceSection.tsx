'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DateTime,
  EmptyState,
  InlineBanner,
  SafeExternalLink,
  Skeleton,
  TextInput,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { apiFetch, apiResult, describeHttpError } from '@/lib/api';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { MediaPublishControl } from './MediaPublishControl';
import type { MediaPublication } from './media-publications';

interface EvidenceLink {
  id: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
}

interface EvidenceMedia {
  id: string;
  kind: 'video' | 'image' | 'external_link';
  original_filename: string;
  external_url: string | null;
  title: string | null;
  /** Non-null when the file arrived through a one-time link (VIDEO-3, #159). */
  upload_token_id: string | null;
}

interface EvidenceItem {
  link: EvidenceLink;
  media: EvidenceMedia;
  /** The file's publications, embedded so the card needs no per-file request (#444). */
  publications: MediaPublication[];
}

interface EvidenceListResponse {
  items: Array<Omit<EvidenceItem, 'publications'> & { publications?: MediaPublication[] }>;
  /** The viewer's `can_manage_media` flag, which gates «Опубликовать» (#440). */
  can_manage_media?: boolean;
}

/** One shared empty list, so a file without publications keeps a stable prop. */
const NO_PUBLICATIONS: MediaPublication[] = [];

interface MintedUploadLink {
  upload_url: string;
  expires_at: string;
}

function evidenceLabel(media: EvidenceMedia): string {
  return media.title ?? media.original_filename;
}

/**
 * "Доказательства" player-card section (VIDEO-2, #158): lists media evidence
 * attached to this player directly (`entity_type='player'`) or via a
 * moderation action taken against them, backed by the union endpoint
 * `GET /api/v1/players/:id/media`. Stored files (video or image) play/render
 * inline through the existing Range-streaming route
 * (`/api/v1/media/:id/stream`, VIDEO-1 #157); external links open in a new
 * tab. Hidden entirely for viewers without panel access, matching the other
 * player-card sections.
 *
 * VIDEO-3 (#159) adds the mint half of delegated upload: "Получить ссылку для
 * загрузки" issues a one-time, pre-bound link whose raw token the API returns
 * exactly once, so it is rendered once and never refetched. Files that arrived
 * through such a link are labelled as anonymous, and the `media.uploaded` live
 * event — which the API delivers only to the admin who minted the link —
 * refreshes the list in place.
 *
 * Each file's publications and the viewer's `can_manage_media` flag come with
 * the listing and are handed to {@link MediaPublishControl} (#440, #444).
 * `refreshKey` lets the page reload the list after a change made elsewhere on
 * the card — a detach in «История модерации» (#446).
 */
export function EvidenceSection({
  playerId,
  refreshKey = 0,
}: {
  playerId: string;
  /** Bump to reload the list; `0` (the default) never triggers a reload. */
  refreshKey?: number;
}) {
  const locale = useIntlLocale();
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const [canManageMedia, setCanManageMedia] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintedLink, setMintedLink] = useState<MintedUploadLink | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiResult<EvidenceListResponse>(
        `/api/v1/players/${encodeURIComponent(playerId)}/media`,
      );
      if (!res.ok) {
        if (res.error.status === 401 || res.error.status === 403) {
          setHidden(true);
          return;
        }
        throw res.error;
      }
      const body = res.data;
      setItems(
        body.items.map((item) => ({ ...item, publications: item.publications ?? NO_PUBLICATIONS })),
      );
      setCanManageMedia(body.can_manage_media ?? false);
      setError(null);
    } catch (err) {
      setError(describeHttpError(err));
    } finally {
      setLoading(false);
    }
  }, [playerId]);

  useEffect(() => {
    setLoading(true);
    setHidden(false);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (refreshKey > 0) void load();
  }, [refreshKey, load]);

  const onUploaded = useCallback(
    (event: Extract<LiveEvent, { type: 'media.uploaded' }>) => {
      // A link bound to a different player's card can't affect this list; a
      // moderation-action or untargeted upload might, so refetch for those.
      if (event.data.target_entity_type === 'player' && event.data.target_entity_id !== playerId) {
        return;
      }
      void load();
    },
    [load, playerId],
  );
  useLiveSubscription('media.uploaded', onUploaded);

  const mintUploadLink = useCallback(async () => {
    setMinting(true);
    setMintError(null);
    try {
      const body = await apiFetch<MintedUploadLink>('/api/v1/media/upload-tokens', {
        method: 'POST',
        json: { target_entity_type: 'player', target_entity_id: playerId },
      });
      setMintedLink(body);
    } catch {
      setMintError('Не удалось создать ссылку.');
    } finally {
      setMinting(false);
    }
  }, [playerId]);

  if (hidden) return null;

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Доказательства"
        count={items && items.length > 0 ? items.length : undefined}
        actions={
          <Button size="sm" loading={minting} onClick={() => void mintUploadLink()}>
            Получить ссылку для загрузки
          </Button>
        }
      />

      <CardBody className="space-y-3">
        {mintError ? <InlineBanner tone="crit" title={mintError} /> : null}

        {mintedLink ? (
          <InlineBanner
            tone="info"
            title="Одноразовая ссылка для загрузки"
            description={
              <div className="space-y-1">
                <TextInput
                  data-testid="upload-link-value"
                  readOnly
                  value={mintedLink.upload_url}
                  aria-label="Одноразовая ссылка для загрузки"
                  className="font-mono"
                />
                <p>
                  Ссылка показывается один раз, работает один раз и истекает{' '}
                  <DateTime value={mintedLink.expires_at} locale={locale} />.
                </p>
              </div>
            }
          />
        ) : null}

        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить доказательства"
            description={error}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        ) : loading ? (
          <Skeleton variant="block" count={2} label="Загрузка доказательств" />
        ) : !items || items.length === 0 ? (
          <EmptyState
            title="Доказательств нет."
            description="К этому игроку не приложено ни одной записи, скриншота или ссылки."
          />
        ) : (
          <ul className="space-y-3">
            {items.map(({ link, media, publications }) => (
              <li key={link.id} className="rounded-ctl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] text-ink">{evidenceLabel(media)}</span>
                  <DateTime
                    value={link.created_at}
                    locale={locale}
                    className="text-xs text-ink-3"
                  />
                </div>
                {media.upload_token_id ? (
                  <span className="mt-1 inline-block">
                    <Badge tone="warn" size="sm">
                      загружено по ссылке, аноним
                    </Badge>
                  </span>
                ) : null}
                {media.kind === 'external_link' ? (
                  media.external_url && (
                    <SafeExternalLink
                      href={media.external_url}
                      className="mt-2 block text-accent no-underline hover:brightness-110"
                    />
                  )
                ) : media.kind === 'image' ? (
                  // biome-ignore lint/performance/noImgElement: authenticated /api/v1/media stream, not optimizable by next/image
                  <img
                    src={`/api/v1/media/${media.id}/stream`}
                    alt={evidenceLabel(media)}
                    className="mt-2 max-h-64 w-full rounded-ctl object-contain"
                  />
                ) : (
                  // biome-ignore lint/a11y/useMediaCaption: evidence clips have no authored captions
                  <video
                    controls
                    src={`/api/v1/media/${media.id}/stream`}
                    className="mt-2 max-h-64 w-full rounded-ctl"
                  />
                )}
                <MediaPublishControl
                  mediaId={media.id}
                  mediaKind={media.kind}
                  initialPublications={publications}
                  canManage={canManageMedia}
                />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
