import type { HealthLevel } from '@/lib/host-health';

export const HEALTH_LABEL: Record<HealthLevel, string> = {
  healthy: 'Здоровый',
  warning: 'Предупреждение',
  critical: 'Критично',
  unknown: 'Нет данных',
};

export const ACTIVITY_FILTERS = ['all', 'user', 'server', 'infra', 'errors'] as const;

export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export function pluralize(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const lastDigit = abs % 10;
  if (abs >= 11 && abs <= 14) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}
