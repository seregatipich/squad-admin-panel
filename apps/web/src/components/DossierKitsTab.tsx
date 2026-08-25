'use client';

import { EmptyState, Table, TableBody, TableHead, TableRow, Td, Th } from '@/components/ui';
import { type DossierKit, formatPlayTime, sortKits } from './dossier';

/** Same field set as `formatMatchDate` in `recent-matches.ts`; `—` for a never-played kit. */
function formatKitDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * DOSSIER-6 (#193) «Киты» tab: kit → played time → last played, longest first.
 *
 * @param kits Kit rows for the selected server, summed across servers for «Все серверы».
 */
export function DossierKitsTab({ kits }: { kits: readonly DossierKit[] }) {
  if (kits.length === 0) {
    return (
      <EmptyState
        title="Нет данных по китам."
        description="Панель не получила ни одной записи о выбранных китах этого игрока."
      />
    );
  }

  return (
    <Table ariaLabel="Киты игрока">
      <TableHead sticky={false}>
        <tr>
          <Th>Кит</Th>
          <Th align="right">Время</Th>
          <Th align="right">Последний раз</Th>
        </tr>
      </TableHead>
      <TableBody>
        {sortKits(kits).map((row) => (
          <TableRow key={row.kit}>
            <Td className="font-mono">{row.kit}</Td>
            <Td numeric>{formatPlayTime(row.seconds)}</Td>
            <Td numeric className="whitespace-nowrap">
              {formatKitDate(row.last_played_at)}
            </Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
