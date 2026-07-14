export type ReportSummaryStatus = 'pending' | 'in_review' | 'resolved' | 'rejected';

export const REPORT_STATUS_LABELS: Record<ReportSummaryStatus, string> = {
  pending: 'Ожидает',
  in_review: 'В работе',
  resolved: 'Решён',
  rejected: 'Отклонён',
};

export const REPORT_STATUS_BADGE_CLASSES: Record<ReportSummaryStatus, string> = {
  pending: 'bg-amber-950/50 text-amber-300 border border-amber-900',
  in_review: 'bg-sky-950/50 text-sky-300 border border-sky-900',
  resolved: 'bg-emerald-950/50 text-emerald-300 border border-emerald-900',
  rejected: 'bg-neutral-800 text-neutral-400 border border-neutral-700',
};

const EXCERPT_MAX = 140;

/** Truncates a report body for the player-card summary list, with an ellipsis. */
export function excerpt(body: string, maxChars: number = EXCERPT_MAX): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

export function formatReportDate(iso: string | null): string {
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
