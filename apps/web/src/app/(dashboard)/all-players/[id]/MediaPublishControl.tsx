'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, InlineBanner } from '@/components/ui';
import {
  destinationLabel,
  isPublishable,
  type MediaPublication,
  type MediaPublicationDestination,
  PUBLICATION_DESTINATIONS,
  publicationErrorLabel,
  publicationsUrl,
  statusLabel,
} from './media-publications';

interface PublicationListResponse {
  items: MediaPublication[];
}

/**
 * "Опубликовать" control on a media card (VIDEO-4, #160): queues the file for
 * fan-out to YouTube/Telegram and shows the state of each destination.
 *
 * `can_manage_media` is not exposed by `GET /api/v1/me`, so this hides itself
 * on a 403 from the publications endpoint rather than checking a capability
 * flag up front. External links render nothing at all — there is no local file
 * to upload, and the API would reject the request with `not_a_stored_file`.
 */
export function MediaPublishControl({
  mediaId,
  mediaKind,
}: {
  mediaId: string;
  mediaKind: 'video' | 'image' | 'external_link';
}) {
  const publishable = isPublishable(mediaKind);
  const [items, setItems] = useState<MediaPublication[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<MediaPublicationDestination[]>([
    ...PUBLICATION_DESTINATIONS,
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(publicationsUrl(mediaId), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PublicationListResponse;
      setItems(body.items);
      setError(null);
    } catch (err) {
      setError(`Не удалось загрузить статус публикаций: ${(err as Error).message}`);
    }
  }, [mediaId]);

  useEffect(() => {
    if (!publishable) return;
    void load();
  }, [load, publishable]);

  const queued = new Set((items ?? []).map((item) => item.destination));
  const available = PUBLICATION_DESTINATIONS.filter((destination) => !queued.has(destination));
  const chosen = selected.filter((destination) => available.includes(destination));

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(publicationsUrl(mediaId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinations: chosen }),
      });
      if (!res.ok) {
        setSubmitError('Не удалось поставить в очередь. Попробуйте ещё раз.');
        return;
      }
      setPicking(false);
      await load();
    } catch {
      setSubmitError('Не удалось поставить в очередь. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  }, [chosen, load, mediaId]);

  if (!publishable || hidden) return null;

  return (
    <div className="mt-2 space-y-2 border-t border-line pt-2">
      {error && <InlineBanner tone="crit" title={error} />}

      {items && items.length > 0 && (
        <ul className="space-y-1">
          {items.map((publication) => {
            const reason = publicationErrorLabel(publication.error);
            return (
              <li key={publication.id} className="flex flex-wrap items-center gap-2 text-2xs">
                <span className="text-ink-2">{destinationLabel(publication.destination)}</span>
                <span className="text-ink-3">{statusLabel(publication)}</span>
                {publication.external_url && (
                  <a
                    href={publication.external_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent"
                  >
                    Открыть
                  </a>
                )}
                {reason && <span className="text-ink-3">{reason}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {available.length > 0 &&
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
