'use client';

import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';

/** Роль действия. Цвет здесь означает намерение, а не украшение (дизайн-система, §5). */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'plain';

/** Высота элемента управления: `md` — 32px, `sm` — 28px (дизайн-система, §6). */
export type ButtonSize = 'sm' | 'md';

/**
 * Классы перечислены целиком, а не собраны из кусков (`text-${size}`): сканер
 * Tailwind 4 читает исходники как текст и не видит имён, склеенных в рантайме.
 */
const BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40';

const SIZE: Record<ButtonSize, string> = {
  md: 'h-8 px-3 text-xs',
  sm: 'h-7 px-2.5 text-2xs',
};

/**
 * У текстовой кнопки нет фона, и штатные боковые поля отодвинули бы её от
 * соседнего текста на пустоту — поэтому поля уже, а высота цели нажатия
 * остаётся прежней.
 */
const PLAIN_SIZE: Record<ButtonSize, string> = {
  md: 'h-8 px-1.5 text-xs',
  sm: 'h-7 px-1 text-2xs',
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-bg hover:brightness-110',
  secondary: 'bg-raised text-ink border border-line hover:bg-line-2',
  ghost: 'text-ink-2 hover:bg-raised hover:text-ink',
  destructive: 'bg-crit text-bg hover:brightness-110',
  plain: 'text-accent hover:brightness-110',
};

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Индикатор выполнения. Ширина фиксированная и `shrink-0`, поэтому подпись не
 * сжимается и не переносится, пока действие идёт.
 * `prefers-reduced-motion` обрабатывается глобально в `globals.css`.
 */
function Spinner() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      className="size-3.5 shrink-0 animate-spin"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Действие выполняется: кнопка блокируется, но остаётся на своём месте. */
  loading?: boolean;
  fullWidth?: boolean;
};

/**
 * Кнопка панели.
 *
 * Единственный источник размеров и вариантов действия — раздел 6
 * дизайн-системы; страницы не задают кнопкам ни высоту, ни цвет вручную.
 * Весь человекочитаемый текст приходит через `children` и нативные пропсы:
 * примитив не знает про словарь переводов.
 *
 * @param variant Роль действия. `destructive` — только необратимое разрушение
 *   данных; «Отмена» и «Удалить фильтр» — это `secondary` (§5).
 * @param size Высота: `md` (32px) или `sm` (28px).
 * @param loading Пока `true`, кнопка получает `disabled` и `aria-busy`, а
 *   слева появляется индикатор. Содержимое не подменяется — оператор видит,
 *   что именно выполняется.
 * @param fullWidth Растянуть на ширину контейнера (подвал формы на узком экране).
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  type = 'button',
  disabled = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        BASE,
        variant === 'plain' ? PLAIN_SIZE[size] : SIZE[size],
        VARIANT[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
};

/**
 * Ссылка, выглядящая как {@link Button}.
 *
 * Переход — это навигация, а не действие, поэтому у него настоящий `<a>`:
 * работают средняя кнопка мыши, «открыть в новой вкладке» и предзагрузка
 * Next. Полиморфного `as` у `Button` намеренно нет — он прячет эту разницу.
 * Состояния `loading` здесь нет: переход нечего ждать.
 */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      className={cx(
        BASE,
        'no-underline',
        variant === 'plain' ? PLAIN_SIZE[size] : SIZE[size],
        VARIANT[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

/** Высота кнопки-значка. Про `sm` см. JSDoc {@link IconButton}. */
export type IconButtonSize = 'sm' | 'md';

const ICON_SIZE: Record<IconButtonSize, string> = {
  md: 'h-7 w-7',
  sm: 'h-6 w-6',
};

const ICON_TONE = {
  default: 'text-ink-2 hover:bg-raised hover:text-ink',
  destructive: 'text-ink-3 hover:bg-crit/15 hover:text-crit',
} as const;

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'title' | 'children'
> & {
  icon: ReactNode;
  /** Доступное имя. Обязательно: значок сам по себе ничего не сообщает. */
  label: string;
  size?: IconButtonSize;
  tone?: 'default' | 'destructive';
};

/**
 * Кнопка-значок: только графика, подпись живёт в `aria-label` и `title`.
 *
 * `label` обязателен по типу — кнопка-значок без доступного имени невидима для
 * скринридера, и §6 дизайн-системы считает это дефектом. Текст приходит извне:
 * примитив не обращается к словарю переводов.
 *
 * @param icon Содержимое кнопки — значок; сам он скрыт от скринридера именем кнопки.
 * @param label Что делает кнопка. Уходит и в `aria-label`, и в `title`.
 * @param size `md` — 28×28px, нижняя граница цели нажатия для указателя (HIG
 *   для macOS). `sm` — 24×24px, и он **разрешён только внутри строки таблицы**,
 *   где строка высотой 36px не вмещает 28px с полями, а сама строка уже
 *   является крупной целью наведения. Везде, кроме строк таблицы, 24px — дефект.
 * @param tone `destructive` подкрашивает наведение в критический цвет; смысл
 *   всё равно несёт `label`, а не цвет (§5).
 */
export function IconButton({
  icon,
  label,
  size = 'md',
  tone = 'default',
  type = 'button',
  disabled = false,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cx(
        'grid place-items-center rounded-ctl transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40',
        ICON_SIZE[size],
        ICON_TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
