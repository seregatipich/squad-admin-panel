'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, InlineBanner, Skeleton } from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { apiResult, describeHttpError } from '@/lib/api';
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
  permissions: string[];
}

/** An unlink call in flight: which endpoint, so a failure banner can retry it. */
interface UnlinkAttempt {
  url: string;
  isForce: boolean;
}

/**
 * "Discord" block on the player card (DISCORD-4, #151). Follows the card's
 * section contract: it fetches its own data and renders nothing at all when
 * the API answers 401/403, so the whole block self-hides for viewers without
 * `player:view`.
 *
 * The forced-unlink button is gated by `me.permissions` (`user:manage_roles`,
 * granted only when the viewer's role can assign roles — see
 * `PANEL_PERMS_GATED_BY_ASSIGN` in `apps/api/src/lib/rbac.ts`), the same
 * permission `BonusSection` uses for its own manage/assign gates. A stale
 * `forceForbidden` fallback still hides the button on a live 403, in case the
 * viewer's permissions changed since `me` was loaded.
 */
export function DiscordLinkSection({ playerId, me }: { playerId: string; me: Viewer | null }) {
  const locale = useIntlLocale();
  const [data, setData] = useState<DiscordLinkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    message: string;
    attempt: UnlinkAttempt;
  } | null>(null);
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
    apiResult<unknown>(buildDiscordLinkUrl(playerId))
      .then((res) => {
        if (res.ok) return res.data;
        if (res.error.status === 401 || res.error.status === 403) {
          setHidden(true);
          return null;
        }
        throw res.error;
      })
      .then((body) => {
        if (cancelled || !body) return;
        const parsed = parseDiscordLink(body);
        if (!parsed) throw new Error('invalid response shape');
        setData(parsed);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeHttpError(err));
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
  const canForceUnlink = me !== null && !isSelf && me.permissions.includes('user:manage_roles');

  async function unlink(attempt: UnlinkAttempt): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const res = await apiResult<void>(attempt.url, { method: 'DELETE', discardBody: true });
      if (!res.ok) {
        if (res.error.status === 403) {
          if (attempt.isForce) {
            setForceForbidden(true);
            return;
          }
          setActionError({ message: 'Недостаточно прав для отвязки.', attempt });
          return;
        }
        // The link was already removed elsewhere (another tab, another
        // operator): re-sync instead of showing an error for a stale state.
        if (res.error.status === 404) {
          load();
          return;
        }
        throw res.error;
      }
      setData({
        linked: false,
        discord_user_id: null,
        discord_username: null,
        linked_at: null,
      });
    } catch (err) {
      setActionError({ message: describeHttpError(err), attempt });
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

        {actionError ? (
          <InlineBanner
            tone="crit"
            title={`Не удалось отвязать Discord: ${actionError.message}`}
            action={
              <Button size="sm" onClick={() => void unlink(actionError.attempt)}>
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
              <div className="text-xs text-ink-3">
                Привязан {formatLinkedAt(data.linked_at, locale)}
              </div>
            </div>
            {isSelf ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void unlink({ url: SELF_UNLINK_URL, isForce: false })}
              >
                Отвязать
              </Button>
            ) : null}
            {canForceUnlink && !forceForbidden ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void unlink({ url: buildForceUnlinkUrl(playerId), isForce: true })}
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
