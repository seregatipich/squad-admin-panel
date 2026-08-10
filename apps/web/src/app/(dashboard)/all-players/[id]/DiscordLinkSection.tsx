'use client';

import { useEffect, useState } from 'react';

import {
  buildDiscordLinkUrl,
  buildForceUnlinkUrl,
  DISCORD_OAUTH_LOGIN_URL,
  type DiscordLinkResponse,
  formatLinkedAt,
  parseDiscordLink,
  SELF_UNLINK_URL,
} from './discord-link';

interface Viewer {
  player_id: string;
}

/**
 * "Discord" block on the player card (DISCORD-4, #151). Follows the card's
 * section contract: it fetches its own data and renders nothing at all when
 * the API answers 401/403, so the whole block self-hides for viewers without
 * `player:view`.
 *
 * The forced-unlink button is gated the same way, at the response level:
 * `GET /api/v1/me` deliberately does not expose `can_assign_roles`, so the
 * button is rendered optimistically and removed the first time the API
 * answers 403.
 */
export function DiscordLinkSection({ playerId, me }: { playerId: string; me: Viewer | null }) {
  const [data, setData] = useState<DiscordLinkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forceForbidden, setForceForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    setForceForbidden(false);
    fetch(buildDiscordLinkUrl(playerId), { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      })
      .then((body) => {
        if (cancelled || !body) return;
        const parsed = parseDiscordLink(body);
        if (!parsed) throw new Error('invalid response shape');
        setData(parsed);
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

  const isSelf = me !== null && me.player_id === playerId;

  async function unlink(url: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
      if (res.status === 403) {
        setForceForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData({
        linked: false,
        discord_user_id: null,
        discord_username: null,
        linked_at: null,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Discord</h2>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки Discord-линковки: {error}
        </div>
      ) : null}

      {forceForbidden ? (
        <div className="rounded border border-amber-900 bg-amber-950 p-3 text-sm text-amber-200">
          Недостаточно прав для принудительной отвязки.
        </div>
      ) : null}

      {loading && !data ? <div className="text-sm text-neutral-500">Загрузка…</div> : null}

      {data?.linked ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-sm text-neutral-100">{data.discord_username}</div>
            <div className="text-xs text-neutral-500">
              Привязан {formatLinkedAt(data.linked_at)}
            </div>
          </div>
          {isSelf ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void unlink(SELF_UNLINK_URL)}
              className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40"
            >
              Отвязать
            </button>
          ) : null}
          {me !== null && !isSelf && !forceForbidden ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void unlink(buildForceUnlinkUrl(playerId))}
              className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40"
            >
              Отвязать принудительно
            </button>
          ) : null}
        </div>
      ) : null}

      {data && !data.linked ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-neutral-500">Discord не привязан.</div>
          {isSelf ? (
            <a
              href={DISCORD_OAUTH_LOGIN_URL}
              className="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500"
            >
              Привязать Discord
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
