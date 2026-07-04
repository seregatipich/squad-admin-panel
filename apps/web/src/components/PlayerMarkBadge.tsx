'use client';

import { highestSeverityTone, type MarkTypeMini, markIconEmoji } from '@/lib/marks';

const toneClasses: Record<string, string> = {
  red: 'border-red-800 bg-red-950/70 text-red-200',
  amber: 'border-amber-800 bg-amber-950/70 text-amber-200',
  neutral: 'border-neutral-700 bg-neutral-900 text-neutral-200',
};

export function PlayerMarkBadge({ marks }: { marks: MarkTypeMini[] }) {
  if (marks.length === 0) return null;
  const tone = highestSeverityTone(marks) ?? 'neutral';
  const topMark = [...marks].sort((left, right) => right.severity - left.severity)[0];
  const title = marks.map((mark) => mark.label_ru).join(', ');
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none align-middle ${toneClasses[tone]}`}
    >
      <span aria-hidden>{markIconEmoji(topMark?.icon ?? '')}</span>
      <span>метка{marks.length > 1 ? ` ×${marks.length}` : ''}</span>
    </span>
  );
}
