import type { BadgeTone } from '@/components/ui';
import type { BadgeTone as PriorityTone } from './helpers';

/**
 * Словарь сроков приоритета (`helpers.ts`) говорит о клане, а не о панели,
 * поэтому его тон переводится в тон дизайн-системы здесь, а не в помощнике:
 * помощник ничего не знает про оформление. Общий для списка кланов и
 * страницы клана.
 */
export const PRIORITY_TONE: Record<PriorityTone, BadgeTone> = {
  neutral: 'neutral',
  danger: 'crit',
  warning: 'warn',
};
