'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  InlineBanner,
  Skeleton,
  StatTile,
} from '@/components/ui';
import { apiResult, describeHttpError } from '@/lib/api';
import {
  buildCombatLogTeamkillHref,
  buildPlayerTeamkillApiPath,
  formatLastModeration,
  formatTeamkillCount,
  formatTeamkillDate,
  parseTeamkillPlayerResponse,
  type TeamkillPlayerEvent,
  type TeamkillPlayerResponse,
} from '../../moderation/teamkills/helpers';

/**
 * «Тимкиллы» player-card block: counters, moderation summary and the latest
 * events. The body is validated before rendering (#456) and a retry re-runs
 * the load effect, whose cleanup aborts the previous request (#451).
 */
export function PlayerTeamkillsSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<TeamkillPlayerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setHidden(false);
    setError(null);
    apiResult<unknown>(buildPlayerTeamkillApiPath(playerId), { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          if (res.error.status === 401 || res.error.status === 403) {
            setHidden(true);
            return null;
          }
          throw res.error;
        }
        const body = parseTeamkillPlayerResponse(res.data);
        if (!body) throw new Error('Некорректный ответ сервера');
        return body;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeHttpError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [playerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount is a re-run trigger
  useEffect(() => load(), [load, retryCount]);

  if (hidden) return null;

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Тимкиллы"
        actions={
          <ButtonLink
            href={buildCombatLogTeamkillHref({ role: 'attacker', playerId })}
            variant="plain"
            size="sm"
          >
            Боевой лог
          </ButtonLink>
        }
      />
      <CardBody className="space-y-4">
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить тимкиллы"
            description={error}
            action={
              <Button size="sm" onClick={() => setRetryCount((count) => count + 1)}>
                Повторить
              </Button>
            }
          />
        ) : null}

        {loading && !data ? (
          <Skeleton variant="card" label="Загрузка тимкиллов" />
        ) : data ? (
          <>
            <CardGrid cols={3}>
              <StatTile size="sm" label="7 дней" value={formatTeamkillCount(data.stats.tk_7d)} />
              <StatTile size="sm" label="30 дней" value={formatTeamkillCount(data.stats.tk_30d)} />
              <StatTile size="sm" label="Всего" value={formatTeamkillCount(data.stats.tk_total)} />
              <StatTile
                size="sm"
                label="Получал TK"
                value={formatTeamkillCount(data.stats.victim_of_tk_total)}
              />
              <StatTile
                size="sm"
                label="Модерация"
                value={formatTeamkillCount(data.stats.moderation_total)}
                tone={data.stats.moderation_total > 0 ? 'warn' : 'neutral'}
                hint={
                  data.stats.moderation_total > 0
                    ? `Последнее: ${formatLastModeration(data.stats)}`
                    : undefined
                }
              />
            </CardGrid>

            {data.recent.length === 0 ? (
              <EmptyState title="TK-событий нет" description="Этот игрок не убивал своих." />
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-ctl border border-line">
                {data.recent.map((event) => (
                  <RecentEvent key={event.id} event={event} playerId={playerId} />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function RecentEvent({ event, playerId }: { event: TeamkillPlayerEvent; playerId: string }) {
  const roleLabel = event.role === 'attacker' ? 'нанёс' : 'получил';
  const logHref = buildCombatLogTeamkillHref({ role: event.role, playerId });
  const other = event.role === 'attacker' ? event.victim : event.attacker;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-[13px]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge size="sm" tone={event.role === 'attacker' ? 'crit' : 'warn'}>
            {roleLabel}
          </Badge>
          {other?.player_id ? (
            <Link href={`/all-players/${other.player_id}`} className="truncate text-accent">
              {other.current_name ?? other.player_id.slice(0, 8)}
            </Link>
          ) : (
            <span className="text-ink-3">неизвестный игрок</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-3">
          <span>{formatTeamkillDate(event.occurred_at)}</span>
          <span className="font-mono">{event.weapon ?? '—'}</span>
          {event.match_id ? <span className="font-mono">Матч {event.match_id}</span> : null}
        </div>
      </div>
      <Link href={logHref} className="text-xs text-accent">
        Лог
      </Link>
    </li>
  );
}
