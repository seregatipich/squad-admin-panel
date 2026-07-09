'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import type { ReportListItem, ReportLiveView, ReportStatus } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  buildApiQuery,
  buildQueryString,
  formatDateTime,
  NOTE_MAX,
  parseFilters,
  playerLabel,
  STATUS_BADGE_CLASSES,
  STATUS_FILTERS,
  STATUS_LABELS,
  totalPages,
} from './helpers';

interface ReportListResponse {
  items: ReportListItem[];
  total: number;
  page: number;
  page_size: number;
}

function upsertReport(list: ReportListItem[], incoming: ReportListItem): ReportListItem[] {
  const index = list.findIndex((report) => report.id === incoming.id);
  if (index === -1) return list;
  const next = list.slice();
  next[index] = incoming;
  return next;
}

export function ReportsBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = parseFilters(searchParams);

  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [canHandle, setCanHandle] = useState(false);

  const navigate = useCallback(
    (partial: Partial<{ status: '' | ReportStatus; page: number }>) => {
      const next = { ...filters, ...partial, page: partial.page ?? 1 };
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { can_handle_reports?: boolean } | null) => {
        if (!cancelled) setCanHandle(me?.can_handle_reports ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const { status: filterStatus, page: filterPage } = filters;
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/reports?${buildApiQuery({ status: filterStatus, page: filterPage })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ReportListResponse;
      setReports(data.items);
      setTotal(data.total);
      setLastUpdate(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const onReportUpdated = useCallback(
    (event: { data: { report: ReportLiveView } }) => {
      if (filters.page !== 1) return;
      const incoming = event.data.report;
      setReports((prev) => {
        const current = prev.find((report) => report.id === incoming.id);
        if (!current) return prev;
        const matchesFilter = !filters.status || incoming.status === filters.status;
        if (!matchesFilter) return prev.filter((report) => report.id !== incoming.id);
        // The live event only carries ids; keep the resolved names already on screen.
        return upsertReport(prev, { ...current, ...incoming });
      });
      setLastUpdate(new Date());
    },
    [filters.page, filters.status],
  );
  useLiveSubscription('report.updated', onReportUpdated);

  const pages = totalPages(total);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Жалобы</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="text-sm text-neutral-400">
        Очередь модерации жалоб игроков, отправленных из игры или через панель.
      </p>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      <div className="flex gap-1">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value || 'all'}
            type="button"
            onClick={() => navigate({ status: filter.value })}
            className={`rounded px-2 py-0.5 text-xs ${
              filters.status === filter.value
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-neutral-500">Загрузка…</div>
      ) : reports.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-500">
          Жалоб не найдено.
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((report) => (
            <ReportCard key={report.id} report={report} canHandle={canHandle} onSaved={load} />
          ))}
        </div>
      )}

      {!loading && reports.length > 0 ? (
        <div className="flex items-center justify-between text-xs text-neutral-400">
          <span>
            Страница {filters.page} из {pages} ({total})
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={filters.page <= 1}
              onClick={() => navigate({ page: filters.page - 1 })}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
            >
              Назад
            </button>
            <button
              type="button"
              disabled={filters.page >= pages}
              onClick={() => navigate({ page: filters.page + 1 })}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
            >
              Вперёд
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReportCard({
  report,
  canHandle,
  onSaved,
}: {
  report: ReportListItem;
  canHandle: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<ReportStatus>(report.status);
  const [note, setNote] = useState(report.resolution_note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (status !== report.status) body.status = status;
      const trimmedNote = note.trim();
      if (trimmedNote !== (report.resolution_note ?? ''))
        body.resolution_note = trimmedNote || null;
      if (Object.keys(body).length === 0) {
        setEditing(false);
        return;
      }
      const res = await fetch(`/api/v1/reports/${report.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${errBody.error ?? 'unknown'}`);
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
            {report.server_slug ?? report.server_name ?? report.server_id.slice(0, 8)}
          </span>
          <span>{formatDateTime(report.created_at)}</span>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[report.status]}`}>
          {STATUS_LABELS[report.status]}
        </span>
      </div>

      <div className="text-sm">
        <PlayerRef id={report.reporter_player_id} name={report.reporter_name} />
        <span className="mx-1 text-neutral-600">→</span>
        <PlayerRef
          id={report.target_player_id}
          name={report.target_name}
          fallbackRaw={report.target_raw}
        />
      </div>

      <p className="whitespace-pre-wrap text-sm text-neutral-300">{report.body}</p>

      {report.handler_name || report.handler_player_id ? (
        <p className="text-xs text-neutral-500">
          Обработчик: {playerLabel(report.handler_player_id, report.handler_name)}
        </p>
      ) : null}

      {canHandle ? (
        editing ? (
          <div className="space-y-2 border-t border-neutral-900 pt-2">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ReportStatus)}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
            >
              {(Object.keys(STATUS_LABELS) as ReportStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="Заметка обработчика"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded border border-emerald-900 px-3 py-1 text-xs text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-400 hover:border-neutral-600"
              >
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600"
          >
            Обработать
          </button>
        )
      ) : null}
    </div>
  );
}

function PlayerRef({
  id,
  name,
  fallbackRaw,
}: {
  id: string | null;
  name: string | null;
  fallbackRaw?: string | null;
}) {
  if (id) {
    return (
      <Link href={`/players/${id}`} className="text-sky-400 hover:text-sky-300">
        {playerLabel(id, name)}
      </Link>
    );
  }
  return <span className="text-neutral-400">{playerLabel(id, name, fallbackRaw ?? null)}</span>;
}
