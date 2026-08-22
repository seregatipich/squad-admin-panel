'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  PageContainer,
  PageHeader,
  Pagination,
  SegmentedControl,
  Select,
  Skeleton,
  StatusBadge,
  type StatusState,
  Textarea,
  TextInput,
  Toolbar,
} from '@/components/ui';
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
  isRecidivist,
  isValidBanLength,
  isVideoEvidence,
  NOTE_MAX,
  NOTIFY_TEMPLATE_LABELS,
  parseFilters,
  playerLabel,
  REASON_MAX,
  REPORTER_SPAM_LABEL,
  REPORTER_TRUSTED_LABEL,
  type ReportActionType,
  type ReporterNotifyTemplate,
  type ReportTargetGroup,
  recidivistBadgeLabel,
  STATUS_FILTERS,
  STATUS_LABELS,
  totalPages,
} from './helpers';
import { ReportsAnalytics } from './ReportsAnalytics';

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

interface BanAltWarningItem {
  player_id: string;
  name: string;
  link_type?: string;
  status?: string;
  confidence?: 'high';
  online: boolean;
  has_active_ban: boolean;
}

interface BanAltWarning {
  can_view_ips: boolean;
  confirmed_count: number;
  candidate_count: number;
  confirmed: BanAltWarningItem[];
  candidates: BanAltWarningItem[];
}

/**
 * Состояние жалобы в терминах индикаторов дизайн-системы.
 *
 * `in_review` и `rejected` делят тон `idle`: ни одна из этих жалоб не ждёт
 * действия оператора прямо сейчас, а различает их подпись бейджа — состояние
 * никогда не кодируется одним цветом (§5).
 */
const STATUS_STATE: Record<ReportStatus, StatusState> = {
  pending: 'warn',
  in_review: 'idle',
  resolved: 'good',
  rejected: 'idle',
};

const PAGINATION_LABELS = {
  previous: 'Назад',
  next: 'Вперёд',
  page: (page: number, of: number) => `Страница ${page} из ${of}`,
};

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
  const [view, setView] = useState<'queue' | 'analytics'>('queue');

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

  // Аналитике нужна вся ширина операционного экрана, очереди карточек — нет:
  // строка текста жалобы на 1600px читается хуже, чем на 1150px.
  return (
    <PageContainer width={view === 'analytics' ? 'full' : 'wide'}>
      <PageHeader
        title="Жалобы"
        subtitle="Очередь модерации жалоб игроков, отправленных из игры или через панель."
        status={<LiveIndicator lastUpdate={lastUpdate} />}
        actions={
          <SegmentedControl
            ariaLabel="Представление жалоб"
            value={view}
            onChange={(value) => setView(value as 'queue' | 'analytics')}
            items={[
              { value: 'queue', label: 'Очередь' },
              { value: 'analytics', label: 'Аналитика' },
            ]}
          />
        }
      />

      {view === 'analytics' ? <ReportsAnalytics /> : null}

      {view !== 'queue' ? null : (
        <>
          <Toolbar
            filters={
              <SegmentedControl
                ariaLabel="Статус жалобы"
                value={filters.status}
                onChange={(value) => navigate({ status: value as '' | ReportStatus })}
                items={STATUS_FILTERS.map((filter) => ({
                  value: filter.value,
                  label: filter.label,
                }))}
              />
            }
            summary={`Найдено: ${total}`}
          />

          {error ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить жалобы"
              description={error}
              action={
                <Button size="sm" onClick={() => void load()}>
                  Повторить
                </Button>
              }
            />
          ) : null}

          {loading ? (
            <Skeleton variant="card" count={3} label="Загрузка жалоб" />
          ) : reports.length === 0 ? (
            <Card padding="none">
              {filters.status ? (
                <EmptyState
                  variant="filtered"
                  title="Жалоб не найдено"
                  description="По выбранному статусу жалоб нет."
                  action={
                    <Button size="sm" onClick={() => navigate({ status: '' })}>
                      Сбросить фильтр
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="Жалоб нет"
                  description="Жалобы игроков появятся здесь сразу после отправки из игры или через панель."
                />
              )}
            </Card>
          ) : (
            <div className="space-y-4">
              {reports.map((report) => {
                if (
                  showGroups &&
                  report.target_player_id &&
                  groupedTargetIds.has(report.target_player_id)
                ) {
                  if (renderedGroupTargets.has(report.target_player_id)) return null;
                  renderedGroupTargets.add(report.target_player_id);
                  const group = multiGroups.find(
                    (g) => g.target_player_id === report.target_player_id,
                  );
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
                  <ReportCard
                    key={report.id}
                    report={report}
                    canHandle={canHandle}
                    onSaved={load}
                  />
                );
              })}
            </div>
          )}

          {!loading && reports.length > 0 && pages > 1 ? (
            <Pagination
              page={filters.page}
              pageCount={pages}
              onChange={(page) => navigate({ page })}
              labels={PAGINATION_LABELS}
              allowJump
            />
          ) : null}
        </>
      )}
    </PageContainer>
  );
}

