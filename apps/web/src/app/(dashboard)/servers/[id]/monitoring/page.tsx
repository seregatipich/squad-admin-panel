'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { MetricsChart } from '@/components/MetricsChart';

interface MetricsPoint {
  timestamp: string;
  cpu_percent: number;
  mem_bytes: number;
  mem_percent: number;
  pids: number;
  tickrate?: number;
}

type Range = '1h' | '6h' | '24h';

const RANGE_MS: Record<Range, number> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
};

const POLL_MS = 30_000;

export default function MonitoringPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [points, setPoints] = useState<MetricsPoint[]>([]);
  const [range, setRange] = useState<Range>('1h');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const since = new Date(Date.now() - RANGE_MS[range]).toISOString();
      const r = await fetch(`/api/v1/servers/${id}/metrics?since=${encodeURIComponent(since)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { points: MetricsPoint[] };
      setPoints(data.points);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id, range]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-neutral-100">Мониторинг</h1>
        <div className="flex gap-1">
          {(['1h', '6h', '24h'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded px-2 py-1 text-xs ${
                range === r
                  ? 'bg-sky-700 text-white'
                  : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {r === '1h' ? '1ч' : r === '6h' ? '6ч' : '24ч'}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <div className="space-y-4">
        <MetricsChart
          points={points.map((p) => ({ timestamp: p.timestamp, value: p.cpu_percent }))}
          label="CPU"
          unit="%"
          color="#38bdf8"
          maxY={100}
          formatValue={(v) => `${v.toFixed(1)}`}
        />

        <MetricsChart
          points={points.map((p) => ({ timestamp: p.timestamp, value: p.mem_bytes }))}
          label="Память"
          unit=""
          color="#a78bfa"
        />

        {points.some((p) => p.tickrate !== undefined) && (
          <MetricsChart
            points={points
              .filter((p) => p.tickrate !== undefined)
              .map((p) => ({ timestamp: p.timestamp, value: p.tickrate as number }))}
            label="Tickrate"
            unit=""
            color="#34d399"
            formatValue={(v) => `${v.toFixed(0)}`}
          />
        )}
      </div>
    </div>
  );
}
