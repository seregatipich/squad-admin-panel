'use client';

import { useState } from 'react';

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

function SortButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs ${
        active
          ? 'border-sky-700 bg-sky-950 text-sky-200'
          : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * DOSSIER-6 (#193) «Оружие» tab: the top-N weapon table with kills/damage
 * sorting.
 *
 * The damage sort control appears only when at least one row carries a
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
      <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
        Нет данных по оружию.
      </div>
    );
  }

  const rows = sortWeapons(weapons, sortKey);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-neutral-400">
          {weaponsCountLabel(weapons.length, weaponsTotal)}
          <span className="ml-2 text-neutral-600">{LIFETIME_ONLY_NOTE}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <SortButton active={sortKey === 'kills'} onClick={() => setSortKey('kills')}>
            По убийствам
          </SortButton>
          {hasAnyDamage(weapons) ? (
            <SortButton active={sortKey === 'damage'} onClick={() => setSortKey('damage')}>
              По урону
            </SortButton>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-neutral-800">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-xs uppercase tracking-widest text-neutral-500">
            <tr>
              <th className="p-1.5 text-left">Оружие</th>
              <th className="p-1.5 text-right">Убийства</th>
              <th className="p-1.5 text-right">Тимкиллы</th>
              <th className="p-1.5 text-right">Урон</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.weapon} className="border-t border-neutral-900">
                <td className="p-1.5 font-mono text-neutral-200">{row.weapon}</td>
                <td className="p-1.5 text-right font-mono text-neutral-300 tabular-nums">
                  {row.kills}
                </td>
                <td className="p-1.5 text-right font-mono text-neutral-300 tabular-nums">
                  {row.teamkills}
                </td>
                <td
                  className="p-1.5 text-right font-mono text-neutral-300 tabular-nums"
                  title={row.damage === null ? DAMAGE_UNAVAILABLE_HINT : undefined}
                >
                  {formatDamage(row.damage)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
