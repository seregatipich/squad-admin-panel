'use client';

import Link from 'next/link';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDownIcon } from './icons';

export type MenuLinkItem = {
  kind: 'link';
  href: string;
  label: ReactNode;
  hint?: ReactNode;
  badge?: ReactNode;
  /** Пункт описывает текущую страницу: подсветка плюс `aria-current="page"`. */
  active?: boolean;
};

export type MenuActionItem = {
  kind: 'action';
  label: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  /** `destructive` — только необратимое разрушающее действие (§5 дизайн-системы). */
  tone?: 'default' | 'destructive';
  disabled?: boolean;
};

export type MenuItem =
  | MenuLinkItem
  | MenuActionItem
  | { kind: 'separator' }
  /** Одна вложенность и без подменю: группа — это колонка внутри той же панели. */
  | { kind: 'group'; label: string; items: MenuItem[] };

export type MenuTrigger = {
  label: ReactNode;
  badge?: ReactNode;
  /** Обязателен, когда `label` — значок: иначе у кнопки нет доступного имени. */
  ariaLabel?: string;
  /**
   * Меню владеет текущей страницей.
   *
   * Это не то же самое, что `open`: раздел остаётся текущим и после того, как
   * меню закрылось, и именно по этому признаку оператор понимает, где он
   * находится.
   */
  active?: boolean;
};

/** Разложенное дерево: у каждого выбираемого пункта — его место в порядке обхода. */
type MenuEntry =
  | { kind: 'separator'; key: string }
  | { kind: 'group'; key: string; label: string; entries: MenuEntry[] }
  | { kind: 'command'; key: string; index: number | null; item: MenuLinkItem | MenuActionItem };

/**
 * Нумерует пункты в порядке обхода клавиатурой.
 *
 * Номер получают только доступные пункты, поэтому разделители, заголовки групп
 * и `disabled` выпадают из навигации сами собой — стрелкам, Home/End и
 * поиску по букве не нужно знать про них ничего.
 */
function buildEntries(items: MenuItem[], counter: { next: number }, prefix: string): MenuEntry[] {
  return items.map((item, position) => {
    const key = `${prefix}${position}`;
    if (item.kind === 'separator') return { kind: 'separator', key };
    if (item.kind === 'group') {
      return {
        kind: 'group',
        key,
        label: item.label,
        entries: buildEntries(item.items, counter, `${key}-`),
      };
    }
    if (item.kind === 'action' && item.disabled) return { kind: 'command', key, index: null, item };
    const index = counter.next;
    counter.next += 1;
    return { kind: 'command', key, index, item };
  });
}

const ALIGN_CLASS = {
  start: 'left-0',
  end: 'right-0',
} as const;

/** Вторая колонка получает фиксированную ширину: `min-w` панели её бы не расширил. */
const COLUMNS_CLASS = {
  1: '',
  2: 'grid w-[26rem] grid-cols-2 gap-x-1',
} as const;

const ITEM_STATE_CLASS = {
  active: 'bg-accent-dim text-ink',
  default: 'text-ink-2 hover:bg-raised hover:text-ink',
  destructive: 'text-crit hover:bg-raised',
  disabled: 'text-ink-4',
} as const;

const ITEM_BASE_CLASS =
  'block w-full rounded-ctl px-2 py-1.5 text-left text-xs no-underline transition-colors';

