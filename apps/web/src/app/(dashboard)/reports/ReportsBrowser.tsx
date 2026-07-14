'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import type {
  ReportEvidenceItem,
  ReportListItem,
  ReportLiveView,
  ReportStatus,
} from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  ACTION_LABELS,
  actionTypeBadge,
  buildApiQuery,
  buildQueryString,
  evidenceBadgeLabel,
  evidenceLabel,
  formatDateTime,
  groupPendingByTarget,
  isExternalLinkEvidence,
  isImageEvidence,
  isValidBanLength,
  isVideoEvidence,
  NOTE_MAX,
  NOTIFY_TEMPLATE_LABELS,
  parseFilters,
  playerLabel,
  REASON_MAX,
  type ReportActionType,
  type ReporterNotifyTemplate,
  type ReportTargetGroup,
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

interface LinkedModerationAction {
  id: string;
  action_type: string;
  reason: string | null;
  context: Record<string, unknown>;
  report_id: string | null;
  created_at: string | null;
  reverted_at: string | null;
  server: { id: string; name: string | null } | null;
  author:
    | { kind: 'player'; id: string; name: string | null }
    | { kind: 'system'; label: string | null };
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

  // Pending queue: group reports sharing a target into a single block with a
  // mass-resolve action (REPORT-3, #113 P2). Only meaningful with 2+ reports
  // on the same target; singletons render as regular cards.
  const { grouped } = groupPendingByTarget(reports);
  const multiGroups = grouped.filter((g) => g.reports.length > 1);
  const groupedTargetIds = new Set(multiGroups.map((g) => g.target_player_id));
  const showGroups = filters.status === 'pending' && multiGroups.length > 0;
  const renderedGroupTargets = new Set<string>();

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
          {reports.map((report) => {
            if (
              showGroups &&
              report.target_player_id &&
              groupedTargetIds.has(report.target_player_id)
            ) {
              if (renderedGroupTargets.has(report.target_player_id)) return null;
              renderedGroupTargets.add(report.target_player_id);
              const group = multiGroups.find((g) => g.target_player_id === report.target_player_id);
              if (!group) return null;
              return (
                <ReportGroupBlock
                  key={group.target_player_id}
                  group={group}
                  canHandle={canHandle}
                  onSaved={load}
                />
              );
            }
            return (
              <ReportCard key={report.id} report={report} canHandle={canHandle} onSaved={load} />
            );
          })}
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

/**
 * A "N жалоб на игрока X" block for the pending queue (REPORT-3, #113 P2):
 * groups every pending/in-review report against one target under a single
 * "Закрыть группу" action that resolves them all in one request, each still
 * getting its own audit entry server-side.
 */
function ReportGroupBlock({
  group,
  canHandle,
  onSaved,
}: {
  group: ReportTargetGroup;
  canHandle: boolean;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function closeGroup() {
    const note = window.prompt('Заметка для закрытия группы жалоб (обязательна):', '');
    if (note === null) return;
    const trimmed = note.trim();
    if (!trimmed) {
      setError('Нужна заметка для закрытия группы.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/reports/bulk-resolve', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_player_id: group.target_player_id,
          status: 'resolved',
          resolution_note: trimmed,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${body.error ?? 'unknown'}`);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-amber-900/60 bg-amber-950/10 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-amber-200">
          {group.reports.length} жалоб на игрока{' '}
          {playerLabel(group.target_player_id, group.target_name)}
        </h3>
        {canHandle ? (
          <button
            type="button"
            onClick={closeGroup}
            disabled={busy}
            className="rounded border border-amber-800 px-3 py-1 text-xs text-amber-300 hover:border-amber-600 disabled:opacity-40"
          >
            {busy ? 'Закрытие…' : 'Закрыть группу'}
          </button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <div className="space-y-3">
        {group.reports.map((report) => (
          <ReportCard key={report.id} report={report} canHandle={canHandle} onSaved={onSaved} />
        ))}
      </div>
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

  const [actionModal, setActionModal] = useState<ReportActionType | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [banLength, setBanLength] = useState('0');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [actionsOpen, setActionsOpen] = useState(false);
  const [actions, setActions] = useState<LinkedModerationAction[] | null>(null);
  const [actionsLoading, setActionsLoading] = useState(false);

  const [notifyTemplate, setNotifyTemplate] = useState<ReporterNotifyTemplate>('in_review');
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

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

  function openActionModal(type: ReportActionType) {
    setActionModal(type);
    setActionReason(report.body.slice(0, REASON_MAX));
    setBanLength('0');
    setActionError(null);
  }

  const loadActions = useCallback(async () => {
    setActionsLoading(true);
    try {
      const res = await fetch(`/api/v1/reports/${report.id}/actions`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { actions: LinkedModerationAction[] };
      setActions(body.actions);
    } catch {
      setActions([]);
    } finally {
      setActionsLoading(false);
    }
  }, [report.id]);

  function toggleActions() {
    const next = !actionsOpen;
    setActionsOpen(next);
    if (next && actions === null) void loadActions();
  }

  async function submitAction() {
    if (!actionModal) return;
    const trimmedReason = actionReason.trim();
    if (!trimmedReason) {
      setActionError('Укажите причину.');
      return;
    }
    if (actionModal === 'ban' && !isValidBanLength(banLength)) {
      setActionError('Некорректный срок бана.');
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const body: Record<string, unknown> = { action_type: actionModal, reason: trimmedReason };
      if (actionModal === 'ban') body.ban_length = banLength.trim() || '0';
      const res = await fetch(`/api/v1/reports/${report.id}/actions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${errBody.error ?? 'unknown'}`);
      }
      setActionModal(null);
      if (actionsOpen) void loadActions();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  async function submitNotify() {
    setNotifyBusy(true);
    setNotifyMsg(null);
    try {
      const res = await fetch(`/api/v1/reports/${report.id}/notify-reporter`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: notifyTemplate }),
      });
      if (res.status === 409) {
        setNotifyMsg({ kind: 'err', text: 'Репортёр не в сети' });
        return;
      }
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${errBody.error ?? 'unknown'}`);
      }
      setNotifyMsg({ kind: 'ok', text: 'Уведомление отправлено.' });
    } catch (e) {
      setNotifyMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setNotifyBusy(false);
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
        <div className="flex items-center gap-2">
          {report.evidence.length > 0 ? (
            <span
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-300"
              title="Есть вложения"
            >
              {evidenceBadgeLabel(report.evidence)}
            </span>
          ) : null}
          <span className={`rounded px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[report.status]}`}>
            {STATUS_LABELS[report.status]}
          </span>
        </div>
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

      {report.evidence.length > 0 ? <ReportEvidenceBlock evidence={report.evidence} /> : null}

      {report.handler_name || report.handler_player_id ? (
        <p className="text-xs text-neutral-500">
          Обработчик: {playerLabel(report.handler_player_id, report.handler_name)}
        </p>
      ) : null}

      {canHandle ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-900 pt-2">
          {report.target_player_id
            ? (Object.keys(ACTION_LABELS) as ReportActionType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => openActionModal(type)}
                  className={`rounded border px-3 py-1 text-xs hover:opacity-80 ${
                    type === 'ban'
                      ? 'border-red-900 text-red-300'
                      : type === 'kick'
                        ? 'border-amber-900 text-amber-300'
                        : 'border-sky-900 text-sky-300'
                  }`}
                >
                  {ACTION_LABELS[type]}
                </button>
              ))
            : null}
          {report.reporter_player_id ? (
            <>
              <select
                value={notifyTemplate}
                onChange={(e) => setNotifyTemplate(e.target.value as ReporterNotifyTemplate)}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
              >
                {(Object.keys(NOTIFY_TEMPLATE_LABELS) as ReporterNotifyTemplate[]).map((tpl) => (
                  <option key={tpl} value={tpl}>
                    {NOTIFY_TEMPLATE_LABELS[tpl]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={submitNotify}
                disabled={notifyBusy}
                className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600 disabled:opacity-40"
              >
                {notifyBusy ? 'Отправка…' : 'Уведомить репортёра'}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={toggleActions}
            className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600"
          >
            Связанные действия
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600"
          >
            Обработать
          </button>
        </div>
      ) : null}

      {notifyMsg ? (
        <div
          className={`rounded border p-2 text-xs ${
            notifyMsg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {notifyMsg.text}
        </div>
      ) : null}

      {actionsOpen ? (
        <div className="space-y-1 border-t border-neutral-900 pt-2">
          {actionsLoading ? (
            <p className="text-xs text-neutral-500">Загрузка действий…</p>
          ) : !actions || actions.length === 0 ? (
            <p className="text-xs text-neutral-600">Связанных действий пока нет.</p>
          ) : (
            <ul className="space-y-1">
              {actions.map((action) => (
                <li
                  key={action.id}
                  className="flex flex-wrap items-center gap-2 text-xs text-neutral-400"
                >
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-200">
                    {actionTypeBadge(action.action_type)}
                  </span>
                  <span>{formatDateTime(action.created_at)}</span>
                  <span className="text-neutral-500">
                    {action.author.kind === 'player' ? action.author.name : action.author.label}
                  </span>
                  {action.reason ? <span className="text-neutral-300">{action.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {editing ? (
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
      ) : null}

      {actionModal ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="mt-16 w-full max-w-md rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{ACTION_LABELS[actionModal]}</h2>
              <button
                type="button"
                onClick={() => setActionModal(null)}
                className="text-sm text-neutral-400 hover:text-neutral-200"
              >
                Закрыть
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor={`action-reason-${report.id}`}
                  className="mb-1 block text-xs text-neutral-500"
                >
                  Причина
                </label>
                <textarea
                  id={`action-reason-${report.id}`}
                  value={actionReason}
                  onChange={(e) => setActionReason(e.target.value)}
                  rows={3}
                  maxLength={REASON_MAX}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
                />
              </div>
              {actionModal === 'ban' ? (
                <div>
                  <label
                    htmlFor={`action-ban-length-${report.id}`}
                    className="mb-1 block text-xs text-neutral-500"
                  >
                    Срок бана (0 = навсегда, напр. 3d, 12h)
                  </label>
                  <input
                    id={`action-ban-length-${report.id}`}
                    type="text"
                    value={banLength}
                    onChange={(e) => setBanLength(e.target.value)}
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm font-mono focus:border-neutral-600 focus:outline-none"
                  />
                </div>
              ) : null}
              {actionError ? <p className="text-xs text-red-400">{actionError}</p> : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={submitAction}
                  disabled={actionBusy}
                  className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
                >
                  {actionBusy ? 'Отправка…' : ACTION_LABELS[actionModal]}
                </button>
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  disabled={actionBusy}
                  className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
                >
                  Отмена
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReportEvidenceBlock({ evidence }: { evidence: ReportEvidenceItem[] }) {
  return (
    <div className="space-y-2 border-t border-neutral-900 pt-2">
      <h3 className="text-xs uppercase tracking-widest text-neutral-500">Доказательства</h3>
      <div className="flex flex-wrap gap-3">
        {evidence.map((item) => (
          <div key={item.id} className="max-w-[220px] space-y-1">
            {isImageEvidence(item) ? (
              <img
                src={`/api/v1/media/${item.id}/stream`}
                alt={evidenceLabel(item)}
                className="max-h-40 rounded border border-neutral-800 object-cover"
              />
            ) : isVideoEvidence(item) ? (
              // biome-ignore lint/a11y/useMediaCaption: user-submitted evidence has no captions
              <video
                controls
                src={`/api/v1/media/${item.id}/stream`}
                className="max-h-40 rounded border border-neutral-800"
              />
            ) : isExternalLinkEvidence(item) && item.external_url ? (
              <a
                href={item.external_url}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-xs text-sky-400 hover:text-sky-300"
              >
                {evidenceLabel(item)}
              </a>
            ) : null}
          </div>
        ))}
      </div>
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
