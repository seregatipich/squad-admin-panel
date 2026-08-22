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
import { fmtDuration } from './presence';

interface CoplayPartner {
  player_id: string;
  player_name: string | null;
  overlap_seconds: number;
  shared_session_count: number;
}

interface CoplayResponse {
  partners: CoplayPartner[];
}

/** ALT-6 co-play card block, gated by the existing panel_access API route. */
export function PlaysWithSection({ playerId }: { playerId: string }) {
  const [partners, setPartners] = useState<CoplayPartner[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/v1/players/${playerId}/coplay`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          if (!cancelled) setHidden(true);
          return null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as CoplayResponse;
      })
      .then((body) => {
        if (!cancelled && body) setPartners(body.partners.slice(0, 10));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
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
              <Button size="sm" onClick={() => load()}>
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
