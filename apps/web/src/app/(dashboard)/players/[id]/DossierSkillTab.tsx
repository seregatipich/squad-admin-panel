'use client';

import dynamic from 'next/dynamic';

import {
  DAMAGE_UNAVAILABLE_HINT,
  DOSSIER_PERIODS,
  type DossierSkill,
  type DossierTrendPoint,
  formatDamage,
  formatWinrate,
  RNSQUADJS_UNAVAILABLE,
} from './dossier';

const Chart = dynamic(() => import('./DossierSkillChart'), {
  ssr: false,
  loading: () => (
    <div className="flex h-56 items-center justify-center text-sm text-neutral-500">
      Загрузка графика…
    </div>
  ),
});

function Kpi({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded border border-neutral-900 bg-neutral-900/40 p-2" title={title}>
      <div className="text-[10px] uppercase tracking-widest text-neutral-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-neutral-100 tabular-nums">{value}</div>
    </div>
  );
}

/**
 * DOSSIER-6 (#193) «Скилл» tab: the eleven combat KPIs, the period selector
 * driving the block's single request, the donut + month-trend chart, and the
 * RNSquadJS sub-section.
 *
 * @param skill Aggregates for the selected window; `damage_dealt` is
 *   permanently null upstream and renders as «—».
 * @param trend Month rows already zero-filled by `fillTrendMonths`.
 * @param monthsBack Active window; null is «Всё время».
 * @param onMonthsBackChange Re-runs the block's fetch with the new window.
 */
export function DossierSkillTab({
  skill,
  trend,
  monthsBack,
  onMonthsBackChange,
}: {
  skill: DossierSkill;
  trend: readonly DossierTrendPoint[];
  monthsBack: number | null;
  onMonthsBackChange: (months: number | null) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {DOSSIER_PERIODS.map((period) => (
          <button
            key={period.label}
            type="button"
            onClick={() => onMonthsBackChange(period.months)}
            className={`rounded border px-2 py-1 text-xs ${
              period.months === monthsBack
                ? 'border-sky-700 bg-sky-950 text-sky-200'
                : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {period.label}
          </button>
        ))}
      </div>

      {skill.matches === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          У этого игрока пока нет боевой статистики.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="K/D" value={skill.kd.toFixed(2)} />
        <Kpi label="Винрейт" value={formatWinrate(skill.winrate)} />
        <Kpi label="Матчи" value={String(skill.matches)} />
        <Kpi label="Победы" value={String(skill.wins)} />
        <Kpi label="Поражения" value={String(skill.losses)} />
        <Kpi label="Ничьи" value={String(skill.draws)} />
        <Kpi label="Убийства" value={String(skill.kills)} />
        <Kpi label="Смерти" value={String(skill.deaths)} />
        <Kpi label="Поднятия" value={String(skill.revives)} />
        <Kpi label="Тимкиллы" value={String(skill.teamkills)} />
        <Kpi
          label="Урон"
          value={formatDamage(skill.damage_dealt)}
          title={DAMAGE_UNAVAILABLE_HINT}
        />
      </div>

      <Chart kills={skill.kills} deaths={skill.deaths} trend={trend} />

      <section className="rounded border border-neutral-900 bg-neutral-900/30 p-3">
        <h3 className="text-[11px] uppercase tracking-widest text-neutral-400">RNSquadJS</h3>
        <p className="mt-1 text-[11px] text-neutral-500">
          Источник: RNSquadJS, отдельный от боевых агрегатов панели
        </p>
        <p className="mt-2 text-sm text-neutral-400">{RNSQUADJS_UNAVAILABLE}</p>
      </section>
    </div>
  );
}
