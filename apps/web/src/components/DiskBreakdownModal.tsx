'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  EmptyState,
  IconButton,
  Modal,
  RefreshIcon,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';

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

/**
 * Разбор занятого панелью места.
 *
 * Окно построено на нативном `<dialog>` через {@link Modal}: рукописная
 * подложка из `<div>` не давала ни ловушки фокуса, ни верхнего слоя. Цвета
 * полосок здесь категориальные — они лишь разделяют соседние группы и ничего
 * не оценивают (§5).
 */
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
  const [data, setData] = useState<DiskUsage | null>(initialData);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setData(initialData);
  }, [open, initialData]);

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
            { label: 'Депо Squad', bytes: data.depot_volume_bytes, tone: 'depot' as const },
            { label: 'Saved (все серверы)', bytes: data.saved_total_bytes, tone: 'saved' as const },
            { label: 'Конфигурации', bytes: data.configs_bytes, tone: 'configs' as const },
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
          { label: 'Архив аудита', bytes: data.audit_archive_bytes, tone: 'misc' as const },
        ].sort((a, b) => b.bytes - a.bytes);

        const result: Group[] = [{ title: 'Squad', rows: squad }];
        if (images.length > 0) result.push({ title: 'Образы Docker', rows: images });
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
    <Modal
      open
      onClose={() => onOpenChange(false)}
      title="Что занимает панель"
      size="lg"
      closeLabel="Закрыть"
    >
      {data === null ? (
        loading ? (
          <Skeleton variant="row" count={5} label="Загрузка разбора диска" />
        ) : (
          <EmptyState
            title="Нет данных"
            description="Агент ещё не присылал разбор занятого места. Обновите позже."
          />
        )
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
            <div className="text-[13px]">
              Всего: <strong className="font-mono text-ink">{fmt(data.total_panel_bytes)}</strong>{' '}
              <span className="text-ink-3">·</span>{' '}
              <span className="font-mono">{data.panel_pct.toFixed(1)}%</span> диска{' '}
              <span className="text-ink-3">·</span>{' '}
              <span className="text-ink-3">обновлено {data.cache_age_seconds} сек назад</span>
            </div>
            <IconButton
              icon={<RefreshIcon className={loading ? 'size-4 animate-spin' : 'size-4'} />}
              label="Обновить"
              onClick={refresh}
              disabled={loading}
            />
          </div>

          <div className="space-y-4">
            {groups.map((group) => {
              const groupTotal = group.rows.reduce((sum, r) => sum + r.bytes, 0);
              return (
                <div key={group.title}>
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="text-[13px] font-semibold text-ink">{group.title}</span>
                    <span className="font-mono text-xs tabular-nums text-ink-3">
                      {fmt(groupTotal)}
                      {total > 0 ? (
                        <span className="ml-2">{((groupTotal / total) * 100).toFixed(1)}%</span>
                      ) : null}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {group.rows.map((row) => {
                      const pct = total > 0 ? (row.bytes / total) * 100 : 0;
                      return (
                        <li key={row.label} className="space-y-1">
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-[13px] text-ink-2" title={row.label}>
                              {row.label}
                            </span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-ink-3">
                              <span className="text-ink">{fmt(row.bytes)}</span>
                              <span className="ml-2">{pct.toFixed(1)}%</span>
                            </span>
                          </div>
                          <div className="h-1 w-full overflow-hidden rounded-full bg-raised">
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
              <div className="mb-2 text-[13px] font-semibold text-ink">По серверам (Saved)</div>
              <div className="rounded-card border border-line">
                <Table maxHeight="18rem" ariaLabel="Место, занятое каталогами Saved по серверам">
                  <TableHead>
                    <TableRow>
                      <Th>Сервер</Th>
                      <Th align="right">Saved</Th>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {sortedSaved.map((s) => (
                      <TableRow key={s.uuid} interactive>
                        <Td>
                          <Link href={`/servers/${s.uuid}`} className="font-mono text-accent">
                            {s.uuid.slice(0, 8)}
                          </Link>
                        </Td>
                        <Td numeric className="font-mono">
                          {fmt(s.bytes)}
                        </Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
