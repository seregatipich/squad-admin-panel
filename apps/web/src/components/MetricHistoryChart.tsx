'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatAbsolute } from '@/components/ui';
import {
  CHART_AREA_OPACITY,
  CHART_AXIS,
  CHART_GRID,
  CHART_SERIES,
  CHART_TOOLTIP_STYLE,
} from '@/lib/chart-tokens';

export type MetricKey = 'cpu' | 'ram' | 'disk' | 'net';

export interface MetricPoint {
  ts: number;
  cpu: number;
  ram_pct: number;
  disk_pct: number;
  rx: number;
  tx: number;
}

/** Панель говорит по-русски, поэтому и время в графиках форматируется по-русски. */
const LOCALE = 'ru-RU';

/**
 * Подпись деления оси времени. Локаль задана явно: `toLocaleTimeString()` без
 * неё отдаёт формат хозяйской машины, и соседние графики панели показывают
 * одно и то же время по-разному.
 */
const tickFmt = (t: number) =>
  new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Время в подсказке. Раньше здесь печаталась ISO-строка (`2026-08-22T09:14:05.123Z`) —
 * машинный формат в чужом часовом поясе, который оператору приходилось
 * пересчитывать в уме. Теперь это тот же абсолютный формат, что и во всей
 * панели.
 */
const tooltipLabelFmt = (t: unknown) => formatAbsolute(t as number, LOCALE) ?? '—';

export default function MetricHistoryChart({
  metric,
  data,
}: {
  metric: MetricKey;
  data: MetricPoint[];
}) {
  if (metric === 'cpu' || metric === 'ram' || metric === 'disk') {
    const dataKey = metric === 'cpu' ? 'cpu' : metric === 'ram' ? 'ram_pct' : 'disk_pct';
    const color =
      metric === 'cpu' ? CHART_SERIES.cpu : metric === 'ram' ? CHART_SERIES.ram : CHART_SERIES.disk;
    return (
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
          <XAxis dataKey="ts" tickFormatter={tickFmt} stroke={CHART_AXIS} minTickGap={48} />
          <YAxis domain={[0, 100]} unit="%" stroke={CHART_AXIS} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelFormatter={tooltipLabelFmt}
            formatter={(v) => (typeof v === 'number' ? `${v.toFixed(2)}%` : String(v))}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            fill={color}
            fillOpacity={CHART_AREA_OPACITY}
          />
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
        <XAxis dataKey="ts" tickFormatter={tickFmt} stroke={CHART_AXIS} minTickGap={48} />
        <YAxis stroke={CHART_AXIS} tickFormatter={(v: number) => `${(v / 1024).toFixed(0)} KB/s`} />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          labelFormatter={tooltipLabelFmt}
          formatter={(v, name) => [
            typeof v === 'number' ? `${(v / 1024).toFixed(2)} KB/s` : String(v),
            name === 'rx' ? 'Вход' : 'Выход',
          ]}
        />
        <Area
          type="monotone"
          dataKey="rx"
          stroke={CHART_SERIES.rx}
          fill={CHART_SERIES.rx}
          fillOpacity={CHART_AREA_OPACITY}
        />
        <Area
          type="monotone"
          dataKey="tx"
          stroke={CHART_SERIES.tx}
          fill={CHART_SERIES.tx}
          fillOpacity={CHART_AREA_OPACITY}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
