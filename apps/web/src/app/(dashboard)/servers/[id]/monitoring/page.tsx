'use client';

import { use, useState } from 'react';
import { MetricsChart } from '@/components/MetricsChart';
import { Button, InlineBanner, PageContainer, SegmentedControl, Skeleton } from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { CHART_SERIES } from '@/lib/chart-tokens';
import { usePolledResource } from '@/lib/use-polled-resource';

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

/** Подписи периода — рядом с сегментированным переключателем, а не в разметке. */
const RANGE_ITEMS = [
  { value: '1h', label: '1 ч' },
  { value: '6h', label: '6 ч' },
  { value: '24h', label: '24 ч' },
];

const POLL_MS = 30_000;
const METRICS_TIMEOUT_MS = 30_000;
const NO_POINTS: MetricsPoint[] = [];

export default function MonitoringPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [range, setRange] = useState<Range>('1h');
  // Опрос раз в 30 секунд не схлопывает готовые графики в заглушки: хук
  // оставляет прежние данные, пока идёт повторный запрос, а заглушки видны
  // только до первого ответа по этому серверу и периоду.
  const metrics = usePolledResource<{ points: MetricsPoint[] }>(
    `${id}:${range}`,
    (signal) => {
      const since = new Date(Date.now() - RANGE_MS[range]).toISOString();
      return apiFetch<{ points: MetricsPoint[] }>(
        `/api/v1/servers/${id}/metrics?since=${encodeURIComponent(since)}`,
        { signal, timeoutMs: METRICS_TIMEOUT_MS },
      );
    },
    { intervalMs: POLL_MS },
  );
  const points = metrics.data?.points ?? NO_POINTS;
  const err = metrics.errorMessage;
  const firstLoad = metrics.loading;

  return (
    // Графики нарисованы в фиксированном viewBox 600×160 и растягиваются без
    // сохранения пропорций, поэтому ширина чтения, а не операционная.
    <PageContainer width="reading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Заголовок страницы — имя сервера в layout раздела; здесь h2. */}
        <h2 className="text-[17px] font-semibold text-ink">Мониторинг</h2>
        <SegmentedControl
          items={RANGE_ITEMS}
          value={range}
          onChange={(value) => setRange(value as Range)}
          ariaLabel="Период"
        />
      </div>

      {err ? (
        <InlineBanner
          tone="crit"
          title="Метрики не загрузились"
          description={err}
          action={
            <Button size="sm" onClick={() => void metrics.refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {firstLoad ? (
        <Skeleton variant="card" count={3} label="Загружаем метрики сервера" />
      ) : (
        <div className="space-y-4">
          <MetricsChart
            points={points.map((p) => ({ timestamp: p.timestamp, value: p.cpu_percent }))}
            label="CPU"
            unit="%"
            color="#409cff"
            maxY={100}
            formatValue={(v) => `${v.toFixed(1)}`}
          />

          <MetricsChart
            points={points.map((p) => ({ timestamp: p.timestamp, value: p.mem_bytes }))}
            label="Память"
            unit=""
            color={CHART_SERIES.memory}
          />

          {points.some((p) => p.tickrate !== undefined) && (
            <MetricsChart
              points={points
                .filter((p) => p.tickrate !== undefined)
                .map((p) => ({ timestamp: p.timestamp, value: p.tickrate as number }))}
              label="Tickrate"
              unit=""
              color="#30d158"
              formatValue={(v) => `${v.toFixed(0)}`}
            />
          )}
        </div>
      )}
    </PageContainer>
  );
}
