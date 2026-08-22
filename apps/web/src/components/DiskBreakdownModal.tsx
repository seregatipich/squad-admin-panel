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

  type Row = {
    label: string;
    bytes: number;
    tone: 'depot' | 'saved' | 'configs' | 'image' | 'misc';
  };
  type Group = { title: string; rows: Row[] };

  const groups: Group[] = data
    ? (() => {
        // Squad bucket — depot volume (only once; the named volume IS the
        // depot, so don't list it twice), saved, and configs.
        const squad: Row[] = (
          [
            { label: 'Squad depot', bytes: data.depot_volume_bytes, tone: 'depot' as const },
            { label: 'Saved (все серверы)', bytes: data.saved_total_bytes, tone: 'saved' as const },
            { label: 'Configs', bytes: data.configs_bytes, tone: 'configs' as const },
          ] satisfies Row[]
        ).sort((a, b) => b.bytes - a.bytes);

        // Volumes that aren't the depot (postgres/redis/caddy named
        // volumes). The depot is already accounted for in the Squad bucket.
        const otherVolumes: Row[] = data.docker_volumes
          .filter((v) => v.bytes !== data.depot_volume_bytes || v.name !== 'squad-depot')
          .map((v) => ({ label: `volume:${v.name}`, bytes: v.bytes, tone: 'misc' as const }))
          .sort((a, b) => b.bytes - a.bytes);

        const images: Row[] = data.docker_images
          .map((img) => ({
            label: `${img.repository}:${img.tag}`,
            bytes: img.bytes,
            tone: 'image' as const,
          }))
          .sort((a, b) => b.bytes - a.bytes);

        const misc: Row[] = [
          ...otherVolumes,
          { label: 'Audit archive', bytes: data.audit_archive_bytes, tone: 'misc' as const },
        ].sort((a, b) => b.bytes - a.bytes);

        const result: Group[] = [{ title: 'Squad', rows: squad }];
        if (images.length > 0) result.push({ title: 'Docker images', rows: images });
        if (misc.length > 0) result.push({ title: 'Прочее', rows: misc });
        return result;
      })()
    : [];

  const total = data?.total_panel_bytes ?? 0;
  const sortedSaved = data ? [...data.saved_per_server].sort((a, b) => b.bytes - a.bytes) : [];

  const toneClass = (tone: Row['tone']): string => {
    switch (tone) {
      case 'depot':
        return 'bg-purple-500';
      case 'saved':
        return 'bg-purple-400';
      case 'configs':
        return 'bg-purple-300';
      case 'image':
        return 'bg-sky-500';
      default:
        return 'bg-neutral-500';
    }
  };

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

            <div className="space-y-4">
              {groups.map((group) => {
                const groupTotal = group.rows.reduce((sum, r) => sum + r.bytes, 0);
                return (
                  <div key={group.title}>
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                        {group.title}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-neutral-500">
                        {fmt(groupTotal)}
                        {total > 0 ? (
                          <span className="ml-2 text-neutral-500">
                            {((groupTotal / total) * 100).toFixed(1)}%
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {group.rows.map((row) => {
                        const pct = total > 0 ? (row.bytes / total) * 100 : 0;
                        return (
                          <li key={row.label} className="space-y-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="truncate text-neutral-200" title={row.label}>
                                {row.label}
                              </span>
                              <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-400">
                                <span className="text-neutral-200">{fmt(row.bytes)}</span>
                                <span className="ml-2 text-neutral-500">{pct.toFixed(1)}%</span>
                              </span>
                            </div>
                            <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-900">
                              <div
                                className={`h-full ${toneClass(row.tone)}`}
                                style={{ width: `${Math.min(100, pct)}%` }}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
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
