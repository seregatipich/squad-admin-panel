'use client';

import { useState } from 'react';

import {
  EmptyState,
  SortableTh,
  type SortDirection,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import {
  DAMAGE_UNAVAILABLE_HINT,
  type DossierWeapon,
  formatDamage,
  hasAnyDamage,
  LIFETIME_ONLY_NOTE,
  sortWeapons,
  type WeaponSortKey,
  weaponsCountLabel,
} from './dossier';

/**
 * Порядок здесь всегда «сначала больше»: `sortWeapons` умеет только убывание,
 * и возрастающий порядок в таблице лучших видов оружия не имеет смысла.
 */
const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

/**
 * DOSSIER-6 (#193) «Оружие» tab: the top-N weapon table with kills/damage
 * sorting.
 *
 * The damage column becomes sortable only when at least one row carries a
 * non-null `damage`; individual null cells always render «—» and are never
 * substituted with a zero. The aggregate has no server dimension, so the
 * header states {@link LIFETIME_ONLY_NOTE} instead of offering a selector.
 *
 * @param weapons Top rows as returned by the dossier route.
 * @param weaponsTotal Full distinct weapon count behind that top-N slice.
 */
export function DossierWeaponsTab({
  weapons,
  weaponsTotal,
}: {
  weapons: readonly DossierWeapon[];
  weaponsTotal: number;
}) {
  const [sortKey, setSortKey] = useState<WeaponSortKey>('kills');

  if (weapons.length === 0) {
    return (
      <EmptyState
        title="Нет данных по оружию."
        description="Панель не получила ни одного события убийства из оружия."
      />
    );
  }

  const rows = sortWeapons(weapons, sortKey);
  const damageSortable = hasAnyDamage(weapons);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-3">
        {weaponsCountLabel(weapons.length, weaponsTotal)}
        <span className="ml-2">{LIFETIME_ONLY_NOTE}</span>
      </p>

      <Table ariaLabel="Оружие игрока">
        <TableHead sticky={false}>
          <tr>
            <Th>Оружие</Th>
            <SortableTh
              sortKey="kills"
              activeKey={sortKey}
              direction="desc"
              onSort={() => setSortKey('kills')}
              label="Убийства"
              directionText={SORT_DIRECTION_TEXT}
              align="right"
            />
            <Th align="right">Тимкиллы</Th>
            {damageSortable ? (
              <SortableTh
                sortKey="damage"
                activeKey={sortKey}
                direction="desc"
                onSort={() => setSortKey('damage')}
                label="Урон"
                directionText={SORT_DIRECTION_TEXT}
                align="right"
              />
            ) : (
              <Th align="right">Урон</Th>
            )}
          </tr>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.weapon}>
              <Td className="font-mono">{row.weapon}</Td>
              <Td numeric>{row.kills}</Td>
              <Td numeric>{row.teamkills}</Td>
              <Td numeric>
                {row.damage === null ? (
                  <span title={DAMAGE_UNAVAILABLE_HINT}>{formatDamage(row.damage)}</span>
                ) : (
                  formatDamage(row.damage)
                )}
              </Td>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
