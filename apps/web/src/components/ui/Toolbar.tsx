'use client';

import type { ReactNode } from 'react';
import { Button } from './Button';

/** Слоты панели инструментов. Каждый — готовый узел, примитив его не переводит. */
type ToolbarSlots = {
  search?: ReactNode;
  filters?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
};

/**
 * Сброс — это пара: обработчик и подпись к нему.
 *
 * Разнести их на два необязательных пропа значит разрешить кнопку без текста,
 * то есть без доступного имени. Тот же приём, что у `IconButton.label`:
 * дефект доступности ловится типом, а не глазами на ревью.
 */
type ToolbarReset =
  | { onReset: () => void; resetLabel: string }
  | { onReset?: undefined; resetLabel?: undefined };

export type ToolbarProps = ToolbarSlots & ToolbarReset;

/**
 * Панель инструментов над списком: поиск, фильтры, сводка и действия.
 *
 * Порядок слотов зафиксирован здесь и одинаков во всех списках панели —
 * поиск слева, дальше фильтры, сброс, сводка и действия справа. Это не
 * эстетика: оператор за смену открывает десятки списков и ищет нужный
 * элемент управления мышечной памятью, по месту на экране. Список, который
 * переставил поиск и фильтры «потому что так лучше смотрится», стоит ему
 * одного лишнего чтения панели на каждом открытии. Поэтому страницы передают
 * содержимое слотов, но не их порядок и не раскладку.
 *
 * Текст приходит только пропсами: примитив не знает про словарь переводов.
 *
 * @param search Поле поиска ({@link SearchField}); занимает всю свободную ширину.
 * @param filters Селекторы и переключатели фильтров, прижаты вправо.
 * @param summary Итог выдачи («найдено 128»); набирается `tabular-nums`,
 *   чтобы число не дёргало соседей при каждом обновлении.
 * @param actions Действия над списком — экспорт, создание записи.
 * @param onReset Сброс фильтров. Кнопка появляется только вместе с ним.
 * @param resetLabel Подпись кнопки сброса; обязательна вместе с `onReset`.
 */
export function Toolbar({ search, filters, summary, actions, onReset, resetLabel }: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Гибкая ячейка остаётся в разметке и без поиска: она и прижимает
          остальные слоты вправо, поэтому список без поиска выглядит так же,
          как список с ним. */}
      <div className="min-w-0 flex-1">{search}</div>

      {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}

      {onReset && (
        <Button variant="plain" size="sm" onClick={onReset}>
          {resetLabel}
        </Button>
      )}

      {summary && <div className="text-xs tabular-nums text-ink-3">{summary}</div>}

      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