/**
 * Выпадающее меню верхней панели.
 *
 * Триггер — `aria-haspopup="menu"`, панель — `role="menu"` с `role="menuitem"`
 * у каждого пункта, включая ссылки. Клавиатура ведёт себя так, как ждёт
 * WAI-ARIA: открытие по Enter/Space/стрелке вниз ставит фокус на первый пункт,
 * стрелки ходят по кругу, Home/End прыгают на края, буква перемещает на
 * следующий пункт с этой буквы, Escape закрывает и возвращает фокус на триггер.
 * Разделители, заголовки групп и `disabled` в обход не попадают.
 *
 * Меню раскрывается **по клику, а не по наведению**: панель занимает половину
 * экрана под баром, и курсор, который просто едет по бару в другое место,
 * не должен закрывать собой страницу. По той же причине Tab не запирает фокус
 * внутри, а закрывает меню и уходит дальше по странице — меню не диалог.
 *
 * Состояние `open` живёт снаружи: в баре одновременно раскрыто не больше одного
 * меню, и решает это владелец бара, а не сами меню.
 *
 * @param trigger Подпись кнопки, необязательный счётчик и имя для скринридера.
 * @param items Пункты сверху вниз; `group` разворачивается в колонку с заголовком.
 * @param open Раскрыта ли панель.
 * @param onOpenChange Вызывается с новым состоянием при открытии и любом закрытии.
 * @param align Край триггера, к которому прижата панель.
 * @param columns Число колонок панели: широкое меню раскладывается в две.
 */
