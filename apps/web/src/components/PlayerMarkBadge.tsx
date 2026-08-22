'use client';

import { Badge, type BadgeTone } from '@/components/ui';
import { highestSeverityTone, type MarkTone, type MarkTypeMini, markIconEmoji } from '@/lib/marks';

/** Тяжесть метки — это состояние, и оно читается тоном пилюли (§5). */
const MARK_TONE: Record<MarkTone, BadgeTone> = {
  red: 'crit',
  amber: 'warn',
  neutral: 'neutral',
};

/**
 * Компактная пилюля «на игроке есть метки» для строк списков и шапок карточек.
 *
 * Показывает значок самой тяжёлой метки и их число, а полный перечень подписей
 * остаётся в подсказке: в строке таблицы на все метки места нет, а знать, какие
 * именно, оператору нужно до того, как он откроет карточку.
 *
 * @param marks Метки игрока; порядок вызывающего кода не меняется.
 */
export function PlayerMarkBadge({ marks }: { marks: MarkTypeMini[] }) {
  if (marks.length === 0) return null;
  const tone = highestSeverityTone(marks) ?? 'neutral';
  const topMark = [...marks].sort((left, right) => right.severity - left.severity)[0];
  const title = marks.map((mark) => mark.label_ru).join(', ');
  return (
    <Badge tone={MARK_TONE[tone]} size="sm" title={title}>
      <span aria-hidden>{markIconEmoji(topMark?.icon ?? '')}</span>
      <span>метка{marks.length > 1 ? ` ×${marks.length}` : ''}</span>
    </Badge>
  );
}