/**
 * A "N жалоб на игрока X" block for the pending queue (REPORT-3, #113 P2):
 * groups every pending/in-review report against one target under a single
 * "Закрыть группу" action that resolves them all in one request, each still
 * getting its own audit entry server-side.
 *
 * Заметка закрытия спрашивается в модальном окне, а не через `window.prompt`:
 * системный запрос не поддаётся стилю, не показывает, какую именно группу
 * закрывают, и в браузере может быть отключён пользователем целиком.
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
  const [askNote, setAskNote] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  const targetLabel = playerLabel(group.target_player_id, group.target_name);

  async function closeGroup() {
    const trimmed = note.trim();
    if (!trimmed) {
      setNoteError('Нужна заметка для закрытия группы.');
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
      setAskNote(false);
      setNote('');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    /* Поверхность предупреждающего тона, а не `Card`: тон карточки задаётся
       её собственными `border-line`/`bg-surface`, и переопределение тех же
       свойств утилитами Tailwind разрешается порядком правил в готовом CSS,
       а не порядком классов здесь. */
    <section className="space-y-3 rounded-card border border-warn/40 bg-warn/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">
          {group.reports.length} жалоб на игрока {targetLabel}
        </h2>
        {canHandle ? (
          <Button
            size="sm"
            onClick={() => {
              setNoteError(null);
              setAskNote(true);
            }}
          >
            Закрыть группу
          </Button>
        ) : null}
      </div>

      {error ? <InlineBanner tone="crit" title="Группа не закрыта" description={error} /> : null}

      <div className="space-y-3">
        {group.reports.map((report) => (
          <ReportCard key={report.id} report={report} canHandle={canHandle} onSaved={onSaved} />
        ))}
      </div>

      {askNote ? (
        <Modal
          open
          onClose={() => setAskNote(false)}
          title="Закрыть группу жалоб"
          description={`Все жалобы на игрока ${targetLabel} будут помечены решёнными.`}
          size="sm"
          closeLabel="Отмена"
          dismissible={!busy}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAskNote(false)} disabled={busy}>
                Отмена
              </Button>
              <Button variant="primary" onClick={closeGroup} loading={busy}>
                Закрыть группу
              </Button>
            </>
          }
        >
          <FieldRow
            label="Заметка для закрытия группы"
            hint="Останется в журнале по каждой жалобе группы."
            error={noteError ?? undefined}
            required
          >
            <Textarea
              value={note}
              maxLength={NOTE_MAX}
              invalid={Boolean(noteError)}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(null);
              }}
            />
          </FieldRow>
        </Modal>
      ) : null}
    </section>
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
  const [banAltWarning, setBanAltWarning] = useState<BanAltWarning | null>(null);
  const [banAltWarningLoading, setBanAltWarningLoading] = useState(false);
  const [banAltWarningError, setBanAltWarningError] = useState<string | null>(null);
  const [selectedAltIds, setSelectedAltIds] = useState<string[]>([]);

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
    setBanAltWarning(null);
    setBanAltWarningError(null);
    setSelectedAltIds([]);
    if (type === 'ban' && report.target_player_id) void loadBanAltWarning(report.target_player_id);
  }

  async function loadBanAltWarning(targetPlayerId: string) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    setBanAltWarningLoading(true);
    setBanAltWarningError(null);
    try {
      const response = await fetch(`/api/v1/players/${targetPlayerId}/ban-alt-warning`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setBanAltWarning((await response.json()) as BanAltWarning);
    } catch (error) {
      if (!controller.signal.aborted) setBanAltWarningError((error as Error).message);
    } finally {
      window.clearTimeout(timeout);
      setBanAltWarningLoading(false);
    }
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
      if (actionModal === 'ban') {
        body.ban_length = banLength.trim() || '0';
        if (selectedAltIds.length > 0) body.also_player_ids = selectedAltIds;
      }
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
    <Card as="article" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <Badge>{report.server_slug ?? report.server_name ?? report.server_id.slice(0, 8)}</Badge>
          <span>{formatDateTime(report.created_at)}</span>
        </div>
        <div className="flex items-center gap-2">
          {report.evidence.length > 0 ? (
            <Badge title="Есть вложения">{evidenceBadgeLabel(report.evidence)}</Badge>
          ) : null}
          <StatusBadge
            state={STATUS_STATE[report.status]}
            label={STATUS_LABELS[report.status]}
            size="sm"
          />
        </div>
      </div>

      {/* Пара «кто на кого» — это и есть заголовок карточки: он даёт блоку имя
          в дереве заголовков и подчиняет себе «Доказательства» уровнем ниже. */}
      <h2 className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
        <PlayerRef id={report.reporter_player_id} name={report.reporter_name} />
        {report.reporter_trusted ? <Badge tone="good">{REPORTER_TRUSTED_LABEL}</Badge> : null}
        {report.reporter_spam_flagged ? <Badge tone="crit">{REPORTER_SPAM_LABEL}</Badge> : null}
        <span aria-hidden="true" className="mx-1 font-normal text-ink-3">
          →
        </span>
        <span className="sr-only">жалуется на</span>
        <PlayerRef
          id={report.target_player_id}
          name={report.target_name}
          fallbackRaw={report.target_raw}
        />
        {isRecidivist(report.target_report_count_90d ?? 0) ? (
          <Badge tone="warn">{recidivistBadgeLabel(report.target_report_count_90d ?? 0)}</Badge>
        ) : null}
      </h2>

      <p className="whitespace-pre-wrap text-[13px] text-ink-2">{report.body}</p>

      {report.evidence.length > 0 ? <ReportEvidenceBlock evidence={report.evidence} /> : null}

      {report.handler_name || report.handler_player_id ? (
        <p className="text-xs text-ink-3">
          Обработчик: {playerLabel(report.handler_player_id, report.handler_name)}
        </p>
      ) : null}

      {canHandle ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {report.target_player_id
            ? (Object.keys(ACTION_LABELS) as ReportActionType[]).map((type) => (
                <Button key={type} size="sm" onClick={() => openActionModal(type)}>
                  {ACTION_LABELS[type]}
                </Button>
              ))
            : null}
          {report.reporter_player_id ? (
            <>
              <Select
                size="sm"
                aria-label="Шаблон уведомления"
                value={notifyTemplate}
                onChange={(e) => setNotifyTemplate(e.target.value as ReporterNotifyTemplate)}
              >
                {(Object.keys(NOTIFY_TEMPLATE_LABELS) as ReporterNotifyTemplate[]).map((tpl) => (
                  <option key={tpl} value={tpl}>
                    {NOTIFY_TEMPLATE_LABELS[tpl]}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={submitNotify} loading={notifyBusy}>
                Уведомить репортёра
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={toggleActions} aria-expanded={actionsOpen}>
            Связанные действия
          </Button>
          <Button size="sm" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            Обработать
          </Button>
        </div>
      ) : null}

      {notifyMsg ? (
        <InlineBanner
          tone={notifyMsg.kind === 'ok' ? 'good' : 'crit'}
          title={notifyMsg.text}
          onDismiss={() => setNotifyMsg(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}

      {actionsOpen ? (
        <div className="border-t border-line pt-3">
          {actionsLoading ? (
            <Skeleton variant="text" count={2} label="Загрузка связанных действий" />
          ) : !actions || actions.length === 0 ? (
            <p className="text-xs text-ink-3">Связанных действий пока нет.</p>
          ) : (
            <ul className="space-y-1">
              {actions.map((action) => (
                <li
                  key={action.id}
                  className="flex flex-wrap items-center gap-2 text-xs text-ink-3"
                >
                  <Badge size="sm">{actionTypeBadge(action.action_type)}</Badge>
                  <span>{formatDateTime(action.created_at)}</span>
                  <span>
                    {action.author.kind === 'player' ? action.author.name : action.author.label}
                  </span>
                  {action.reason ? <span className="text-ink-2">{action.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {editing ? (
        <div className="space-y-3 border-t border-line pt-3">
          <FieldRow label="Статус жалобы">
            <Select value={status} onChange={(e) => setStatus(e.target.value as ReportStatus)}>
              {(Object.keys(STATUS_LABELS) as ReportStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </FieldRow>
          <FieldRow label="Заметка обработчика">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="Заметка обработчика"
            />
          </FieldRow>
          {error ? <InlineBanner tone="crit" title="Не сохранено" description={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(false)}>
              Отмена
            </Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving}>
              Сохранить
            </Button>
          </div>
        </div>
      ) : null}

      {actionModal ? (
        <Modal
          open
          onClose={() => setActionModal(null)}
          title={ACTION_LABELS[actionModal]}
          size="md"
          closeLabel="Отмена"
          dismissible={!actionBusy}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setActionModal(null)}
                disabled={actionBusy}
              >
                Отмена
              </Button>
              <Button variant="primary" onClick={submitAction} loading={actionBusy}>
                {ACTION_LABELS[actionModal]}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <FieldRow label="Причина" htmlFor={`action-reason-${report.id}`}>
              <Textarea
                id={`action-reason-${report.id}`}
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                rows={3}
                maxLength={REASON_MAX}
              />
            </FieldRow>
            {actionModal === 'ban' ? (
              <>
                <FieldRow
                  label="Срок бана"
                  htmlFor={`action-ban-length-${report.id}`}
                  hint="0 — навсегда; иначе, например, 3d или 12h."
                >
                  <TextInput
                    id={`action-ban-length-${report.id}`}
                    value={banLength}
                    onChange={(e) => setBanLength(e.target.value)}
                    className="font-mono"
                  />
                </FieldRow>
                <BanAltWarningBlock
                  warning={banAltWarning}
                  loading={banAltWarningLoading}
                  error={banAltWarningError}
                  selectedAltIds={selectedAltIds}
                  onToggleAlt={(playerId) =>
                    setSelectedAltIds((current) =>
                      current.includes(playerId)
                        ? current.filter((id) => id !== playerId)
                        : [...current, playerId],
                    )
                  }
                />
              </>
            ) : null}
            {actionError ? (
              <InlineBanner tone="crit" title="Действие не выполнено" description={actionError} />
            ) : null}
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

function BanAltWarningBlock({
  warning,
  loading,
  error,
  selectedAltIds,
  onToggleAlt,
}: {
  warning: BanAltWarning | null;
  loading: boolean;
  error: string | null;
  selectedAltIds: string[];
  onToggleAlt: (playerId: string) => void;
}) {
  if (loading) return <Skeleton variant="text" count={2} label="Проверка связанных аккаунтов" />;
  if (error) {
    return (
      <InlineBanner
        tone="warn"
        title={`Проверка альтов недоступна (${error}). Бан можно продолжить.`}
      />
    );
  }
  if (!warning) return null;
  if (!warning.can_view_ips) {
    return warning.confirmed_count > 0 ? (
      <InlineBanner
        tone="warn"
        title={`У игрока есть ${warning.confirmed_count} подтверждённых связанных аккаунтов.`}
      />
    ) : null;
  }
  if (warning.confirmed.length === 0 && warning.candidates.length === 0) return null;

  return (
    /* Предупреждающая поверхность вместо `InlineBanner`: внутри живут флажки,
       а `warn` у полосы означает `role="alert"` — интерактивный список в
       живой области объявлялся бы целиком при каждом переключении. */
    <div className="space-y-3 rounded-card border border-warn/40 bg-warn/10 p-3">
      <h3 className="text-[13px] font-semibold text-ink">У игрока есть связанные аккаунты</h3>
      {warning.confirmed.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-ink-2">Подтверждённые связи</p>
          {warning.confirmed.map((alt) => (
            <Checkbox
              key={alt.player_id}
              checked={selectedAltIds.includes(alt.player_id)}
              onChange={() => onToggleAlt(alt.player_id)}
              label={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span>{alt.name}</span>
                  <span className="text-ink-3">({alt.link_type ?? 'alt'})</span>
                  {alt.online ? <Badge tone="good">онлайн</Badge> : null}
                  {alt.has_active_ban ? <Badge tone="crit">активный бан</Badge> : null}
                  <span className="text-ink-3">— забанить также</span>
                </span>
              }
            />
          ))}
        </div>
      ) : null}
      {warning.candidates.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-ink-2">Кандидаты с высокой уверенностью</p>
          {warning.candidates.map((candidate) => (
            <p
              key={candidate.player_id}
              className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2"
            >
              <span>{candidate.name}</span>
              <span className="text-ink-3">(уверенность: высокая)</span>
              {candidate.online ? <Badge tone="good">онлайн</Badge> : null}
              {candidate.has_active_ban ? <Badge tone="crit">активный бан</Badge> : null}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReportEvidenceBlock({ evidence }: { evidence: ReportEvidenceItem[] }) {
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <h3 className="text-[13px] font-semibold text-ink">Доказательства</h3>
      <div className="flex flex-wrap gap-3">
        {evidence.map((item) => (
          <div key={item.id} className="max-w-[220px] space-y-1">
            {isImageEvidence(item) ? (
              <img
                src={`/api/v1/media/${item.id}/stream`}
                alt={evidenceLabel(item)}
                className="max-h-40 rounded-ctl border border-line object-cover"
              />
            ) : isVideoEvidence(item) ? (
              // biome-ignore lint/a11y/useMediaCaption: user-submitted evidence has no captions
              <video
                controls
                src={`/api/v1/media/${item.id}/stream`}
                className="max-h-40 rounded-ctl border border-line"
              />
            ) : isExternalLinkEvidence(item) && item.external_url ? (
              <a
                href={item.external_url}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-xs text-accent no-underline hover:brightness-110"
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
      <Link href={`/all-players/${id}`} className="text-accent no-underline hover:brightness-110">
        {playerLabel(id, name)}
      </Link>
    );
  }
  return <span className="text-ink-2">{playerLabel(id, name, fallbackRaw ?? null)}</span>;
}
