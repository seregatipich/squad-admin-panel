'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  InlineBanner,
  Skeleton,
  StatTile,
  StatusBadge,
} from '@/components/ui';
import { type PlayerVoteStats, serialSkipperLabel } from './votes';

export function VotesSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<PlayerVoteStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/vote-stats`, { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: PlayerVoteStats) => {
        if (!cancelled) setData(body);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  useEffect(() => load(), [load]);

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Голосования"
        actions={
          <>
            {data?.serial_skipper.flagged ? (
              <StatusBadge state="crit" size="sm" label="Серийный скипер" />
            ) : null}
            <ButtonLink href="/votes" variant="plain" size="sm">
              Лог голосований
            </ButtonLink>
          </>
        }
      />
      <CardBody className="space-y-3">
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить голосования"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading || !data ? (
          <Skeleton variant="card" label="Загрузка голосований" />
        ) : (
          <>
            <CardGrid cols={2}>
              <StatTile label="Инициировал" value={data.initiated.toLocaleString('ru-RU')} />
              <StatTile label="Участвовал" value={data.participated.toLocaleString('ru-RU')} />
            </CardGrid>

            {data.serial_skipper.flagged ? (
              <InlineBanner
                tone="crit"
                title="Серийный скипер"
                description={serialSkipperLabel(data.serial_skipper)}
              />
            ) : (
              <p className="text-xs text-ink-3">
                Скипов за {data.serial_skipper.window_days} дн.:{' '}
                <span className="tabular-nums text-ink-2">{data.serial_skipper.skip_count}</span>{' '}
                (порог {data.serial_skipper.threshold})
              </p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
