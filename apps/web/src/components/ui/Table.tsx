'use client';

import type { CSSProperties, ReactNode } from 'react';

/** Горизонтальное выравнивание ячейки — заголовка или тела. */
export type TableAlign = 'left' | 'right' | 'center';

/** Приглушённый тон строки, дублирующий состояние, названное в одной из ячеек. */
export type TableRowTone = 'default' | 'warn' | 'crit';

/** Направление сортировки колонки, по которой упорядочена таблица. */
export type SortDirection = 'asc' | 'desc';

/**
 * Явный класс на каждый вариант вместо интерполяции `text-${align}`: Tailwind 4
 * сканирует исходники как текст и никогда не видит имя класса, которое
 * собирается во время выполнения, — такого класса просто не окажется в стилях.
 */
const ALIGN: Record<TableAlign, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

const JUSTIFY: Record<TableAlign, string> = {
  left: 'justify-start',
  right: 'justify-end',
  center: 'justify-center',
};

const ROW_TONE: Record<TableRowTone, string> = {
  default: '',
  warn: 'bg-warn/10',
  crit: 'bg-crit/10',
};

/** Типографика заголовка колонки из дизайн-системы, без отступов. */
const TH_TYPE = 'text-2xs font-semibold uppercase tracking-[0.06em] text-ink-3 whitespace-nowrap';

