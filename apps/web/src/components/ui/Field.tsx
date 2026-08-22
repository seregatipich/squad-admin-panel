'use client';

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cloneElement, isValidElement, useId } from 'react';

/** Высота элемента управления: `md` — 32px, `sm` — 28px (дизайн-система, §6). */
export type FieldSize = 'sm' | 'md';

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Классы перечислены целиком, а не собраны из кусков (`text-${size}`): сканер
 * Tailwind 4 читает исходники как текст и не видит имён, склеенных в рантайме.
 */
const CONTROL_BASE =
  'w-full rounded-ctl border bg-raised text-ink transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40';

const CONTROL_SIZE: Record<FieldSize, string> = {
  md: 'h-8 px-2.5 text-xs',
  sm: 'h-7 px-2 text-2xs',
};

/** Многострочное поле растёт вниз, поэтому высота задаётся минимумом, а не `h-*`. */
const TEXTAREA_SIZE: Record<FieldSize, string> = {
  md: 'min-h-[72px] px-2.5 py-2 text-xs',
  sm: 'min-h-[72px] px-2 py-2 text-2xs',
};

/** Ошибку обозначают и рамка, и `aria-invalid`: цвет никогда не единственный признак (§5). */
const BORDER = {
  normal: 'border-line',
  invalid: 'border-crit',
} as const;

export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  /** Значение не проходит проверку: критическая рамка плюс `aria-invalid`. */
  invalid?: boolean;
  size?: FieldSize;
};

/**
 * Однострочное поле ввода.
 *
 * Нативный `size` у `<input>` — это ширина в символах, а размерная шкала
 * панели именует высоту; поэтому атрибут исключён из пропсов, и `size` здесь
 * означает ровно то же, что у {@link Switch} и кнопки — 32px или 28px.
 *
 * @param invalid Поле помечено ошибкой. Текст ошибки живёт в {@link FieldRow}.
 * @param size Высота поля: `md` (32px) или `sm` (28px).
 */
export function TextInput({
  invalid = false,
  size = 'md',
  type = 'text',
  className,
  ...rest
}: TextInputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cx(
        CONTROL_BASE,
        CONTROL_SIZE[size],
        invalid ? BORDER.invalid : BORDER.normal,
        className,
      )}
      {...rest}
    />
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  size?: FieldSize;
};

/**
 * Многострочное поле ввода.
 *
 * Тянется только по вертикали (`resize-y`): горизонтальное растягивание
 * ломает сетку страницы, а вертикальное — единственное, что оператору
 * действительно нужно при вводе длинной причины бана.
 *
 * @param invalid Поле помечено ошибкой.
 * @param size Кегль и боковые поля; минимальная высота одинакова.
 */
export function Textarea({ invalid = false, size = 'md', className, ...rest }: TextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cx(
        CONTROL_BASE,
        'resize-y',
        TEXTAREA_SIZE[size],
        invalid ? BORDER.invalid : BORDER.normal,
        className,
      )}
      {...rest}
    />
  );
}

/** Шеврон вниз у списка. Скрыт от скринридера: смысл несёт сам `<select>`. */
function ChevronDown() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
    >
      <path
        d="m4 6 4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  invalid?: boolean;
  size?: FieldSize;
};

/**
 * Выпадающий список — настоящий `<select>`.
 *
 * Системный список сам даёт клавиатуру, поиск по первой букве и нативное
 * меню платформы; переписывать его на `div` ради стрелки нельзя. Поэтому
 * скрывается только штатная стрелка (`appearance-none`), а на её место
 * абсолютным позиционированием ставится шеврон панели — отсюда обёртка
 * `relative`.
 *
 * @param invalid Значение не проходит проверку.
 * @param size Высота списка: `md` (32px) или `sm` (28px).
 */
