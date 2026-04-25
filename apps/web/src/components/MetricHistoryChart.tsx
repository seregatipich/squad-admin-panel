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

export type MetricKey = 'cpu' | 'ram' | 'disk' | 'net';

export interface MetricPoint {
  ts: number;
  cpu: number;
  ram_pct: number;
  disk_pct: number;
  rx: number;
  tx: number;
}

export default function MetricHistoryChart({
  metric,
  data,
}: {
  metric: MetricKey;
  data: MetricPoint[];
}) {
  const tickFmt = (t: number) => new Date(t).toLocaleTimeString();
  if (metric === 'cpu' || metric === 'ram' || metric === 'disk') {
    const dataKey = metric === 'cpu' ? 'cpu' : metric === 'ram' ? 'ram_pct' : 'disk_pct';
    const color = metric === 'cpu' ? '#10b981' : metric === 'ram' ? '#3b82f6' : '#a78bfa';
    return (
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" />
          <XAxis dataKey="ts" tickFormatter={tickFmt} stroke="#666" minTickGap={48} />
          <YAxis domain={[0, 100]} unit="%" stroke="#666" />
          <Tooltip
            contentStyle={{ background: '#0a0a0a', border: '1px solid #333' }}
            labelFormatter={(t) => new Date(t as number).toISOString()}
            formatter={(v) => (typeof v === 'number' ? `${v.toFixed(2)}%` : String(v))}
          />
          <Area type="monotone" dataKey={dataKey} stroke={color} fill={color} fillOpacity={0.2} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#222" />
        <XAxis dataKey="ts" tickFormatter={tickFmt} stroke="#666" minTickGap={48} />
        <YAxis stroke="#666" tickFormatter={(v: number) => `${(v / 1024).toFixed(0)} KB/s`} />
        <Tooltip
          contentStyle={{ background: '#0a0a0a', border: '1px solid #333' }}
          labelFormatter={(t) => new Date(t as number).toISOString()}
          formatter={(v, name) => [
            typeof v === 'number' ? `${(v / 1024).toFixed(2)} KB/s` : String(v),
            name === 'rx' ? 'Вход' : 'Выход',
          ]}
        />
        <Area type="monotone" dataKey="rx" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
        <Area type="monotone" dataKey="tx" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
