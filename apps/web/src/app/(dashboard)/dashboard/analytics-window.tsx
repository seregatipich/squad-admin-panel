'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Select, Toolbar } from '@/components/ui';
import {
  ANALYTICS_WINDOW_PRESETS,
  analyticsWindowRange,
  buildAnalyticsWindowQuery,
} from '@/lib/analytics-window';

export interface AnalyticsServerOption {
  id: string;
  display_name: string;
}

/*
 * Ссылка на выгрузку остаётся обычным `<a download>`, а не `ButtonLink`:
 * `next/link` перехватывает клик и уводит в клиентскую навигацию, из-за чего
 * файл не скачивается. Классы повторяют вторичную кнопку размера `sm` (§6).
 */
export const DOWNLOAD_LINK_CLASS =
  'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

/** Hours of the day marked on the 24-bar hourly charts. */
export const AXIS_HOURS = [0, 6, 12, 18];

export interface AnalyticsWindow<T> {
  serverId: string;
  setServerId: (serverId: string) => void;
  windowDays: number;
  setWindowDays: (days: number) => void;
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Window of the last successful load, for the CSV link; null until the first one. */
  range: { from: string; to: string } | null;
  csvHref: string;
  load: () => Promise<void>;
  exportJson: (fileName: string) => void;
}

/**
 * Loads an analytics endpoint for a server and a rolling window and owns the
 * state both analytics panels share.
 *
 * `analyticsWindowRange()` reads the current clock, so it is recomputed on every
 * `load()` call (mount, server/period change, "Повторить") rather than once per
 * `windowDays` change: otherwise a retry or a server switch would replay a
 * stale `to`, and the CSV link would carry it too. `range` is committed only
 * after a successful load, past the first client render, so the server-rendered
 * HTML and the initial client render agree.
 *
 * A request counter drops the response of any request that is no longer the
 * newest, so fast server/period switches cannot let a slower, older answer
 * overwrite a fresher one (ANALYTICS-538); `loading` clears only when the
 * newest request settles.
 *
 * @param endpoint API path without a query string, e.g. `/api/v1/analytics/votes`.
 * @param defaultDays Initially selected window length in days.
 */
export function useAnalyticsWindow<T>(endpoint: string, defaultDays: number): AnalyticsWindow<T> {
  const [serverId, setServerId] = useState<string>('');
  const [windowDays, setWindowDays] = useState<number>(defaultDays);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const freshRange = analyticsWindowRange(windowDays);
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const query = buildAnalyticsWindowQuery({
        serverId: serverId || null,
        from: freshRange.from,
        to: freshRange.to,
      });
      const res = await fetch(`${endpoint}${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`ошибка ${res.status}`);
      const body = (await res.json()) as T;
      if (requestRef.current !== requestId) return;
      setData(body);
      setRange(freshRange);
    } catch (e) {
      if (requestRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [endpoint, serverId, windowDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const csvHref = `${endpoint}${buildAnalyticsWindowQuery({
    serverId: serverId || null,
    from: range?.from,
    to: range?.to,
    format: 'csv',
  })}`;

  const exportJson = useCallback(
    (fileName: string) => {
      if (!data) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // The download can start asynchronously in some browsers; revoking in
      // the same tick as click() risks an empty or cancelled download there.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    [data],
  );

  return {
    serverId,
    setServerId,
    windowDays,
    setWindowDays,
    data,
    loading,
    error,
    range,
    csvHref,
    load,
    exportJson,
  };
}

/** Server and period selects plus the CSV/JSON export actions shared by the analytics panels. */
export function AnalyticsToolbar<T>({
  servers,
  window: state,
  jsonFileName,
}: {
  servers: AnalyticsServerOption[];
  window: AnalyticsWindow<T>;
  jsonFileName: string;
}) {
  const serverSelectId = useId();
  const windowSelectId = useId();
  return (
    <Toolbar
      filters={
        <>
          <label className="sr-only" htmlFor={serverSelectId}>
            Сервер
          </label>
          <div className="w-44">
            <Select
              id={serverSelectId}
              size="sm"
              value={state.serverId}
              onChange={(e) => state.setServerId(e.target.value)}
            >
              <option value="">Все серверы</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </Select>
          </div>
          <label className="sr-only" htmlFor={windowSelectId}>
            Период
          </label>
          <div className="w-28">
            <Select
              id={windowSelectId}
              size="sm"
              value={state.windowDays}
              onChange={(e) => state.setWindowDays(Number(e.target.value))}
            >
              {ANALYTICS_WINDOW_PRESETS.map((preset) => (
                <option key={preset.days} value={preset.days}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </div>
        </>
      }
      summary={state.loading ? 'Обновляем…' : undefined}
      actions={
        <>
          <a href={state.csvHref} download className={DOWNLOAD_LINK_CLASS}>
            CSV
          </a>
          <Button size="sm" onClick={() => state.exportJson(jsonFileName)} disabled={!state.data}>
            JSON
          </Button>
        </>
      }
    />
  );
}
