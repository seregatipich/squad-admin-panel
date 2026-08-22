'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardBody, CardHeader, InlineBanner, Skeleton } from '@/components/ui';
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

  /**
   * Загрузка привязки. Возвращает отмену — та же функция служит и эффектом
   * монтирования, и обработчиком «Повторить», поэтому повторная попытка
   * повторяет ровно тот же запрос.
   */
  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

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
    <Card as="section" padding="none">
      <CardHeader title="Discord" />
      <CardBody className="space-y-3">
        {error ? (
          <InlineBanner
            tone="crit"
            title={`Ошибка загрузки Discord-линковки: ${error}`}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : null}

        {forceForbidden ? (
          <InlineBanner tone="warn" title="Недостаточно прав для принудительной отвязки." />
        ) : null}

        {loading && !data ? <Skeleton variant="text" count={2} label="Загрузка привязки" /> : null}

        {data?.linked ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-[13px] text-ink">{data.discord_username}</div>
              <div className="text-xs text-ink-3">Привязан {formatLinkedAt(data.linked_at)}</div>
            </div>
            {isSelf ? (
              <Button size="sm" disabled={busy} onClick={() => void unlink(SELF_UNLINK_URL)}>
                Отвязать
              </Button>
            ) : null}
            {me !== null && !isSelf && !forceForbidden ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void unlink(buildForceUnlinkUrl(playerId))}
              >
                Отвязать принудительно
              </Button>
            ) : null}
          </div>
        ) : null}

        {data && !data.linked ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] text-ink-3">Discord не привязан.</div>
            {isSelf ? (
              // Адрес обслуживает API, а не маршрут Next: `ButtonLink` увёл бы
              // переход в клиентскую навигацию, поэтому здесь обычный `<a>`
              // с классами того же размера, что у вторичной кнопки (§6).
              <a
                href={DISCORD_OAUTH_LOGIN_URL}
                className="inline-flex h-7 items-center justify-center rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2"
              >
                Привязать Discord
              </a>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
