'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Button, EmptyState, InlineBanner, Modal, Skeleton } from '@/components/ui';
import type { MetricKey, MetricPoint } from './MetricHistoryChart';

interface UnpackedMetrics {
  cpu_percent: number;
  ram_used_bytes: number;
  disk_used_bytes: number;
  net_rx_bytes_per_sec: number;
  net_tx_bytes_per_sec: number;
}

function unpackHostMetrics(v: number[]): UnpackedMetrics {
  return {
    cpu_percent: (v[0] ?? 0) / 100,
    ram_used_bytes: v[1] ?? 0,
    disk_used_bytes: v[2] ?? 0,
    net_rx_bytes_per_sec: v[3] ?? 0,
    net_tx_bytes_per_sec: v[4] ?? 0,
  };
}

const Chart = dynamic(() => import('./MetricHistoryChart'), {
  ssr: false,
  loading: () => <Skeleton variant="card" label="Загрузка графика" />,
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

/**
 * История метрики хоста за сутки.
 *
 * Окно — {@link Modal} на нативном `<dialog>`; состояния экрана отвечают на
 * все четыре вопроса §8: заглушка на время запроса, `EmptyState` при пустой
 * истории и `InlineBanner` с «Повторить» при отказе. Повтор перезапускает тот
 * же запрос через счётчик попыток, а не перемонтирование окна.
 */
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
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` телом эффекта не читается — он и есть команда «выполнить запрос заново», которую даёт кнопка «Повторить»
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
  }, [open, ramTotalBytes, diskTotalBytes, attempt]);

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${METRIC_TITLES[metric]} · 24 часа`}
      size="lg"
      closeLabel="Закрыть"
    >
      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить историю"
          description={error}
          action={
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </Button>
          }
        />
      ) : data === null ? (
        <Skeleton variant="card" label="Загрузка истории метрики" />
      ) : data.length === 0 ? (
        <EmptyState
          title="Нет данных за 24 часа"
          description="Агент не присылал измерений за последние сутки."
        />
      ) : (
        <Chart metric={metric} data={data} />
      )}
    </Modal>
  );
}
