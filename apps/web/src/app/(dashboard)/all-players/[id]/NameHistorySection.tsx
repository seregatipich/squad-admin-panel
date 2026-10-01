'use client';

import {
  Button,
  Card,
  CardHeader,
  DateTime,
  EmptyState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import type { NameHistory } from './player-detail';

/** Table of the names the panel has seen the player under; a ban-capable viewer can ban any of them. */
export function NameHistorySection({
  names,
  canBan,
  onBanName,
}: {
  names: NameHistory[];
  canBan: boolean;
  onBanName: (name: string) => void;
}) {
  const locale = useIntlLocale();
  return (
    <Card as="section" padding="none">
      <CardHeader title="История ников" count={names.length > 0 ? names.length : undefined} />
      {names.length === 0 ? (
        <EmptyState
          title="Только основной ник"
          description="Панель не видела этого игрока ни под каким другим ником."
        />
      ) : (
        <Table ariaLabel="История ников игрока">
          <TableHead sticky={false}>
            <tr>
              <Th>Ник</Th>
              <Th align="right">Замечен, раз</Th>
              <Th>Первый раз</Th>
              <Th>Последний раз</Th>
              {canBan ? <Th>Действие</Th> : null}
            </tr>
          </TableHead>
          <TableBody>
            {names.map((n) => (
              <TableRow key={n.name_normalized}>
                <Td className="font-medium">{n.name}</Td>
                <Td numeric>{n.observation_count}</Td>
                <Td className="text-xs text-ink-3">
                  <DateTime value={n.first_seen_at} locale={locale} />
                </Td>
                <Td className="text-xs text-ink-3">
                  <DateTime value={n.last_seen_at} locale={locale} />
                </Td>
                {canBan ? (
                  <Td>
                    <Button size="sm" onClick={() => onBanName(n.name)}>
                      Забанить ник
                    </Button>
                  </Td>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
