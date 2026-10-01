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
import { apiResult, describeHttpError } from '@/lib/api';
import {
  type PlayerVoteStats,
  parsePlayerVoteStats,
  serialSkipperLabel,
  voteStatsUrl,
} from './votes';

/**
 * «Голосования» player-card section: votes initiated / taken part in and the
 * serial-skipper flag. Hides on 401/403 like its sibling sections, validates
 * the body before rendering (#468) and retries through the load effect.
 */

export function VotesSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<PlayerVoteStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setHidden(false);
    setError(null);
    apiResult<unknown>(voteStatsUrl(playerId), { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          if (res.error.status === 401 || res.error.status === 403) {
            if (!cancelled) setHidden(true);
            return null;
          }
          throw res.error;
        }
        const body = parsePlayerVoteStats(res.data);
        if (!body) throw new Error('Некорректный ответ сервера');
        return body;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeHttpError(e));
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
              <Button size="sm" onClick={() => setRetryCount((count) => count + 1)}>
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
