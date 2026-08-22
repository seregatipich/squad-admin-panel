'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { type DossierTrendPoint, trendKd, trendMonthLabel } from './dossier';

// Recharts красит фигуры атрибутами SVG, а не классами, поэтому цвета берутся
// прямо из токенов темы — иначе график разъехался бы с остальной панелью.
const KILLS_COLOR = 'var(--color-accent)';
const DEATHS_COLOR = 'var(--color-crit)';
const GRID_COLOR = 'var(--color-line)';
const AXIS_COLOR = 'var(--color-ink-3)';
const KILLS_LABEL = 'Убийства';
const DEATHS_LABEL = 'Смерти';

interface TrendBar {
  month: string;
  kills: number;
  deaths: number;
  kd: number;
}

/**
 * `MM.YYYY · K/D N.NN` for the hovered month.
 *
 * Resolved by filtering the rows rather than reading the tooltip payload, so
 * the formatter holds no conditional at all: an unmatched label simply
 * contributes nothing to the join.
 */
function trendTooltipLabel(label: ReactNode, bars: readonly TrendBar[]): string {
  return [
    String(label),
    ...bars.filter((bar) => bar.month === label).map((bar) => `K/D ${bar.kd.toFixed(2)}`),
  ].join(' · ');
}

/**
 * DOSSIER-6 (#193) skill-tab visuals: a kills-vs-deaths donut and a stacked
 * month trend whose tooltip carries the month's K/D.
 *
 * Default-exported and reached only through `next/dynamic` in
 * {@link ../DossierSkillTab}, which keeps recharts out of the curated static
 * import graphs (`apps/web/test/pages-graph.test.ts`).
 *
 * @param kills Lifetime kills for the selected window, the donut's first slice.
 * @param deaths Lifetime deaths for the selected window, the donut's second slice.
 * @param trend Month rows already zero-filled by `fillTrendMonths`.
 */
export default function DossierSkillChart({
  kills,
  deaths,
  trend,
}: {
  kills: number;
  deaths: number;
  trend: readonly DossierTrendPoint[];
}) {
  const donut = [
    { name: KILLS_LABEL, value: kills },
    { name: DEATHS_LABEL, value: deaths },
  ];
  const bars: TrendBar[] = trend.map((point) => ({
    month: trendMonthLabel(point.month),
    kills: point.kills,
    deaths: point.deaths,
    kd: trendKd(point.kills, point.deaths),
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="h-56" data-testid="dossier-skill-donut">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={donut} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%">
              <Cell fill={KILLS_COLOR} />
              <Cell fill={DEATHS_COLOR} />
            </Pie>
            <Legend />
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="h-56" data-testid="dossier-skill-trend">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="month" stroke={AXIS_COLOR} fontSize={11} />
            <YAxis stroke={AXIS_COLOR} fontSize={11} />
            <Tooltip labelFormatter={(label: ReactNode) => trendTooltipLabel(label, bars)} />
            <Legend />
            <Bar dataKey="kills" name={KILLS_LABEL} stackId="kd" fill={KILLS_COLOR} />
            <Bar dataKey="deaths" name={DEATHS_LABEL} stackId="kd" fill={DEATHS_COLOR} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
