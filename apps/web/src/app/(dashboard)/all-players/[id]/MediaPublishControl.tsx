'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, InlineBanner, SafeExternalLink } from '@/components/ui';
import { apiFetch, apiResult, describeHttpError } from '@/lib/api';
import {
  destinationLabel,
  destinationsForKind,
  hasPendingPublication,
  isPublishable,
  type MediaPublication,
  type MediaPublicationDestination,
  occupiedDestinations,
  PUBLICATION_POLL_INTERVAL_MS,
  PUBLICATION_POLL_LIMIT,
  publicationErrorLabel,
  publicationsUrl,
  publicationUrl,
  statusLabel,
} from './media-publications';

interface PublicationListResponse {
  items: MediaPublication[];
}

/**
 * "Опубликовать" control on a media card (VIDEO-4, #160): queues the file for
 * fan-out to YouTube/Telegram and shows the state of each destination.
 *
 * The publications and the viewer's `can_manage_media` flag come from the
 * evidence listing (`GET /api/v1/players/:id/media`), so a card with many
 * files costs one request, not one per file (#444). Only a `can_manage_media`
 * holder is offered «Опубликовать» (#440); everyone else still sees the status
 * of existing publications. A 403 on submit — the flag was revoked meanwhile —
 * names the missing right and withdraws the form.
 *
 * While a destination is queued or uploading, the control re-reads its own
 * publications every {@link PUBLICATION_POLL_INTERVAL_MS}, at most
 * {@link PUBLICATION_POLL_LIMIT} times per mount, so a finished upload shows
 * its «Открыть» link without a reload. External links render nothing at all —
 * there is no local file to upload.
 */
export function MediaPublishControl({
  mediaId,
  mediaKind,
  initialPublications,
  canManage,
}: {
  mediaId: string;
  mediaKind: 'video' | 'image' | 'external_link';
  /** This file's publications as embedded in the evidence listing. */
  initialPublications: MediaPublication[];
  /** The viewer's `can_manage_media` flag from the same listing. */
  canManage: boolean;
}) {
  const publishable = isPublishable(mediaKind);
  const kindDestinations = destinationsForKind(mediaKind);
  const [items, setItems] = useState<MediaPublication[]>(initialPublications);
  const [denied, setDenied] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<MediaPublicationDestination[]>([...kindDestinations]);
  const [removingDestination, setRemovingDestination] =
    useState<MediaPublicationDestination | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setItems(initialPublications);
    setPollCount(0);
  }, [initialPublications]);

  const pending = publishable && hasPendingPublication(items);

  const refresh = useCallback(async () => {
    try {
      const body = await apiFetch<PublicationListResponse>(publicationsUrl(mediaId));
      setItems(body.items);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(`Не удалось обновить статус публикаций: ${describeHttpError(err)}`);
    }
  }, [mediaId]);

  // Each settled read bumps `pollCount`, which re-arms the timer while the
  // job is still pending; the budget caps how long an open tab keeps asking.
  useEffect(() => {
    if (!pending || pollCount >= PUBLICATION_POLL_LIMIT) return;
    const timer = setTimeout(() => {
      void refresh().finally(() => setPollCount((count) => count + 1));
    }, PUBLICATION_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [pending, pollCount, refresh]);

  const occupied = occupiedDestinations(items);
  const available = kindDestinations.filter((destination) => !occupied.has(destination));
  const chosen = selected.filter((destination) => available.includes(destination));
  const mayPublish = canManage && !denied;

  const removePublication = useCallback(
    async (destination: MediaPublicationDestination) => {
      setRemovingDestination(destination);
      try {
        const res = await apiResult<void>(publicationUrl(mediaId, destination), {
          method: 'DELETE',
          discardBody: true,
        });
        if (!res.ok) {
          if (res.error.status === 401 || res.error.status === 403) {
            setDenied(true);
            return;
          }
          setSubmitError('Не удалось убрать публикацию. Попробуйте ещё раз.');
          return;
        }
        await refresh();
      } catch {
        setSubmitError('Не удалось убрать публикацию. Попробуйте ещё раз.');
      } finally {
        setRemovingDestination(null);
      }
    },
    [mediaId, refresh],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await apiResult<PublicationListResponse>(publicationsUrl(mediaId), {
        method: 'POST',
        json: { destinations: chosen },
      });
      if (!res.ok) {
        if (res.error.status === 401 || res.error.status === 403) {
          setDenied(true);
          setPicking(false);
          return;
        }
        setSubmitError('Не удалось поставить в очередь. Попробуйте ещё раз.');
        return;
      }
      const body = res.data;
      setItems((previous) => [...previous, ...body.items]);
      setPollCount(0);
      setPicking(false);
    } catch {
      setSubmitError('Не удалось поставить в очередь. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  }, [chosen, mediaId]);

  if (!publishable) return null;
  if (!mayPublish && !denied && items.length === 0) return null;

  return (
    <div className="mt-2 space-y-2 border-t border-line pt-2">
      {refreshError && <InlineBanner tone="warn" title={refreshError} />}
      {denied && (
        <InlineBanner
          tone="crit"
          title="Недостаточно прав для публикации: нужен can_manage_media."
        />
      )}

      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((publication) => {
            const reason = publicationErrorLabel(publication.error);
            return (
              <li key={publication.id} className="flex flex-wrap items-center gap-2 text-2xs">
                <span className="text-ink-2">{destinationLabel(publication.destination)}</span>
                <span className="text-ink-3">{statusLabel(publication)}</span>
                {publication.external_url && (
                  <SafeExternalLink href={publication.external_url} className="text-accent">
                    Открыть
                  </SafeExternalLink>
                )}
                {reason && <span className="text-ink-3">{reason}</span>}
                {mayPublish && publication.status === 'failed' && (
                  <Button
                    size="sm"
                    onClick={() => void removePublication(publication.destination)}
                    loading={removingDestination === publication.destination}
                  >
                    Убрать
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {mayPublish &&
        available.length > 0 &&
        (picking ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-3">
              {available.map((destination) => (
                <Checkbox
                  key={destination}
                  label={destinationLabel(destination)}
                  checked={chosen.includes(destination)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, destination]
                        : previous.filter((entry) => entry !== destination),
                    )
                  }
                />
              ))}
            </div>
            {submitError && <InlineBanner tone="crit" title={submitError} />}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => void submit()}
                disabled={submitting || chosen.length === 0}
              >
                Отправить
              </Button>
              <Button size="sm" onClick={() => setPicking(false)}>
                Отмена
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" onClick={() => setPicking(true)}>
            Опубликовать
          </Button>
        ))}
    </div>
  );
}
