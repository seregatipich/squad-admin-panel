'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  InlineBanner,
  Skeleton,
  StatusBadge,
} from '@/components/ui';
import {
  ExternalBanLocalBanModal,
  type ExternalBanLocalBanTarget,
} from './ExternalBanLocalBanModal';
import {
  type BanStatusLike,
  banStatusBadge,
  formatDate,
  foundBadgeLabel,
  type PlayerExternalBansResponse,
  trustLevelLabel,
} from './external-bans';

/** Доверие к источнику — категория, а не состояние системы: пилюля, а не цвет строки. */
const TRUST_TONE: Record<string, BadgeTone> = {
  trusted: 'good',
  normal: 'accent',
  low: 'warn',
};

/** Тон статуса бана. Смысл всё равно несёт подпись из {@link banStatusBadge} (§5). */
function banStatusTone(ban: BanStatusLike): BadgeTone {
  if (!ban.is_active) return 'neutral';
  return ban.is_permanent ? 'crit' : 'warn';
}

/**
 * "Внешние банлисты" player-card section (CBAN-3, #108): shows whether this
 * player is known to any external ban source, backed by
 * `GET /api/v1/players/:playerId/external-bans`. Collapsed by default with a
 * badge summarizing active sources; expands to a per-source breakdown with
 * trust-level and ban-status badges. Moderators with the Squad `ban`
 * permission can open CBAN-4's prefilled local-ban form for active records.
 * The section is hidden entirely for viewers without panel access, matching
 * the other player-card sections.
 */
export function ExternalBansSection({
  playerId,
  canBan = false,
}: {
  playerId: string;
  canBan?: boolean;
}) {
  const [data, setData] = useState<PlayerExternalBansResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [localBanTarget, setLocalBanTarget] = useState<ExternalBanLocalBanTarget | null>(null);
  const [localBanMessage, setLocalBanMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(`/api/v1/players/${playerId}/external-bans`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as PlayerExternalBansResponse;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
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

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Внешние банлисты"
        actions={
          <ButtonLink href="/external-bans" variant="plain" size="sm">
            Все внешние баны
          </ButtonLink>
        }
      />
      <CardBody className="space-y-3">
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить внешние банлисты"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading ? (
          <Skeleton variant="block" label="Загрузка внешних банлистов" />
        ) : !data ? null : (
          <>
            {localBanMessage ? <InlineBanner tone="good" title={localBanMessage} /> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge
                state={data.active_source_count > 0 ? 'crit' : 'good'}
                label={foundBadgeLabel(data.active_source_count)}
              />
              {data.total > 0 ? (
                <Button size="sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Скрыть' : 'Показать'}
                </Button>
              ) : null}
            </div>

            {expanded && data.sources.length > 0 ? (
              <div className="space-y-3">
                {data.sources.map((group) => (
                  <div
                    key={group.source.id}
                    className="space-y-2 rounded-ctl border border-line p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {group.source.discord_url ? (
                          <a
                            href={group.source.discord_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[13px] text-accent"
                          >
                            {group.source.name}
                          </a>
                        ) : (
                          <span className="text-[13px] text-ink">{group.source.name}</span>
                        )}
                        <Badge size="sm" tone={TRUST_TONE[group.source.trust_level] ?? 'neutral'}>
                          {trustLevelLabel(group.source.trust_level)}
                        </Badge>
                      </div>
                      <span className="text-xs text-ink-3">
                        {group.active_count > 0
                          ? `Активных банов: ${group.active_count}`
                          : 'Активных банов нет'}
                      </span>
                    </div>
                    <ul className="divide-y divide-line rounded-ctl border border-line">
                      {group.bans.map((ban) => (
                        <li key={ban.id} className="p-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Badge size="sm" tone={banStatusTone(ban)}>
                              {banStatusBadge(ban).label}
                            </Badge>
                            <span className="text-ink-3">
                              {formatDate(ban.issued_at)}
                              {ban.expires_at ? ` → ${formatDate(ban.expires_at)}` : ''}
                            </span>
                          </div>
                          {ban.reason ? <p className="mt-1 text-ink-2">{ban.reason}</p> : null}
                          {ban.admin_name ? (
                            <p className="mt-0.5 text-ink-3">Админ: {ban.admin_name}</p>
                          ) : null}
                          {canBan && ban.is_active ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="mt-2"
                              onClick={() => {
                                setLocalBanMessage(null);
                                setLocalBanTarget({
                                  id: ban.id,
                                  sourceName: group.source.name,
                                  reason: ban.reason,
                                });
                              }}
                            >
                              Забанить локально
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}

        <ExternalBanLocalBanModal
          playerId={playerId}
          target={localBanTarget}
          onClose={() => setLocalBanTarget(null)}
          onBanned={(serverName) => {
            setLocalBanTarget(null);
            setLocalBanMessage(`Локальный бан отправлен на сервер «${serverName}».`);
          }}
        />
      </CardBody>
    </Card>
  );
}
