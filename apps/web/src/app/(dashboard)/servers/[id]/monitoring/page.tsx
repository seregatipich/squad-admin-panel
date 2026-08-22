'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { MetricsChart } from '@/components/MetricsChart';
import { Button, InlineBanner, PageContainer, SegmentedControl, Skeleton } from '@/components/ui';

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

export default function MonitoringPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [points, setPoints] = useState<MetricsPoint[]>([]);
  const [range, setRange] = useState<Range>('1h');
  const [err, setErr] = useState<string | null>(null);
  /**
   * Только первое обращение к серверу показывает заглушки: опрос раз в 30
   * секунд иначе схлопывал бы готовые графики в мерцающие прямоугольники.
   */
  const [firstLoad, setFirstLoad] = useState(true);

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
    } finally {
      setFirstLoad(false);
    }
  }, [id, range]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

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
            <Button size="sm" onClick={() => void load()}>
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
            color="#bf5af2"
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
