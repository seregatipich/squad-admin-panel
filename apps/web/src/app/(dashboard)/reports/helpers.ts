import type { ReportEvidenceItem, ReportListItem, ReportStatus } from '@/lib/live-bus';

export const PAGE_SIZE = 20;
export const NOTE_MAX = 2000;
export const REASON_MAX = 300;

export interface ReportFilters {
  status: '' | ReportStatus;
  page: number;
}

export const STATUS_LABELS: Record<ReportStatus, string> = {
  pending: 'Ожидает',
  in_review: 'В работе',
  resolved: 'Решён',
  rejected: 'Отклонён',
};

export const STATUS_BADGE_CLASSES: Record<ReportStatus, string> = {
  pending: 'bg-amber-950/50 text-amber-300 border border-amber-900',
  in_review: 'bg-sky-950/50 text-sky-300 border border-sky-900',
  resolved: 'bg-emerald-950/50 text-emerald-300 border border-emerald-900',
  rejected: 'bg-neutral-800 text-neutral-400 border border-neutral-700',
};

export const STATUS_FILTERS: Array<{ value: '' | ReportStatus; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'pending', label: 'Ожидают' },
  { value: 'in_review', label: 'В работе' },
  { value: 'resolved', label: 'Решённые' },
  { value: 'rejected', label: 'Отклонённые' },
];

function isReportStatus(value: string | null): value is ReportStatus {
  return (
    value === 'pending' || value === 'in_review' || value === 'resolved' || value === 'rejected'
  );
}

interface ParamsLike {
  get(key: string): string | null;
}

export function parseFilters(params: ParamsLike): ReportFilters {
  const statusRaw = params.get('status');
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    status: isReportStatus(statusRaw) ? statusRaw : '',
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

export function buildQueryString(filters: ReportFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params.toString();
}

export function buildApiQuery(filters: ReportFilters, pageSize: number = PAGE_SIZE): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  params.set('page', String(filters.page));
  params.set('page_size', String(pageSize));
  return params.toString();
}

export function totalPages(total: number, pageSize: number = PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function playerLabel(
  id: string | null,
  name: string | null,
  fallbackRaw: string | null = null,
): string {
  if (name) return name;
  if (id) return `${id.slice(0, 8)}…`;
  return fallbackRaw ?? '—';
}

/** Attachment-count badge label for a report card, e.g. "📎 2". Empty when there is no evidence. */
export function evidenceBadgeLabel(evidence: ReportEvidenceItem[] | undefined): string {
  const count = evidence?.length ?? 0;
  return count > 0 ? `📎 ${count}` : '';
}

export function isImageEvidence(item: ReportEvidenceItem): boolean {
  return item.kind === 'image';
}

export function isVideoEvidence(item: ReportEvidenceItem): boolean {
  return item.kind === 'video';
}

export function isExternalLinkEvidence(item: ReportEvidenceItem): boolean {
  return item.kind === 'external_link';
}

/** Display label for an evidence item: its title, or the original filename/URL as a fallback. */
export function evidenceLabel(item: ReportEvidenceItem): string {
  return item.title ?? item.external_url ?? item.original_filename;
}

export type ReportActionType = 'warn' | 'kick' | 'ban';

/** Button labels for the report-card enforcement actions (REPORT-3, #113). */
export const ACTION_LABELS: Record<ReportActionType, string> = {
  warn: 'Предупредить',
  kick: 'Кикнуть',
  ban: 'Забанить',
};

/** Labels for the "linked actions" list on the report card / moderation history. */
export const ACTION_TYPE_LABELS: Record<string, string> = {
  warn: 'Предупреждение',
  kick: 'Кик',
  ban: 'Бан',
};

export function actionTypeBadge(actionType: string): string {
  return ACTION_TYPE_LABELS[actionType] ?? actionType;
}

export type ReporterNotifyTemplate = 'in_review' | 'resolved';

export const NOTIFY_TEMPLATE_LABELS: Record<ReporterNotifyTemplate, string> = {
  in_review: 'Репорт принят в работу',
  resolved: 'Репорт рассмотрен',
};

const BAN_LENGTH_PATTERN = /^\d+[smhdwMy]?$/;

/** Mirrors the API/RCON-worker ban-length syntax check (see AdminBan). */
export function isValidBanLength(value: string): boolean {
  return BAN_LENGTH_PATTERN.test(value.trim());
}

/** Minimum target report count (90d window) to render the recidivist badge (REPORT-5, #115). */
export const RECIDIVIST_MIN_COUNT_90D = 3;

/** True once a target has accumulated enough reports in the 90-day window to flag as a recidivist. */
export function isRecidivist(count: number): boolean {
  return count >= RECIDIVIST_MIN_COUNT_90D;
}

export const REPORTER_TRUSTED_LABEL = 'Доверенный';
export const REPORTER_SPAM_LABEL = 'Спам';

/** Badge label for the target-recidivism count, e.g. "3 жалобы за 90 дн". */
export function recidivistBadgeLabel(count: number): string {
  return `${count} ${reportsWord(count)} за 90 дн`;
}

/** Russian plural form for "report(s)" (жалоба/жалобы/жалоб) by count. */
function reportsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'жалоба';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'жалобы';
  return 'жалоб';
}

export interface ReportTargetGroup {
  target_player_id: string;
  target_name: string | null;
  reports: ReportListItem[];
}

/**
 * Splits a report list into groups sharing a resolved `target_player_id`
 * (for "N жалоб на игрока X" pending-queue blocks with a mass-resolve
 * action) plus the reports with no resolved target, which are never
 * grouped and render as individual cards.
 */
export function groupPendingByTarget(items: ReportListItem[]): {
  grouped: ReportTargetGroup[];
  ungrouped: ReportListItem[];
} {
  const order: string[] = [];
  const byTarget = new Map<string, ReportListItem[]>();
  const ungrouped: ReportListItem[] = [];

  for (const item of items) {
    if (!item.target_player_id) {
      ungrouped.push(item);
      continue;
    }
    const existing = byTarget.get(item.target_player_id);
    if (existing) {
      existing.push(item);
    } else {
      byTarget.set(item.target_player_id, [item]);
      order.push(item.target_player_id);
    }
  }

  const grouped: ReportTargetGroup[] = order.map((targetId) => {
    const reports = byTarget.get(targetId) ?? [];
    return { target_player_id: targetId, target_name: reports[0]?.target_name ?? null, reports };
  });

  return { grouped, ungrouped };
}
