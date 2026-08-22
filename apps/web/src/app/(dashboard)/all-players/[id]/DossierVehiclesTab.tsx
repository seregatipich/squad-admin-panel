'use client';

import { EmptyState, Table, TableBody, TableHead, TableRow, Td, Th } from '@/components/ui';
import { useLocale } from '@/i18n/LocaleProvider';

import {
  DAMAGE_UNAVAILABLE_HINT,
  type DossierVehicle,
  type DossierVehicleKill,
  formatDamage,
  LIFETIME_ONLY_NOTE,
  vehicleDisplayName,
  vehicleTitle,
} from './dossier';

/**
 * DOSSIER-6 (#193) «Техника» tab: «На технике» from `vehicles` and
 * «Уничтожено» from `vehicle_kills`.
 *
 * A catalogued row shows the name for the active locale and carries the raw
 * asset id in its `title`; an uncatalogued row shows the raw asset id and is
 * titled {@link VEHICLE_UNCATALOGUED_HINT}. Both aggregates are lifetime-only,
 * so the header states {@link LIFETIME_ONLY_NOTE}.
 *
 * @param vehicles Rows the player drove/crewed.
 * @param vehicleKills Rows the player destroyed.
 */
export function DossierVehiclesTab({
  vehicles,
  vehicleKills,
}: {
  vehicles: readonly DossierVehicle[];
  vehicleKills: readonly DossierVehicleKill[];
}) {
  const locale = useLocale();

  if (vehicles.length === 0 && vehicleKills.length === 0) {
    return (
      <EmptyState
        title="Нет данных по технике."
        description="Панель не получила ни одного события с техникой этого игрока."
      />
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-ink-3">{LIFETIME_ONLY_NOTE}</p>

      {vehicles.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-[13px] font-semibold text-ink">На технике</h3>
          <Table ariaLabel="Техника, на которой играл игрок">
            <TableHead sticky={false}>
              <tr>
                <Th>Техника</Th>
                <Th align="right">Убийства</Th>
                <Th align="right">Урон</Th>
              </tr>
            </TableHead>
            <TableBody>
              {vehicles.map((row) => (
                <TableRow key={row.vehicle_asset_id}>
                  <Td>
                    <span title={vehicleTitle(row)}>{vehicleDisplayName(row, locale)}</span>
                  </Td>
                  <Td numeric>{row.kills}</Td>
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
        </section>
      ) : null}

      {vehicleKills.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-[13px] font-semibold text-ink">Уничтожено</h3>
          <Table ariaLabel="Техника, уничтоженная игроком">
            <TableHead sticky={false}>
              <tr>
                <Th>Техника</Th>
                <Th>Оружие</Th>
                <Th align="right">Уничтожено</Th>
              </tr>
            </TableHead>
            <TableBody>
              {vehicleKills.map((row) => (
                <TableRow key={`${row.victim_vehicle_asset_id}:${row.weapon}`}>
                  <Td>
                    <span
                      title={vehicleTitle({
                        vehicle_asset_id: row.victim_vehicle_asset_id,
                        unlocalized: row.unlocalized,
                      })}
                    >
                      {vehicleDisplayName(
                        { ...row, vehicle_asset_id: row.victim_vehicle_asset_id },
                        locale,
                      )}
                    </span>
                  </Td>
                  <Td className="font-mono">{row.weapon}</Td>
                  <Td numeric>{row.destroyed_count}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}
