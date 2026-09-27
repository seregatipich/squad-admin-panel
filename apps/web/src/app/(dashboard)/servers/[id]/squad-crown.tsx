import type { SquadCrown as SquadCrownData } from '@squad/shared-types';
import { crownTooltipLines } from './roster-format';

/** Серая корона — приглушённый текст, красная — тон опасности; оба токена есть в каждой теме. */
const CROWN_TONE: Record<SquadCrownData['color'], string> = {
  grey: 'text-ink-3',
  red: 'text-crit',
};

/**
 * Корона создателя отряда в строке ростера: серая — передал командование и
 * остался в отряде, красная — ушёл из отряда или вышел с сервера, будучи
 * командиром. Подсказка и `aria-label` перечисляют отряды построчно.
 */
export function SquadCrown({ crown }: { crown: SquadCrownData }) {
  const label = crownTooltipLines(crown).join('\n');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 ${CROWN_TONE[crown.color]}`}
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M1.5 5.5 4.5 8 8 2.5 11.5 8l3-2.5-1.25 7.5H2.75z" />
      </svg>
    </span>
  );
}
