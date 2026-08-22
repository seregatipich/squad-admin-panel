import type { ReactNode, SVGProps } from 'react';

/**
 * Единый набор значков панели.
 *
 * До него интерфейс рисовал стрелки, крестики и шевроны текстовыми символами
 * — «▾» кеглем 8px, «✕», «↻», «→», «⌕». Такие глифы берутся из системного
 * шрифта, поэтому их вес, размер и вертикальное положение меняются от машины
 * к машине и никогда не совпадают с соседним текстом. Значок здесь — вектор
 * фиксированной оптической ширины: сетка 16×16, обводка 1.5 и `currentColor`,
 * то есть цвет наследуется от текста, а не задаётся отдельно (§5, §15).
 *
 * Все значки декоративны: рядом с каждым обязана быть подпись или
 * `aria-label` у кнопки, поэтому `aria-hidden` проставлен здесь и его не надо
 * помнить на месте применения.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'aria-hidden'>;

function Icon({ className = 'size-4', children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.25 8 10.25 12 6.25" />
    </Icon>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9.75 8 5.75 12 9.75" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.75 4 5.75 8 9.75 12" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.25 4 10.25 8 6.25 12" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4 12 12M12 4 4 12" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10 13.5 13.5" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.16" />
      <path d="M13.5 2v3h-3" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.5 8h-9M7 3.5 3.5 8 7 12.5" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8h9M9 3.5 12.5 8 9 12.5" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  );
}

/** Направление сортировки не задано: обе стрелки приглушены. */
export function SortIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 6.5 8 3 11.5 6.5M4.5 9.5 8 13 11.5 9.5" />
    </Icon>
  );
}

export function SortAscIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
    </Icon>
  );
}

export function SortDescIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5 14.5 13.5h-13Z" />
      <path d="M8 6.5v3.25" />
      <path d="M8 11.75h.01" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.5" />
      <path d="M8 5h.01" />
    </Icon>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3.5h3.5V7" />
      <path d="M12.5 3.5 7.75 8.25" />
      <path d="M12 9.5v3h-9v-9h3" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
      <path d="M10.5 3.5h-7v7" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 4.5h9" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="m5.25 4.5.7 8h4.1l.7-8" />
    </Icon>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
    </Icon>
  );
}
