'use client';

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
import { serverColor } from '@/lib/server-color';
import { chartRows, type StatisticsSeries } from './helpers';

export interface ChartServer {
  server_id: string;
  display_name: string;
}

const AXIS = '#525252';
const GRID = '#262626';
const TOOLTIP_STYLE = { background: '#0a0a0a', border: '1px solid #333', fontSize: 12 };

/**
 * Stacked bar chart of one series, one colour-stable band per server.
 *
 * Rendered inside a `next/dynamic` chunk so recharts never lands in the page's
 * first-load bundle. Clicking a band calls `onDrill` with the clicked server
 * and bucket key, which the parent turns into a filtered list URL.
 */
export function StackedSeriesChart({
  series,
  servers,
  knownServerIds,
  labelOf,
  onDrill,
}: {
  series: StatisticsSeries;
  servers: ChartServer[];
  knownServerIds: string[];
  labelOf: (key: string) => string;
  onDrill?: (serverId: string, key: string) => void;
}) {
  const serverIds = servers.map((s) => s.server_id);
  const rows = chartRows(series, serverIds);
  const nameOf = new Map(servers.map((s) => [s.server_id, s.display_name]));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="key" tickFormatter={labelOf} stroke={AXIS} fontSize={10} minTickGap={16} />
        <YAxis stroke={AXIS} fontSize={10} allowDecimals={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(key) => labelOf(String(key))}
          formatter={(value, name) => [value, nameOf.get(String(name)) ?? String(name)]}
        />
        {serverIds.map((serverId) => (
          <Bar
            key={serverId}
            dataKey={serverId}
            stackId="all"
            fill={serverColor(serverId, knownServerIds)}
            name={serverId}
            cursor={onDrill ? 'pointer' : undefined}
            onClick={(entry: unknown) => {
              if (!onDrill) return;
              const key = (entry as { payload?: { key?: string } } | undefined)?.payload?.key;
              if (key) onDrill(serverId, key);
            }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Doughnut of the game-mode split across the whole window. */
export function ModesDoughnut({ modes }: { modes: Array<{ mode: string; matches: number }> }) {
  const ids = modes.map((entry) => entry.mode);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={modes} dataKey="matches" nameKey="mode" innerRadius={48} outerRadius={80}>
          {modes.map((entry) => (
            <Cell key={entry.mode} fill={serverColor(entry.mode, ids)} />
          ))}
        </Pie>
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}
