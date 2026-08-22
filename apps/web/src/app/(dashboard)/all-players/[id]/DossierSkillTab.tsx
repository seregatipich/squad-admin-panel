'use client';

import dynamic from 'next/dynamic';

import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatTile,
} from '@/components/ui';
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
  loading: () => <Skeleton variant="card" className="h-56" label="Загрузка графика" />,
});

/** «Всё время» — это отсутствие окна; сегменту нужен строковый ключ, а не `null`. */
const ALL_TIME = 'all';

function periodValue(months: number | null): string {
  return months === null ? ALL_TIME : String(months);
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
      <SegmentedControl
        ariaLabel="Период"
        value={periodValue(monthsBack)}
        onChange={(next) =>
          onMonthsBackChange(next === ALL_TIME ? null : Number.parseInt(next, 10))
        }
        items={DOSSIER_PERIODS.map((period) => ({
          value: periodValue(period.months),
          label: period.label,
        }))}
      />

      {skill.matches === 0 ? (
        <EmptyState
          title="У этого игрока пока нет боевой статистики."
          description="Панель ещё не получила ни одного завершённого матча с его участием."
        />
      ) : null}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile size="sm" label="K/D" value={skill.kd.toFixed(2)} />
        <StatTile size="sm" label="Винрейт" value={formatWinrate(skill.winrate)} />
        <StatTile size="sm" label="Матчи" value={String(skill.matches)} />
        <StatTile size="sm" label="Победы" value={String(skill.wins)} />
        <StatTile size="sm" label="Поражения" value={String(skill.losses)} />
        <StatTile size="sm" label="Ничьи" value={String(skill.draws)} />
        <StatTile size="sm" label="Убийства" value={String(skill.kills)} />
        <StatTile size="sm" label="Смерти" value={String(skill.deaths)} />
        <StatTile size="sm" label="Поднятия" value={String(skill.revives)} />
        <StatTile size="sm" label="Тимкиллы" value={String(skill.teamkills)} />
        {/* Пояснение стоит текстом под значением, а не подсказкой при наведении:
            «—» без причины читается как ноль (§5, §8). */}
        <StatTile
          size="sm"
          label="Урон"
          value={formatDamage(skill.damage_dealt)}
          hint={DAMAGE_UNAVAILABLE_HINT}
        />
      </div>

      <Chart kills={skill.kills} deaths={skill.deaths} trend={trend} />

      <Card as="section" padding="none">
        <CardHeader
          headingLevel={3}
          title="RNSquadJS"
          description="Источник: RNSquadJS, отдельный от боевых агрегатов панели"
        />
        <CardBody>
          <p className="text-[13px] text-ink-2">{RNSQUADJS_UNAVAILABLE}</p>
        </CardBody>
      </Card>
    </div>
  );
}
