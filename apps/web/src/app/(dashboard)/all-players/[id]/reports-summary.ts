export type ReportSummaryStatus = 'pending' | 'in_review' | 'resolved' | 'rejected';

export const REPORT_STATUS_LABELS: Record<ReportSummaryStatus, string> = {
  pending: 'Ожидает',
  in_review: 'В работе',
  resolved: 'Решён',
  rejected: 'Отклонён',
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
