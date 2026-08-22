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
import {
  buildCombatLogTeamkillHref,
  buildPlayerTeamkillApiPath,
  formatTeamkillCount,
  formatTeamkillDate,
  type TeamkillPlayerEvent,
  type TeamkillPlayerResponse,
} from '../../moderation/teamkills/helpers';

function formatModerationSubline(stats: TeamkillPlayerResponse['stats']): string {
  const type = stats.last_moderation_type ?? '—';
  return `Последнее: ${type} · ${formatTeamkillDate(stats.last_moderation_at)}`;
}

export function PlayerTeamkillsSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<TeamkillPlayerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(buildPlayerTeamkillApiPath(playerId), {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as TeamkillPlayerResponse;
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
              <Button size="sm" onClick={() => load()}>
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
                  data.stats.moderation_total > 0 ? formatModerationSubline(data.stats) : undefined
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