function classes(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Оболочка таблицы: горизонтально прокручиваемая область вокруг `<table>` во всю
 * ширину, набранной базовым кеглем 13px.
 *
 * Это сознательно тонкие обёртки над нативными элементами, а не декларативный
 * `<DataTable columns={…} />`. В панели десятки таблиц, и у каждой своя отрисовка
 * ячеек, свои строки-ссылки и своя массовая выборка; декларативному компоненту
 * пришлось бы отрастить проп под каждую из них, а всем страницам — переехать в
 * один день. Обёртки позволяют переводить страницы на дизайн-систему по одной и
 * сохранять внутри ячеек ту разметку, которая там уже есть.
 *
 * **Строка, которая никуда ведёт, кладёт настоящий `<a>` в первую ячейку — и
 * никогда не вешает `onClick` на `<tr>`.** Обработчик клика на строке выглядит
 * так же только при обычном левом клике, а во всём остальном сломан: средней
 * кнопкой не открыть фоновую вкладку, по Cmd/Ctrl+клику не открыть новую, в
 * контекстном меню нет «копировать адрес ссылки», с клавиатуры цель недостижима,
 * а скринридер объявляет обычную строку, ничем не намекая, что она куда-то
 * ведёт. Ссылка возвращает всё это даром, и что делает каждый модификатор,
 * решает браузер, а не панель.
 *
 * `dense` сжимает вертикальный ритм через варианты по потомкам, а не через
 * контекст, — так он достаёт и до ячеек, отрисованных вызывающим кодом глубоко
 * внутри строк.
 */
export function Table({
  dense = false,
  layout = 'auto',
  maxHeight,
  ariaLabel,
  className,
  children,
}: {
  /** Меняет высоту строки на число строк в экране — журналы и аудит. */
  dense?: boolean;
  /** `fixed` заставляет колонки слушаться `width`, а не содержимого. */
  layout?: 'auto' | 'fixed';
  /**
   * Собственная область прокрутки таблицы, например `'60vh'`.
   *
   * Без неё таблица прокручивается вместе со страницей, и шапка прилипает к
   * окну под верхней панелью. С ней таблица получает свой скроллер, и шапка
   * прилипает к его верхнему краю. Промежуточного варианта не существует:
   * блок с `overflow-x: auto` вычисляет `overflow-y` тоже в `auto` и
   * становится областью прокрутки, внутри которой `sticky` уже никогда не
   * сработает от прокрутки страницы.
   */
  maxHeight?: string;
  /** Доступное имя таблицы; обязательно, если её не называет видимая подпись. */
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const scrolls = maxHeight !== undefined;
  return (
    <div
      // Смещение прилипшей шапки публикуется переменной, а не пропсом: сама
      // шапка не должна знать, кто её прокручивает, а вызывающий код — помнить
      // про это при каждом использовании.
      style={
        {
          maxHeight,
          '--table-head-top': scrolls ? '0px' : 'var(--chrome-h)',
        } as CSSProperties
      }
      className={scrolls ? 'overflow-auto' : undefined}
    >
      <table
        aria-label={ariaLabel}
        className={classes(
          'w-full text-[13px]',
          layout === 'fixed' ? 'table-fixed' : 'table-auto',
          dense && '[&_tr]:h-8 [&_th]:py-1 [&_td]:py-1 [&_th_button]:py-1',
          className,
        )}
      >
        {children}
      </table>
    </div>
  );
}

/**
 * Группа строк шапки. По умолчанию прилипает: таблица, которая доросла до
 * прокрутки, — это таблица, названия колонок которой нужны и внизу тоже.
 *
 * Смещение берётся из `--table-head-top`, которую задаёт {@link Table}: у
 * таблицы, прокручиваемой вместе со страницей, это высота верхней панели, а у
 * таблицы с собственным скроллером — ноль. Считать это на месте применения
 * нельзя: `sticky` отсчитывается от ближайшей области прокрутки, и ошибка в
 * выборе даёт либо шапку под навигацией, либо шапку, зависшую на 46px ниже
 * края собственного контейнера.
 *
 * Материал (`bg-surface/90 backdrop-blur-xl`) — не украшение: без достаточно
 * плотного фона строки тела прокручиваются *сквозь* закреплённую шапку.
 */
export function TableHead({
  sticky = true,
  className,
  children,
}: {
  sticky?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <thead
      className={classes(
        sticky && 'sticky top-[var(--table-head-top,0px)] z-20 bg-surface/90 backdrop-blur-xl',
        className,
      )}
    >
      {children}
    </thead>
  );
}

/** Группа строк тела: строки разделяются волосяной линией, а не тенью. */
export function TableBody({ className, children }: { className?: string; children?: ReactNode }) {
  return <tbody className={classes('divide-y divide-line', className)}>{children}</tbody>;
}

/**
 * Строка таблицы высотой 36px.
 *
 * `selected` и `tone` подкрашивают строку, и по правилу дизайн-системы «никогда
 * только цветом» вызывающий код обязан сказать то же самое словами: выделенная
 * строка несёт свой флажок, строка `warn`/`crit` — ячейку состояния. Подсветка
 * ускоряет просмотр тем, кто её видит, и ничего не стоит тем, кто нет.
 */
export function TableRow({
  interactive = false,
  selected = false,
  tone = 'default',
  className,
  children,
}: {
  /** Помечает строку как ведущую куда-то — в паре со ссылкой в первой ячейке. */
  interactive?: boolean;
  selected?: boolean;
  tone?: TableRowTone;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <tr
      className={classes(
        'h-9 transition-colors',
        ROW_TONE[tone],
        interactive && 'hover:bg-raised/40',
        selected && 'bg-accent-dim',
        className,
      )}
    >
      {children}
    </tr>
  );
}

/**
 * Заголовок колонки. Названия пишутся в исходнике обычным регистром, а в
 * верхний их переводит CSS, — так скринридер по-прежнему читает слово, а не
 * произносит его по буквам.
 */
export function Th({
  align = 'left',
  width,
  scope = 'col',
  className,
  children,
}: {
  align?: TableAlign;
  /** Любая длина CSS; действует только вместе с `Table layout="fixed"`. */
  width?: string;
  scope?: 'col' | 'row' | 'colgroup' | 'rowgroup';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <th
      scope={scope}
      style={width ? { width } : undefined}
      className={classes('px-3 py-2', TH_TYPE, ALIGN[align], className)}
    >
      {children}
    </th>
  );
}

/**
 * Заголовок колонки, который упорядочивает таблицу.
 *
 * Ячейка отдаёт свои отступы внутренней `<button>` (через `p-0!`, чтобы их не
 * вернули обратно переопределения `dense`) — кнопка занимает ячейку целиком, и
 * поэтому нажимается весь заголовок, а главное: глобальное кольцо фокуса
 * обводит именно тот заголовок, на котором сейчас стоит клавиатурный фокус.
 *
 * Направление объявляется тремя способами: `aria-sort` на ячейке — для
 * вспомогательных технологий, которые его понимают; стрелка — для зрячих; и
 * `directionText`, который читается как часть имени кнопки, — для всего
 * остального. Этот текст обязателен, а не имеет значения по умолчанию, потому
 * что примитивы не обращаются к словарю переводов: любая человекочитаемая
 * строка приходит со страницы.
 *
 * Стрелку показывает только активная колонка. У остальных — приглушённый двойной
 * шеврон: возможность «эту колонку можно сортировать» должна быть видна, но не
 * должна спорить с той единственной колонкой, которая действительно задаёт
 * порядок данных.
 *
 * `scope` здесь не настраивается: сортируемый заголовок строки бессмыслен —
 * сортируют колонку.
 */
export function SortableTh({
  sortKey,
  activeKey,
  direction,
  onSort,
  label,
  directionText,
  align = 'left',
  width,
  className,
}: {
  /** Идентификатор, который вернётся в {@link onSort}; совпадает с `activeKey` у активной колонки. */
  sortKey: string;
  /** Ключ, по которому таблица упорядочена сейчас, или `null`, если порядка нет. */
  activeKey: string | null;
  direction: SortDirection;
  onSort: (key: string) => void;
  label: ReactNode;
  /** Перевод для каждого направления, например `{ asc: 'по возрастанию', … }`. */
  directionText: Record<SortDirection, string>;
  align?: TableAlign;
  width?: string;
  className?: string;
}) {
  const active = activeKey === sortKey;

  return (
    <th
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={width ? { width } : undefined}
      className={classes('p-0!', TH_TYPE, ALIGN[align], className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={classes(
          'flex h-full w-full items-center gap-1 px-3 py-2 transition-colors hover:text-ink',
          JUSTIFY[align],
        )}
      >
        <span>{label}</span>
        {active ? (
          <>
            <span aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span>
            <span className="sr-only">{directionText[direction]}</span>
          </>
        ) : (
          <span aria-hidden="true" className="text-ink-4">
            ⇅
          </span>
        )}
      </button>
    </th>
  );
}

/**
 * Ячейка тела таблицы.
 *
 * `numeric` — не синоним `align="right"`: он ещё и включает `tabular-nums`, и
 * эти две вещи неразделимы. Колонка выключенных вправо пропорциональных цифр всё
 * равно не выстроится по разряду, а ведь ради этого числа вправо и выключают.
 * Поэтому `numeric` побеждает `align`.
 *
 * `truncate` нужна колонка известной ширины, обо что обрезать: применяйте его
 * вместе с `Table layout="fixed"` и `width` у соответствующего {@link Th}.
 */
export function Td({
  align = 'left',
  numeric = false,
  truncate = false,
  className,
  children,
}: {
  align?: TableAlign;
  numeric?: boolean;
  truncate?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <td
      className={classes(
        'px-3 py-2 align-middle',
        numeric ? 'text-right tabular-nums' : ALIGN[align],
        truncate && 'truncate',
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * Описание таблицы, по умолчанию скрытое визуально.
 *
 * Видимой подписи в этом оформлении места нет — таблица лежит внутри `Card`,
 * шапка которой её уже называет, — но `<caption>` остаётся единственным
 * элементом, который скринридер читает раньше первой строки. Значит, это верное
 * место для фразы о том, что за строки перед пользователем и как они
 * упорядочены.
 */
export function TableCaption({
  visible = false,
  className,
  children,
}: {
  /** Показывает подпись на экране, а не только для вспомогательных технологий. */
  visible?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <caption
      className={classes(visible ? 'px-3 py-2 text-left text-xs text-ink-3' : 'sr-only', className)}
    >
      {children}
    </caption>
  );
}
