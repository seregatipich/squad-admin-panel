import type { MarkTypeIcon } from '@squad/shared-config/mark-types';
import { ApiError } from '@/lib/api';

export interface MarkType {
  id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: MarkTypeIcon;
  severity: number;
  is_active: boolean;
  sort_order: number;
}

const SEVERITY_LABELS: Record<number, string> = {
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

/** A failed API call, carrying a Russian message that is safe to show the operator. */
export class RequestFailure extends Error {
  constructor(status: number) {
    super(`Запрос не выполнен (HTTP ${status}).`);
  }
}

/** Russian banner text for anything thrown while calling the API. */
export function requestFailureText(error: unknown): string {
  if (error instanceof RequestFailure) return error.message;
  if (error instanceof ApiError) return new RequestFailure(error.status).message;
  return 'Сетевая ошибка. Проверьте соединение и повторите.';
}
