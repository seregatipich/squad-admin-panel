'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

export type SegmentedControlItem = {
  /** Стабильный идентификатор сегмента; он же приходит в `onChange`. */
  value: string;
  label: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
};

/** Размер сегмента внутри контейнера: 2px паддинга с каждой стороны дают 32/28px по §6. */
const SEGMENT_SIZE_CLASS = {
  md: 'h-7 px-3 text-xs',
  sm: 'h-6 px-2.5 text-2xs',
} as const;

/**
 * Ближайший недоступный-пропускающий сосед по кругу.
 *
 * WAI-ARIA для tablist требует замыкания на краях, поэтому обход идёт по
 * модулю длины и останавливается, когда вернулся к исходному элементу —
 * ряд, целиком состоящий из `disabled`, не зациклит поиск.
 */
function neighbour(
  items: SegmentedControlItem[],
  from: number,
  delta: 1 | -1,
): SegmentedControlItem | undefined {
  const count = items.length;
  for (let hop = 1; hop <= count; hop += 1) {
    const item = items[(((from + delta * hop) % count) + count) % count];
    if (item && !item.disabled) return item;
  }
  return undefined;
}

/** Первый (`delta = 1`) или последний (`delta = -1`) доступный сегмент — Home/End. */
function edge(items: SegmentedControlItem[], delta: 1 | -1): SegmentedControlItem | undefined {
  const ordered = delta === 1 ? items : [...items].reverse();
  return ordered.find((item) => !item.disabled);
}

/**
 * Сегментированный переключатель состояния — выбор применяется на месте,
 * без перехода по адресу (для подмаршрутов есть `SegmentedNav`).
 *
 * Реализован как `tablist` с roving tabindex: в порядок обхода Tab попадает
 * ровно один сегмент, а внутри ряда навигация идёт стрелками и Home/End.
 * Выбор следует за фокусом — это поведение системного сегментированного
 * контрола Apple и то, ради чего в ряду один `tabIndex=0`.
 *
 * @param items Сегменты слева направо; `disabled` пропускается всеми видами навигации.
 * @param value Значение выбранного сегмента.
 * @param onChange Вызывается со значением сегмента, который стал выбранным.
 * @param size Высота ряда: `md` — 32px, `sm` — 28px.
 * @param ariaLabel Название группы для скринридера; текст приходит от вызывающего кода.
 */
export function SegmentedControl({
  items,
  value,
  onChange,
  size = 'md',
  ariaLabel,
}: {
  items: SegmentedControlItem[];
  value: string;
  onChange: (value: string) => void;
  size?: 'sm' | 'md';
  ariaLabel: string;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  // Если `value` не совпал ни с одним сегментом, ряд всё равно обязан иметь
  // точку входа с клавиатуры — ею становится первый доступный сегмент.
  const selected = items.some((item) => item.value === value) ? value : edge(items, 1)?.value;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((item) => item.value === value);
    let next: SegmentedControlItem | undefined;

    switch (event.key) {
      case 'ArrowRight':
        next = neighbour(items, current, 1);
        break;
      case 'ArrowLeft':
        next = neighbour(items, current, -1);
        break;
      case 'Home':
        next = edge(items, 1);
        break;
      case 'End':
        next = edge(items, -1);
        break;
      default:
        return;
    }

    if (!next) return;
    event.preventDefault();
    buttons.current.get(next.value)?.focus();
    if (next.value !== value) onChange(next.value);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      className="inline-flex gap-0.5 rounded-ctl bg-raised p-0.5"
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              if (node) buttons.current.set(item.value, node);
              else buttons.current.delete(item.value);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={item.value === selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl font-medium transition-colors disabled:cursor-not-allowed disabled:text-ink-4 ${
              SEGMENT_SIZE_CLASS[size]
            } ${active ? 'bg-surface text-ink' : 'text-ink-3 hover:text-ink'}`}
          >
            {item.label}
            {item.badge !== undefined && item.badge !== null && <span>{item.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
