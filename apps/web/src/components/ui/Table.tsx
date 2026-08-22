'use client';

import type { ReactNode } from 'react';

/** Horizontal alignment of a header or body cell. */
export type TableAlign = 'left' | 'right' | 'center';

/** Muted row tint that mirrors a state already stated in one of the cells. */
export type TableRowTone = 'default' | 'warn' | 'crit';

/** Sort direction of the column a table is currently ordered by. */
export type SortDirection = 'asc' | 'desc';

/**
 * Explicit class per variant instead of an interpolated `text-${align}`:
 * Tailwind 4 scans the sources as text and never sees a class assembled at
 * runtime, so an interpolated name is silently missing from the stylesheet.
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

/** Column-header typography from the design system, minus the padding. */
const TH_TYPE = 'text-2xs font-semibold uppercase tracking-[0.06em] text-ink-3 whitespace-nowrap';

function classes(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * The table shell: a horizontally scrollable viewport around a full-width
 * `<table>` at the panel's 13px body size.
 *
 * These are deliberately thin wrappers over the native elements rather than a
 * declarative `<DataTable columns={…} />`. The panel has dozens of tables, each
 * with its own cell rendering, row links and bulk-selection quirks; a
 * declarative component would have to grow a prop for every one of them, and
 * every page would have to migrate on the same day. Wrappers let a page adopt
 * the design system one table at a time and keep whatever markup it already has
 * inside the cells.
 *
 * **A row that navigates puts a real `<a>` in its first cell — never an
 * `onClick` on the `<tr>`.** A click handler on a row looks identical on a
 * left-click and is broken everywhere else: middle-click cannot open a
 * background tab, Cmd/Ctrl-click cannot open a new one, the context menu has no
 * "copy link address", the target is unreachable by keyboard, and a screen
 * reader announces a plain row with no hint that it leads anywhere. A link
 * gives all of that back for free, and the browser — not the panel — decides
 * what each modifier does.
 *
 * `dense` shrinks the vertical rhythm through descendant variants rather than a
 * context, so it also reaches cells rendered by callers deep inside the rows.
 */
export function Table({
  dense = false,
  layout = 'auto',
  ariaLabel,
  className,
  children,
}: {
  /** Trades row height for rows on screen — log and audit views. */
  dense?: boolean;
  /** `fixed` makes columns obey their `width` instead of their content. */
  layout?: 'auto' | 'fixed';
  /** Accessible name of the table; required whenever no visible caption names it. */
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
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
 * The header row group. Pinned by default, because a table long enough to
 * scroll is a table whose column names are needed at the bottom too.
 *
 * The offset is `top-0`, not the `--chrome-h` used by page-level sticky layers:
 * {@link Table} wraps the table in `overflow-x-auto`, and a box with
 * `overflow-x: auto` computes `overflow-y` to `auto` as well, which makes that
 * wrapper — not the viewport — the scrollport the header sticks inside. Offset
 * by the top bar's height here and the header would float 46px below the edge
 * of its own container.
 *
 * The material (`bg-surface/90 backdrop-blur-xl`) is not decoration: without an
 * opaque-enough background the body rows scroll *through* the pinned header.
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
      className={classes(sticky && 'sticky top-0 z-20 bg-surface/90 backdrop-blur-xl', className)}
    >
      {children}
    </thead>
  );
}

/** The body row group; rows are separated by hairlines, never by shadow. */
export function TableBody({ className, children }: { className?: string; children?: ReactNode }) {
  return <tbody className={classes('divide-y divide-line', className)}>{children}</tbody>;
}

/**
 * A table row, 36px tall.
 *
 * `selected` and `tone` tint the row, and per the design system's "never colour
 * alone" rule the caller must also say the same thing in words: the selected
 * row carries its checkbox, the `warn`/`crit` row carries a status cell. The
 * tint speeds up scanning for people who see it and costs nothing to those who
 * do not.
 */
export function TableRow({
  interactive = false,
  selected = false,
  tone = 'default',
  className,
  children,
}: {
  /** Marks the row as pointing somewhere — pair it with a link in the first cell. */
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
 * A column header. Names are written in ordinary sentence case in the source
 * and rendered uppercase by CSS, so a screen reader still reads a word rather
 * than spelling out capitals.
 */
export function Th({
  align = 'left',
  width,
  scope = 'col',
  className,
  children,
}: {
  align?: TableAlign;
  /** Any CSS length; only takes effect with `Table layout="fixed"`. */
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
 * A column header that orders the table.
 *
 * The cell delegates its padding to an inner `<button>` (`p-0!` so the `dense`
 * overrides cannot put it back) — the button then fills the whole cell, which
 * makes the entire header clickable and, more importantly, makes the global
 * focus ring outline the header a keyboard user is actually on.
 *
 * Direction is announced three ways: `aria-sort` on the cell for assistive
 * technology that understands it, an arrow for sighted users, and
 * `directionText` read out as part of the button's name for everything else.
 * That text is required rather than defaulted because these primitives never
 * touch the translation dictionary — every human-readable string arrives from
 * the page.
 *
 * Only the active column shows an arrow. Inactive columns show a dimmed double
 * chevron: the affordance "this can be sorted" has to be visible, but it must
 * not compete with the one column that actually orders the data.
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
  /** Identifier handed back to {@link onSort}; matches `activeKey` when active. */
  sortKey: string;
  /** Key the table is currently ordered by, or `null` when it is unordered. */
  activeKey: string | null;
  direction: SortDirection;
  onSort: (key: string) => void;
  label: ReactNode;
  /** Translated wording for each direction, e.g. `{ asc: 'по возрастанию', … }`. */
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
 * A body cell.
 *
 * `numeric` is not an alias for `align="right"`: it also turns on
 * `tabular-nums`, and the two belong together — a column of right-aligned
 * proportional digits still fails to line up on the decimal, which is the whole
 * reason the numbers are right-aligned in the first place. It therefore wins
 * over `align`.
 *
 * `truncate` needs a column of known width to clip against: use it with
 * `Table layout="fixed"` and a `width` on the matching {@link Th}.
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
 * The table's description, visually hidden by default.
 *
 * A visible caption has no place in this design language — a table sits inside
 * a `Card` whose header already names it — but a `<caption>` is still the one
 * element a screen reader reads before the first row, so it is the right place
 * for the sentence that explains what the rows are and how they are ordered.
 */
export function TableCaption({
  visible = false,
  className,
  children,
}: {
  /** Renders the caption on screen instead of only for assistive technology. */
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
