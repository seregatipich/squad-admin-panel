'use client';

import { type DossierKit, formatKitTime, sortKits } from './dossier';

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
      <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
        Нет данных по китам.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-neutral-800">
      <table className="w-full min-w-[420px] text-sm">
        <thead className="text-xs uppercase tracking-widest text-neutral-500">
          <tr>
            <th className="p-1.5 text-left">Кит</th>
            <th className="p-1.5 text-right">Время</th>
            <th className="p-1.5 text-right">Последний раз</th>
          </tr>
        </thead>
        <tbody>
          {sortKits(kits).map((row) => (
            <tr key={row.kit} className="border-t border-neutral-900">
              <td className="p-1.5 font-mono text-neutral-200">{row.kit}</td>
              <td className="p-1.5 text-right font-mono text-neutral-300 tabular-nums">
                {formatKitTime(row.seconds)}
              </td>
              <td className="whitespace-nowrap p-1.5 text-right font-mono text-neutral-400">
                {formatKitDate(row.last_played_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