export function Select({
  invalid = false,
  size = 'md',
  className,
  children,
  ...rest
}: SelectProps) {
  return (
    <span className="relative block">
      <select
        aria-invalid={invalid || undefined}
        className={cx(
          CONTROL_BASE,
          'appearance-none pr-7',
          CONTROL_SIZE[size],
          invalid ? BORDER.invalid : BORDER.normal,
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown />
    </span>
  );
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Подпись рядом с флажком; она же — доступное имя. Текст приходит извне. */
  label: ReactNode;
};

/**
 * Флажок с подписью.
 *
 * Цель нажатия — вся строка `<label>`, а не квадрат 14px: сам флажок мельче
 * 28px, нижней границы цели для указателя (§6), и добрать высоту можно только
 * подписью. Цвет галочки задаёт `accent-color`, поэтому флажок остаётся
 * нативным и сохраняет системное поведение с клавиатуры.
 *
 * @param label Что означает включённое состояние.
 */
export function Checkbox({ label, disabled = false, className, ...rest }: CheckboxProps) {
  return (
    <label
      className={cx(
        'flex min-h-7 items-center gap-2 text-xs text-ink',
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
        className,
      )}
    >
      <input
        type="checkbox"
        disabled={disabled}
        className="size-3.5 shrink-0 accent-accent"
        {...rest}
      />
      <span>{label}</span>
    </label>
  );
}

export type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'type' | 'role' | 'aria-checked' | 'aria-label' | 'children'
> & {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Доступное имя. Видимую подпись даёт {@link FieldRow} или строка списка. */
  label: string;
  /** Идентификатор элемента с пояснением, если оно есть. */
  describedBy?: string;
};

/**
 * Переключатель немедленного действия — 40×24 с ползунком 20px.
 *
 * Собран на `<button role="switch">`, а не на `<input type="checkbox">`:
 * браузер сам даёт такой кнопке активацию пробелом и Enter, а `aria-checked`
 * сообщает состояние скринридеру — отдельный обработчик клавиш здесь был бы
 * вторым источником правды. Переключатель применяет изменение сразу, без
 * кнопки «Сохранить»: если действие нужно подтверждать, это флажок в форме,
 * а не переключатель.
 *
 * Остальные пропсы кнопки проходят насквозь, поэтому {@link FieldRow} может
 * дописать переключателю `id` и `aria-describedby` так же, как полю ввода.
 *
 * @param checked Текущее состояние; компонент контролируемый.
 * @param onChange Вызывается с состоянием, которое оператор запросил.
 */
export function Switch({
  checked,
  onChange,
  label,
  describedBy,
  disabled = false,
  className,
  ...rest
}: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy ?? rest['aria-describedby']}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-2',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'size-5 rounded-full bg-ink transition-transform duration-150',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** Пропсы, которые строка поля дописывает своему контролу. */
type ControlProps = { id?: string; 'aria-describedby'?: string };

/**
 * Строка формы: подпись, контрол, подсказка, ошибка — сверху вниз.
 *
 * Связывание берёт на себя строка, а не вызывающий код: идентификаторы
 * выдаёт `useId`, подпись получает `htmlFor`, а текст ошибки дописывается
 * контролу в `aria-describedby` через `cloneElement`. Иначе каждая форма
 * панели изобретала бы свои идентификаторы и половина полей осталась бы
 * без доступного имени.
 *
 * Ошибка помечена `role="alert"`: она появляется после действия оператора,
 * и скринридер обязан прочитать её без перевода фокуса.
 *
 * @param label Подпись поля.
 * @param htmlFor Идентификатор контрола, если он задан снаружи; иначе строка выдаст свой.
 * @param hint Пояснение под контролом; со скринридером не связывается — им читается ошибка.
 * @param error Текст ошибки. Пока он задан, контрол считается ошибочным.
 * @param required Поле обязательно; звёздочка скрыта от скринридера, ему хватает `required` контрола.
 */
export function FieldRow({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const uid = useId();
  const errorId = `${uid}-error`;
  const element: ReactElement<ControlProps> | null = isValidElement<ControlProps>(children)
    ? children
    : null;
  const controlId = htmlFor ?? element?.props.id ?? `${uid}-control`;

  const control = element
    ? cloneElement(element, {
        id: controlId,
        'aria-describedby': error
          ? cx(element.props['aria-describedby'], errorId)
          : element.props['aria-describedby'],
      })
    : children;

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={controlId} className="text-xs font-medium text-ink-2">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-crit">
            *
          </span>
        )}
      </label>
      {control}
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
