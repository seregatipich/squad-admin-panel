'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';

interface DiskUsage {
  configs_bytes: number;
  saved_total_bytes: number;
  saved_per_server: { uuid: string; bytes: number }[];
  depot_volume_bytes: number;
  docker_volumes: { name: string; bytes: number }[];
  docker_images: { repository: string; tag: string; bytes: number }[];
  audit_archive_bytes: number;
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  computed_at: string;
  cache_age_seconds: number;
  panel_pct: number;
  other_pct: number;
}

const fmt = (b: number): string => {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
};

export function DiskBreakdownModal({
  open,
  onOpenChange,
  initialData,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialData: DiskUsage | null;
  onRefresh: () => Promise<DiskUsage | null>;
}): React.JSX.Element | null {
  const titleId = useId();
  const [data, setData] = useState<DiskUsage | null>(initialData);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setData(initialData);
  }, [open, initialData]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  async function refresh() {
    if (loading) return;
    setLoading(true);
    try {
      const fresh = await onRefresh();
      if (fresh) setData(fresh);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const rows = data
    ? [
        ['configs', data.configs_bytes] as const,
        ['saved (все сервера)', data.saved_total_bytes] as const,
        ['squad-depot', data.depot_volume_bytes] as const,
        ...data.docker_volumes.map((v) => [`volume:${v.name}`, v.bytes] as const),
        ...data.docker_images.map(
          (img) => [`image:${img.repository}:${img.tag}`, img.bytes] as const,
        ),
        ['audit archive', data.audit_archive_bytes] as const,
      ]
        .slice()
        .sort((a, b) => b[1] - a[1])
    : [];

  const sortedSaved = data ? [...data.saved_per_server].sort((a, b) => b.bytes - a.bytes) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={() => onOpenChange(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onOpenChange(false);
      }}
    >
      <div
        className="w-[90vw] max-w-2xl rounded-lg border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2
            id={titleId}
            className="text-sm font-semibold uppercase tracking-widest text-neutral-300"
          >
            Что занимает панель
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-neutral-400 hover:text-neutral-200"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        {data === null ? (
          <div className="flex h-32 items-center justify-center text-neutral-500">
            {loading ? 'Загрузка…' : 'Нет данных'}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3 border-b border-neutral-900 pb-3">
              <div className="text-sm">
                Всего:{' '}
                <strong className="font-mono text-neutral-100">
                  {fmt(data.total_panel_bytes)}
                </strong>{' '}
                <span className="text-neutral-500">·</span>{' '}
                <span className="font-mono">{data.panel_pct.toFixed(1)}%</span> диска{' '}
                <span className="text-neutral-500">·</span>{' '}
                <span className="text-neutral-400">
                  обновлено {data.cache_age_seconds} сек назад
                </span>
              </div>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:border-sky-700 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Обновить"
                title="Обновить"
              >
                <span className={`inline-block ${loading ? 'animate-spin' : ''}`}>↻</span>
              </button>
            </div>

            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                По типу
              </div>
              <ul className="space-y-0">
                {rows.map(([label, bytes]) => (
                  <li
                    key={label}
                    className="flex items-center justify-between gap-3 border-b border-neutral-900 py-1.5"
                  >
                    <span className="truncate text-neutral-200" title={label}>
                      {label}
                    </span>
                    <span className="font-mono tabular-nums text-neutral-300">{fmt(bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>

            {sortedSaved.length > 0 ? (
              <div>
                <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                  По серверам (saved)
                </div>
                <div className="max-h-72 overflow-y-auto rounded border border-neutral-900">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-neutral-950">
                      <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                        <th className="border-b border-neutral-900 px-3 py-1.5 font-medium">
                          Server
                        </th>
                        <th className="border-b border-neutral-900 px-3 py-1.5 text-right font-medium">
                          Saved
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-900">
                      {sortedSaved.map((s) => (
                        <tr key={s.uuid} className="hover:bg-neutral-900/40">
                          <td className="px-3 py-1.5">
                            <Link
                              href={`/servers/${s.uuid}`}
                              className="font-mono text-sky-400 hover:text-sky-300"
                            >
                              {s.uuid.slice(0, 8)}
                            </Link>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-neutral-300">
                            {fmt(s.bytes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
