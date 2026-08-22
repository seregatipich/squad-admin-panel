import type { ReactNode } from 'react';
import { Badge, type BadgeSize } from '@/components/ui/Badge';

export type StatusState = 'good' | 'warn' | 'crit' | 'idle';

const DOT_TONE_CLASS: Record<StatusState, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  crit: 'bg-crit',
  idle: 'bg-ink-3',
};

const DOT_SIZE_CLASS: Record<BadgeSize, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
};

/* Точка сама по себе ничего не сообщает — рядом с ней всегда есть подпись,
   поэтому для программ чтения с экрана она скрыта. */
function Dot({ state, size, pulse }: { state: StatusState; size: BadgeSize; pulse: boolean }) {
  const classes = [
    'inline-block shrink-0 rounded-full',
    DOT_SIZE_CLASS[size],
    DOT_TONE_CLASS[state],
  ];
  if (pulse) classes.push('animate-pulse');
  return <span aria-hidden="true" className={classes.join(' ')} />;
}

const LABEL_SIZE_CLASS: Record<BadgeSize, string> = {
  sm: 'text-2xs',
  md: 'text-xs',
};

export type StatusDotProps = {
  /** Состояние системы: `idle` — «наблюдение не ведётся», а не «всё хорошо». */
  state: StatusState;
  /** Словесное состояние. Обязателен: цвет точки — дубль подписи, а не замена. */
  label: string;
  size?: BadgeSize;
  /**
   * Пульсация означает ровно одно: **данные идут прямо сейчас** (раздел 9
   * дизайн-системы). Ни «важно», ни «требует внимания», ни «загружается» —
   * иначе движение перестаёт что-либо значить и начинает отвлекать оператора,
   * который смотрит в этот экран всю смену.
   */
  pulse?: boolean;
  /**
   * Убирает подпись с экрана, но не из разметки: там, где состояние уже
   * названо соседней колонкой, дублировать его текстом незачем, а программе
   * чтения с экрана подпись по-прежнему нужна.
   */
  hideLabel?: boolean;
};

/**
 * Точка состояния с подписью — минимальная форма индикатора.
 *
 * Состояние никогда не кодируется одним цветом (раздел 5 дизайн-системы):
 * подпись остаётся в разметке даже скрытой, а при `hideLabel` дополнительно
 * становится всплывающей подсказкой — иначе смысл точки виден только тому,
 * кто различает зелёный и красный.
 */
export function StatusDot({
  state,
  label,
  size = 'md',
  pulse = false,
  hideLabel = false,
}: StatusDotProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-ink-2 ${LABEL_SIZE_CLASS[size]}`}
      title={hideLabel ? label : undefined}
    >
      <Dot state={state} size={size} pulse={pulse} />
      <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}

export type StatusBadgeProps = {
  state: StatusState;
  /** Словесное состояние — заодно и текстовый дубль тона пилюли. */
  label: string;
  /** Значок вместо точки: более сильный дубль состояния, чем цвет. */
  icon?: ReactNode;
  size?: BadgeSize;
  /** См. `StatusDot.pulse`: только «данные идут прямо сейчас». Со значком
      не применяется — пульсировать в пилюле нечему. */
  pulse?: boolean;
};

const TONE_FOR_STATE = {
  good: 'good',
  warn: 'warn',
  crit: 'crit',
  idle: 'neutral',
} as const satisfies Record<StatusState, 'good' | 'warn' | 'crit' | 'neutral'>;

/**
 * Состояние в форме пилюли: то же, что `StatusDot`, но с фоном тона.
 *
 * Применяется там, где состояние — самостоятельная величина (карточка
 * сервера, шапка страницы), а не приписка к соседней колонке: подложка
 * отделяет его от окружающего текста, поэтому в плотной таблице лучше
 * оставить `StatusDot`.
 */
export function StatusBadge({ state, label, icon, size = 'md', pulse = false }: StatusBadgeProps) {
  return (
    <Badge tone={TONE_FOR_STATE[state]} size={size}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center">
          {icon}
        </span>
      ) : (
        <Dot state={state} size={size} pulse={pulse} />
      )}
      <span>{label}</span>
    </Badge>
  );
}
