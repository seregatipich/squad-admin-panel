'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import {
  Badge,
  type BadgeTone,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import {
  allMatchesHref,
  formatMatchDate,
  formatMatchDuration,
  type MatchOutcome,
  type MatchSummary,
  outcomeLabel,
  serverLabel,
  winratePercent,
  winrateSummaryText,
} from './recent-matches';

/** Исход матча — состояние, а не категория: подпись из {@link outcomeLabel} несёт смысл (§5). */
function outcomeTone(outcome: MatchOutcome): BadgeTone {
  if (outcome === null) return 'neutral';
  if (outcome === 'win') return 'good';
  if (outcome === 'loss') return 'crit';
  return 'warn';
}

export function RecentMatchesSection({ playerId }: { playerId: string }) {
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/match-summary`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: MatchSummary) => {
        if (!cancelled) setSummary(body);
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

  const percent = summary ? winratePercent(summary.winrate) : null;
  const hasRows = Boolean(summary && summary.recent.length > 0);

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Последние матчи"
        count={
          summary && summary.winrate.considered > 0
            ? `${winrateSummaryText(summary.winrate)}${percent !== null ? ` · ${percent}%` : ''}`
            : undefined
        }
        actions={
          <ButtonLink href={allMatchesHref(playerId)} variant="plain" size="sm">
            Все матчи
          </ButtonLink>
        }
      />
      <CardBody padding={hasRows ? 'none' : 'md'}>
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить матчи"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading ? (
          <SkeletonTable rows={5} cols={5} label="Загрузка матчей" />
        ) : !hasRows || !summary ? (
          <EmptyState
            title="Матчей нет"
            description="История матчей ведётся с момента, когда панель начала учитывать матчи на серверах."
          />
        ) : (
          <Table ariaLabel="Последние матчи">
            <TableHead>
              <TableRow>
                <Th>Дата</Th>
                <Th>Сервер</Th>
                <Th>Слой</Th>
                <Th align="right">Участие</Th>
                <Th>Исход</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {summary.recent.map((match) => (
                <TableRow key={match.match_id}>
                  <Td>
                    <Link
                      href={`/matches/${match.match_id}`}
                      className="whitespace-nowrap font-mono text-accent"
                      title="Открыть матч"
                    >
                      {formatMatchDate(match.started_at)}
                    </Link>
                  </Td>
                  <Td>
                    <Badge size="sm" title={match.server_name ?? undefined}>
                      {serverLabel(match)}
                    </Badge>
                  </Td>
                  <Td>{match.layer ?? '—'}</Td>
                  <Td numeric>{formatMatchDuration(match.play_seconds)}</Td>
                  <Td>
                    <Badge size="sm" tone={outcomeTone(match.outcome)}>
                      {outcomeLabel(match.outcome)}
                    </Badge>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
