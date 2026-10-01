'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { apiResult, describeHttpError } from '@/lib/api';
import { type CoplayPartner, coplayUrl, parseCoplayPartners } from './coplay';
import { fmtDuration } from './presence';

/**
 * ALT-6 co-play card block, gated by the existing panel_access API route.
 * Asks the API for exactly the partners it lists and no per-server split
 * (#453), validates the body (#456) and retries through the load effect (#451).
 */
export function PlaysWithSection({ playerId }: { playerId: string }) {
  const [partners, setPartners] = useState<CoplayPartner[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    const controller = new AbortController();
    setError(null);
    apiResult<unknown>(coplayUrl(playerId), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          if (response.error.status === 401 || response.error.status === 403) {
            if (!cancelled) setHidden(true);
            return null;
          }
          throw response.error;
        }
        const parsed = parseCoplayPartners(response.data);
        if (!parsed) throw new Error('Некорректный ответ сервера');
        return parsed;
      })
      .then((body) => {
        if (!cancelled && body) setPartners(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeHttpError(err));
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
        title="Часто играет с"
        actions={
          <ButtonLink href={`/all-players/${playerId}/compare`} variant="plain" size="sm">
            Сравнить онлайн
          </ButtonLink>
        }
      />
      <CardBody padding={partners && partners.length > 0 ? 'none' : 'md'}>
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить напарников"
            description={error}
            action={
              <Button size="sm" onClick={() => setRetryCount((count) => count + 1)}>
                Повторить
              </Button>
            }
          />
        ) : partners === null ? (
          <Skeleton variant="row" count={3} label="Загрузка напарников" />
        ) : partners.length === 0 ? (
          <EmptyState
            title="Постоянных напарников нет"
            description="Совместных игровых сессий выше порога не найдено."
          />
        ) : (
          <Table ariaLabel="Часто играет с">
            <TableHead>
              <TableRow>
                <Th>Игрок</Th>
                <Th align="right">Вместе</Th>
                <Th align="right">Сессий</Th>
                <Th align="right">Сравнение</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {partners.map((partner) => (
                <TableRow key={partner.player_id}>
                  <Td>
                    <Link href={`/all-players/${partner.player_id}`} className="text-accent">
                      {partner.player_name ?? '—'}
                    </Link>
                  </Td>
                  <Td numeric>{fmtDuration(partner.overlap_seconds)}</Td>
                  <Td numeric>{partner.shared_session_count}</Td>
                  <Td align="right">
                    <Link
                      href={`/all-players/${playerId}/compare?other=${encodeURIComponent(partner.player_id)}`}
                      className="text-accent"
                    >
                      Сравнить
                    </Link>
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
