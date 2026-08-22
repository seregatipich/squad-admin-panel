'use client';

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
      <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
        Нет данных по технике.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-neutral-500">{LIFETIME_ONLY_NOTE}</div>

      {vehicles.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-widest text-neutral-400">На технике</h3>
          <div className="overflow-x-auto rounded border border-neutral-800">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="p-1.5 text-left">Техника</th>
                  <th className="p-1.5 text-right">Убийства</th>
                  <th className="p-1.5 text-right">Урон</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((row) => (
                  <tr key={row.vehicle_asset_id} className="border-t border-neutral-900">
                    <td className="p-1.5 text-neutral-200" title={vehicleTitle(row)}>
                      {vehicleDisplayName(row, locale)}
                    </td>
                    <td className="p-1.5 text-right font-mono text-neutral-300 tabular-nums">
                      {row.kills}
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
      ) : null}

      {vehicleKills.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-widest text-neutral-400">Уничтожено</h3>
          <div className="overflow-x-auto rounded border border-neutral-800">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="p-1.5 text-left">Техника</th>
                  <th className="p-1.5 text-left">Оружие</th>
                  <th className="p-1.5 text-right">Уничтожено</th>
                </tr>
              </thead>
              <tbody>
                {vehicleKills.map((row) => (
                  <tr
                    key={`${row.victim_vehicle_asset_id}:${row.weapon}`}
                    className="border-t border-neutral-900"
                  >
                    <td
                      className="p-1.5 text-neutral-200"
                      title={vehicleTitle({
                        vehicle_asset_id: row.victim_vehicle_asset_id,
                        unlocalized: row.unlocalized,
                      })}
                    >
                      {vehicleDisplayName(
                        { ...row, vehicle_asset_id: row.victim_vehicle_asset_id },
                        locale,
                      )}
                    </td>
                    <td className="p-1.5 font-mono text-neutral-300">{row.weapon}</td>
                    <td className="p-1.5 text-right font-mono text-neutral-300 tabular-nums">
                      {row.destroyed_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
