'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  InlineBanner,
  Skeleton,
  StatTile,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import {
  buildSeedContributionUrl,
  formatSeedDuration,
  parseSeedContribution,
  type SeedContributionResponse,
  serverLabel,
  sortServersBySeedSeconds,
} from './seed-contribution';

export function SeedContributionSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<SeedContributionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(buildSeedContributionUrl(playerId), { credentials: 'include', cache: 'no-store' })
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
        const parsed = parseSeedContribution(body);
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

  const servers = data ? sortServersBySeedSeconds(data.by_server) : [];

  return (
    <Card padding="none" as="section">
      <CardHeader title="Сид-вклад" />
      <CardBody className="space-y-4">
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить сид-вклад"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : null}

        {loading && !data ? (
          <Skeleton variant="card" count={1} label="Загрузка сид-вклада" />
        ) : data ? (
          <>
            <CardGrid cols={2}>
              <StatTile
                label={`Сид за ${data.window.days} дней`}
                value={formatSeedDuration(data.total_seed_seconds)}
                hint={`${data.window.from} — ${data.window.to}`}
              />
              <StatTile
                label="Бонусы за сид"
                value={data.bonus.earned_points}
                hint={`Коэффициент k_seed: ${data.bonus.k_seed}`}
              />
            </CardGrid>

            {servers.length === 0 ? (
              <EmptyState
                title="Сид-вклада по серверам нет"
                description="Нет данных о сид-вкладе по серверам."
              />
            ) : (
              <Table ariaLabel="Сид-вклад по серверам">
                <TableHead>
                  <TableRow>
                    <Th>Сервер</Th>
                    <Th align="right">Сид</Th>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {servers.map((server) => (
                    <TableRow key={server.server_id}>
                      <Td>
                        <Badge size="sm" title={server.server_name ?? undefined}>
                          {serverLabel(server)}
                        </Badge>
                      </Td>
                      <Td numeric>{formatSeedDuration(server.seed_seconds)}</Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
