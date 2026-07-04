export interface MarkType {
  id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
  is_active: boolean;
  sort_order: number;
}

export const MARK_TYPE_ICONS = [
  'scan-eye',
  'crosshair',
  'gauge',
  'boxes',
  'refresh-cw',
  'skull',
  'file-warning',
  'message-square-warning',
  'flag',
  'shield-alert',
  'bug',
  'ban',
  'alert-triangle',
  'eye-off',
  'radar',
  'zap',
] as const;

export type MarkTypeIcon = (typeof MARK_TYPE_ICONS)[number];

export const MARK_TYPE_SEVERITY_MIN = 1;
export const MARK_TYPE_SEVERITY_MAX = 5;

export const SEVERITY_LABELS: Record<number, string> = {
  1: 'Низкая',
  2: 'Ниже средней',
  3: 'Средняя',
  4: 'Высокая',
  5: 'Критическая',
};

export function severityLabel(severity: number): string {
  return SEVERITY_LABELS[severity] ?? `Уровень ${severity}`;
}

const SLUG_RE = /^[a-z0-9_]+$/;

export function isValidSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 40 && SLUG_RE.test(slug);
}

export function moveItem<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = [...list];
  if (fromIndex < 0 || fromIndex >= next.length) return next;
  const clampedTo = Math.max(0, Math.min(toIndex, next.length - 1));
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return next;
  next.splice(clampedTo, 0, moved);
  return next;
}

export function sortByOrder(types: readonly MarkType[]): MarkType[] {
  return [...types].sort((left, right) => left.sort_order - right.sort_order);
}

export function isSameOrder(left: readonly MarkType[], right: readonly MarkType[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((type, index) => type.id === right[index]?.id);
}
