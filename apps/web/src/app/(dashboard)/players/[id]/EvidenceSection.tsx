'use client';

import { useEffect, useState } from 'react';

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
}

interface EvidenceItem {
  link: EvidenceLink;
  media: EvidenceMedia;
}

interface EvidenceListResponse {
  items: EvidenceItem[];
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
 */
export function EvidenceSection({ playerId }: { playerId: string }) {
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(`/api/v1/players/${playerId}/media`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as EvidenceListResponse;
      })
      .then((body) => {
        if (!cancelled && body) {
          setItems(body.items);
        }
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

  if (hidden) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">
        Доказательства{items && items.length > 0 ? ` (${items.length})` : ''}
      </h2>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : !items || items.length === 0 ? (
        <div className="text-sm text-neutral-500">Доказательств нет.</div>
      ) : (
        <ul className="space-y-3">
          {items.map(({ link, media }) => (
            <li
              key={link.id}
              className="rounded border border-neutral-900 bg-neutral-900/40 p-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-neutral-300">{evidenceLabel(media)}</span>
                <span className="text-xs text-neutral-500">
                  {new Date(link.created_at).toLocaleString()}
                </span>
              </div>
              {media.kind === 'external_link' ? (
                media.external_url && (
                  <a
                    href={media.external_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block text-sky-400 no-underline hover:text-sky-300"
                  >
                    {media.external_url}
                  </a>
                )
              ) : media.kind === 'image' ? (
                <img
                  src={`/api/v1/media/${media.id}/stream`}
                  alt={evidenceLabel(media)}
                  className="mt-2 max-h-64 w-full rounded object-contain"
                />
              ) : (
                // biome-ignore lint/a11y/useMediaCaption: evidence clips have no authored captions
                <video
                  controls
                  src={`/api/v1/media/${media.id}/stream`}
                  className="mt-2 max-h-64 w-full rounded"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
