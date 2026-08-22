import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'good' | 'warn' | 'crit';
export type BadgeSize = 'sm' | 'md';

/*
 * Тон — это приглушённая подложка плюс насыщенный текст, а не сплошная заливка.
 * В таблице игроков в одной строке легко оказывается десяток меток; десять
 * сплошных плашек перебивают содержимое ячеек и выжигают экран, тогда как
 * 15-процентная заливка остаётся фоном и не спорит с текстом строки.
 *
 * Текст берётся на ступень светлее самого токена состояния (`*-300` вместо
 * `accent`/`good`/`warn`/`crit`): на собственной подложке тона токен состояния
 * даёт около 4:1 и не проходит AA для 11px (accent — 3.99, crit — 3.98), а
 * ступень 300 даёт 4.96–6.56 на bg-surface. Измерено композитингом подложки
 * поверх #2c2c2e — карточка светлее страницы, поэтому это худший случай.
 */
const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-raised text-ink-2',
  accent: 'bg-accent-dim text-sky-300',
  good: 'bg-good/15 text-emerald-300',
  warn: 'bg-warn/15 text-amber-300',
  crit: 'bg-crit/15 text-red-300',
};

/* Кегль у обоих размеров одинаковый: 11px — нижняя граница интерфейса
   (раздел 1 дизайн-системы), уменьшать метку можно только полями. */
const SIZE_CLASS: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-px',
  md: 'px-2 py-0.5',
};

const BASE_CLASS = 'inline-flex items-center gap-1 rounded-full text-2xs font-medium';

export type BadgeProps = {
  /** Содержимое метки: текст, а при необходимости — значок перед ним. */
  children: ReactNode;
  /** Смысл метки: `neutral` — категория, остальные тона — состояние системы. */
  tone?: BadgeTone;
  /** `sm` — для плотных строк таблицы, `md` — везде остальное. */
  size?: BadgeSize;
  /** Подсказка при наведении: расшифровка сокращённой метки. */
  title?: string;
};

/**
 * Нейтральная «пилюля» для меток: роль, источник, категория, состояние.
 *
 * Цветом метка только подсказывает, а не сообщает: тон дублируется текстом
 * внутри неё, поэтому метка остаётся читаемой при любом виде дальтонизма
 * (раздел 5 дизайн-системы).
 */
export function Badge({ children, tone = 'neutral', size = 'md', title }: BadgeProps) {
  return (
    <span className={`${BASE_CLASS} ${SIZE_CLASS[size]} ${TONE_CLASS[tone]}`} title={title}>
      {children}
    </span>
  );
}