export function Menu({
  trigger,
  items,
  open,
  onOpenChange,
  align = 'start',
  columns = 1,
}: {
  trigger: MenuTrigger;
  items: MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align?: 'start' | 'end';
  columns?: 1 | 2;
}) {
  const id = useId();
  const panelId = `${id}-menu`;
  const triggerId = `${id}-trigger`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([]);
  // Куда встать при открытии: стрелка вверх открывает меню на последнем пункте.
  const pendingFocus = useRef<'first' | 'last'>('first');
  const [activeIndex, setActiveIndex] = useState(-1);

  const counter = { next: 0 };
  const entries = buildEntries(items, counter, '');
  const focusableCount = counter.next;

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return;
    }
    const target = pendingFocus.current === 'last' ? focusableCount - 1 : 0;
    pendingFocus.current = 'first';
    if (target < 0) return;
    setActiveIndex(target);
    itemRefs.current[target]?.focus();
  }, [open, focusableCount]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    // Escape слушается на документе, а не на панели: закрыть меню обязано и
    // нажатие, сделанное при фокусе на неинтерактивном месте панели.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onOpenChange(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  const close = (returnFocus: boolean) => {
    onOpenChange(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const openFrom = (edge: 'first' | 'last') => {
    pendingFocus.current = edge;
    onOpenChange(true);
  };

  const moveTo = (index: number) => {
    if (index < 0 || index >= focusableCount) return;
    setActiveIndex(index);
    itemRefs.current[index]?.focus();
  };

  const step = (delta: 1 | -1) => {
    if (focusableCount === 0) return;
    const from = activeIndex < 0 ? -delta : activeIndex;
    moveTo((((from + delta) % focusableCount) + focusableCount) % focusableCount);
  };

  /**
   * Ищет следующий по кругу пункт, начинающийся с набранной буквы.
   *
   * Сравнение идёт по тексту готового узла, а не по пропсу `label`: подпись —
   * это `ReactNode`, у неё может не быть строкового представления вовсе.
   */
  const typeahead = (char: string) => {
    const needle = char.toLowerCase();
    for (let hop = 1; hop <= focusableCount; hop += 1) {
      const index = (activeIndex + hop + focusableCount) % focusableCount;
      const text = itemRefs.current[index]?.textContent ?? '';
      if (text.trim().toLowerCase().startsWith(needle)) {
        moveTo(index);
        return true;
      }
    }
    return false;
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'Enter':
      case ' ':
        // preventDefault гасит штатную активацию кнопки — иначе следом придёт
        // click и тут же вернёт меню в прежнее состояние.
        event.preventDefault();
        if (open) close(false);
        else openFrom('first');
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (open) moveTo(0);
        else openFrom('first');
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (open) moveTo(focusableCount - 1);
        else openFrom('last');
        return;
      default:
    }
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        return;
      case 'End':
        event.preventDefault();
        moveTo(focusableCount - 1);
        return;
      case 'Tab':
        // Без preventDefault: фокус переходит на триггер, и штатный Tab уводит
        // его дальше по странице — ровно то, чего ждут от меню, а не от диалога.
        close(true);
        return;
      case ' ': {
        // Пробел не активирует `<a>` — у ссылок меню это делаем сами.
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
        if (!anchor) return;
        event.preventDefault();
        anchor.click();
        return;
      }
      default:
    }

    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (typeahead(event.key)) event.preventDefault();
  };

  const renderEntry = (entry: MenuEntry): ReactNode => {
    if (entry.kind === 'separator') {
      // Нативные `<hr>` и `<fieldset>` вместо `role="separator"` / `role="group"`
      // на `<div>`: роль та же, но она следует из разметки, а не из атрибута.
      return <hr key={entry.key} className="my-1 border-0 border-t border-line" />;
    }

    if (entry.kind === 'group') {
      return (
        <fieldset key={entry.key} aria-label={entry.label} className="min-w-0">
          <p className="px-2 pb-0.5 pt-1.5 text-2xs uppercase tracking-[0.06em] text-ink-3">
            {entry.label}
          </p>
          {entry.entries.map(renderEntry)}
        </fieldset>
      );
    }

    const { index, item } = entry;
    const registerRef = (node: HTMLAnchorElement | HTMLButtonElement | null) => {
      if (index !== null) itemRefs.current[index] = node;
    };
    // Roving tabindex: в порядок обхода Tab попадает ровно один пункт меню.
    const tabIndex = index !== null && index === activeIndex ? 0 : -1;
    const body = (
      <>
        <span className="flex items-center gap-1.5">
          {item.label}
          {item.kind === 'link' && item.badge !== undefined && item.badge !== null && (
            <span>{item.badge}</span>
          )}
        </span>
        {item.hint !== undefined && item.hint !== null && (
          <span className="block text-2xs text-ink-3">{item.hint}</span>
        )}
      </>
    );

    if (item.kind === 'link') {
      return (
        <Link
          key={entry.key}
          ref={registerRef}
          href={item.href}
          role="menuitem"
          tabIndex={tabIndex}
          aria-current={item.active ? 'page' : undefined}
          onClick={() => close(true)}
          className={`${ITEM_BASE_CLASS} ${item.active ? ITEM_STATE_CLASS.active : ITEM_STATE_CLASS.default}`}
        >
          {body}
        </Link>
      );
    }

    const state = item.disabled
      ? ITEM_STATE_CLASS.disabled
      : ITEM_STATE_CLASS[item.tone ?? 'default'];

    return (
      <button
        key={entry.key}
        ref={registerRef}
        type="button"
        role="menuitem"
        tabIndex={tabIndex}
        disabled={item.disabled}
        onClick={() => {
          item.onSelect();
          close(true);
        }}
        className={`${ITEM_BASE_CLASS} disabled:cursor-not-allowed ${state}`}
      >
        {body}
      </button>
    );
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={trigger.ariaLabel}
        onClick={() => (open ? close(false) : openFrom('first'))}
        onKeyDown={onTriggerKeyDown}
        className={`flex h-8 items-center gap-1 whitespace-nowrap rounded-ctl px-2.5 text-xs transition-colors duration-150 ${
          open || trigger.active
            ? 'bg-raised text-ink'
            : 'text-ink-2 hover:bg-raised/60 hover:text-ink'
        }`}
      >
        {trigger.label}
        {trigger.badge !== undefined && trigger.badge !== null && <span>{trigger.badge}</span>}
        <ChevronDownIcon className="size-3.5 text-ink-3" />
      </button>

      {open && (
        <div
          id={panelId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={onPanelKeyDown}
          className={`absolute z-50 mt-1 max-h-[calc(100vh-var(--chrome-h)-1.5rem)] min-w-56 overflow-y-auto overscroll-contain rounded-card border border-line-2 bg-surface p-1 ${ALIGN_CLASS[align]} ${COLUMNS_CLASS[columns]}`}
        >
          {entries.map(renderEntry)}
        </div>
      )}
    </div>
  );
}
