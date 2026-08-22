'use client';

import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';

export type StatTileTone = 'neutral' | 'accent' | 'good' | 'warn' | 'crit';
export type StatTileSize = 'sm' | 'md';

/*
 * Явные словари вместо `bg-${tone}`: Tailwind 4 читает исходники как текст и
 * не увидит класс, который собирается во время выполнения. Та же причина, по
 * которой `tone` сегмента — замкнутое объединение, а не любая строка:
 * значение, которого нет в словаре, нечем покрасить.
 */
const FILL_CLASS: Record<StatTileTone, string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  good: 'bg-good',
  warn: 'bg-warn',
  crit: 'bg-crit',
};

/* Тон значения — состояние показателя, а не украшение (раздел 5
   дизайн-системы). Все четыре цветных тона дают ≥4.9:1 на `bg-surface`. */
const VALUE_TONE_CLASS: Record<StatTileTone, string> = {
  neutral: 'text-ink',
  accent: 'text-accent',
  good: 'text-good',
  warn: 'text-warn',
  crit: 'text-crit',
};

/* Кегль значения: 22px — заголовочный уровень, 17px — уровень раздела.
   Плотная сетка из десяти плиток читается только на `sm`. */
const VALUE_SIZE_CLASS: Record<StatTileSize, string> = {
  sm: 'text-[17px]',
  md: 'text-[22px]',
};

const SURFACE_CLASS = 'rounded-card border border-line bg-surface p-4';

export type StatTileSegment = {
  /** Доля сегмента в процентах от всей полосы; значение вне 0…100 подрезается. */
  pct: number;
  tone: StatTileTone;
  /** Обязательная подпись доли — она же строка легенды. */
  label: string;
};

/**
 * Полоса под значением: либо одиночное заполнение тоном плитки, либо
 * несколько долей подряд с обязательной легендой.
 */
export type StatTileProgress = { pct: number } | { segments: StatTileSegment[] };

function isSegmented(progress: StatTileProgress): progress is { segments: StatTileSegment[] } {
  return 'segments' in progress;
}

/** Подрезает долю к 0…100: ширина полосы не может выйти за её пределы. */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

function classes(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type StatTileBaseProps = {
  /** Служебный ярлык над значением — набирается заглавными («ОНЛАЙН»). */
  label: string;
  value: ReactNode;
  /** Пояснение под значением: единица измерения, дельта, время замера. */
  hint?: ReactNode;
  /** Состояние показателя; красит значение и одиночное заполнение полосы. */
  tone?: StatTileTone;
  progress?: StatTileProgress;
  size?: StatTileSize;
  className?: string;
};

/*
 * Нажимаемая плитка обязана иметь доступное имя, поэтому `actionLabel` и
 * `onClick` заданы одним объединением: включить обработчик и забыть имя
 * кнопки — ошибка типизации, а не молчаливо безымянная кнопка в интерфейсе.
 */
type StatTileActionProps =
  | { onClick: () => void; actionLabel: string }
  | { onClick?: never; actionLabel?: never };

export type StatTileProps = StatTileBaseProps & StatTileActionProps;

function Bar({
  progress,
  tone,
  label,
}: {
  progress: StatTileProgress;
  tone: StatTileTone;
  label: string;
}) {
  if (isSegmented(progress)) {
    return (
      <div className="mt-3">
        {/* Полоса — иллюстрация распределения; смысл долей несёт легенда,
            поэтому программе чтения с экрана она не нужна. */}
        <div aria-hidden="true" className="flex h-1 overflow-hidden rounded-full bg-raised">
          {progress.segments.map((segment) => (
            <span
              key={segment.label}
              className={FILL_CLASS[segment.tone]}
              style={{ width: `${clampPct(segment.pct)}%` }}
            />
          ))}
        </div>
        {/* Доля не может быть закодирована одним цветом (раздел 5): каждая
            получает подпись и число. */}
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-3">
          {progress.segments.map((segment) => (
            <li key={segment.label} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className={classes('h-1.5 w-1.5 shrink-0 rounded-full', FILL_CLASS[segment.tone])}
              />
              <span>{segment.label}</span>
              <span className="tabular-nums text-ink-2">{clampPct(segment.pct)}%</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const pct = clampPct(progress.pct);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="mt-3 h-1 overflow-hidden rounded-full bg-raised"
    >
      <div
        className={classes('h-full rounded-full', FILL_CLASS[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * Плитка показателя: служебный ярлык, крупное значение, необязательные
 * подсказка и полоса распределения.
 *
 * Значение набирается `tabular-nums` — плитки стоят сеткой, и цифры соседних
 * плиток должны выстраиваться в столбцы, а меняющееся раз в секунду число не
 * должно дёргать вёрстку.
 *
 * С `onClick` вся плитка становится одной кнопкой, а не прячет ссылку в углу:
 * цель нажатия размером с карточку попадается мышью с любого места. Имя
 * кнопки — `actionLabel`, и оно **замещает** собой весь текст плитки для
 * программы чтения с экрана, поэтому в нём называют и показатель, и действие
 * («Онлайн, 42 игрока — открыть список»), а не одно «Подробнее».
 */
export function StatTile(props: StatTileProps) {
  const {
    label,
    value,
    hint,
    tone = 'neutral',
    progress,
    size = 'md',
    className,
    onClick,
    actionLabel,
  } = props;

  const body = (
    <>
      <p className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</p>
      <p
        className={classes(
          'mt-1 font-semibold tabular-nums',
          VALUE_SIZE_CLASS[size],
          VALUE_TONE_CLASS[tone],
        )}
      >
        {value}
      </p>
      {hint !== undefined && hint !== null && hint !== false && (
        <p className="mt-1 text-xs text-ink-3">{hint}</p>
      )}
      {progress && <Bar progress={progress} tone={tone} label={label} />}
    </>
  );

  if (onClick) {
    /* Карточка здесь не используется намеренно: `Card` рендерит только
       div/section/article, а нажимаемая плитка обязана быть настоящей
       кнопкой — ради Enter, пробела и фокуса без единой строки кода. */
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={actionLabel}
        className={classes(
          SURFACE_CLASS,
          'w-full text-left transition-colors hover:border-line-2 hover:bg-raised/40',
          className,
        )}
      >
        {body}
      </button>
    );
  }

  return <Card className={className}>{body}</Card>;
}
