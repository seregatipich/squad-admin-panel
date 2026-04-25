'use client';

import { unpackHostMetrics } from '@squad/shared-config';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { MetricKey, MetricPoint } from './MetricHistoryChart';

const Chart = dynamic(() => import('./MetricHistoryChart'), {
  ssr: false,
  loading: () => (
    <div className="flex h-72 items-center justify-center text-neutral-500">Загрузка графика…</div>
  ),
});

const METRIC_TITLES: Record<MetricKey, string> = {
  cpu: 'CPU',
  ram: 'RAM',
  disk: 'Диск',
  net: 'Сеть',
};

interface HistoryResponse {
  ts: number[];
  v: number[][];
}

export type { MetricKey };

export function MetricHistoryModal(props: {
  open: boolean;
  onClose: () => void;
  metric: MetricKey;
  ramTotalBytes: number;
  diskTotalBytes: number;
}) {
  const { open, onClose, metric, ramTotalBytes, diskTotalBytes } = props;
  const [data, setData] = useState<MetricPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setError(null);
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch('/api/v1/host/metrics/history?seconds=86400', {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as HistoryResponse;
        const points: MetricPoint[] = body.ts.map((t, i) => {
          const m = unpackHostMetrics(body.v[i] ?? []);
          return {
            ts: t,
            cpu: m.cpu_percent,
            ram_pct: ramTotalBytes > 0 ? (m.ram_used_bytes / ramTotalBytes) * 100 : 0,
            disk_pct: diskTotalBytes > 0 ? (m.disk_used_bytes / diskTotalBytes) * 100 : 0,
            rx: m.net_rx_bytes_per_sec,
            tx: m.net_tx_bytes_per_sec,
          };
        });
        setData(points);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setError((e as Error).message);
      }
    })();
    return () => controller.abort();
  }, [open, ramTotalBytes, diskTotalBytes]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className="w-[90vw] max-w-4xl rounded-lg border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-300">
            {METRIC_TITLES[metric]} · 24 часа
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-200"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>
        {error ? (
          <div className="text-red-400">Ошибка: {error}</div>
        ) : data === null ? (
          <div className="flex h-72 items-center justify-center text-neutral-500">Загрузка…</div>
        ) : data.length === 0 ? (
          <div className="flex h-72 items-center justify-center text-neutral-500">
            Нет данных за 24 часа
          </div>
        ) : (
          <Chart metric={metric} data={data} />
        )}
      </div>
    </div>
  );
}
