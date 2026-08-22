import type { ReactNode } from 'react';

/** Inner spacing steps allowed on a card surface: `md` = 16px, `sm` = 12px. */
export type CardPadding = 'none' | 'sm' | 'md';

/**
 * Explicit class per variant rather than an interpolated `p-${padding}`:
 * Tailwind 4 scans the sources as text and never sees a class it has to
 * assemble at runtime.
 */
const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
};

const GRID_COLS: Record<2 | 3 | 4, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};

function classes(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * A grouped surface: the panel's second elevation level (`bg-surface` on the
 * page's `bg-bg`), 10px continuous corners, hairline border, no shadow —
 * depth is carried by the surface, as in Apple's dark appearance.
 *
 * The card deliberately has **no** outer margin. Spacing between siblings
 * belongs to the parent (`space-y-6` between page blocks, `gap-4` inside a
 * {@link CardGrid}); a card that pushed its neighbours away would make those
 * two rhythms fight each other wherever a card is nested or reordered.
 *
 * Use `padding="none"` when the content brings its own edges — a table, a
 * `divide-y` settings list, or a {@link CardHeader}/{@link CardBody} stack.
 */
export function Card({
  padding = 'md',
  className,
  children,
  as: Tag = 'div',
}: {
  padding?: CardPadding;
  className?: string;
  children?: ReactNode;
  /** Semantic element to render; `section`/`article` when the card is a landmark. */
  as?: 'div' | 'section' | 'article';
}) {
  return (
    <Tag
      className={classes('rounded-card border border-line bg-surface', PADDING[padding], className)}
    >
      {children}
    </Tag>
  );
}

/**
 * The card's title row: name on the left, optional count beside it, actions on
 * the right, optional explanation underneath.
 *
 * The title is 13px semibold — the same size as body text, separated only by
 * weight. An operations screen carries up to ten cards at once; giving each a
 * 17px or 22px heading produces ten competing anchors and destroys the page's
 * own hierarchy, where exactly one thing (the page title) is meant to read as
 * the largest. Weight, not size, is what marks a level here.
 *
 * `divided` (on by default) makes the header supply its own `px-4 py-3` and a
 * bottom hairline, which is what a header inside `Card padding="none"` needs.
 * Turn it off when the surrounding {@link Card} already pads its content.
 */
export function CardHeader({
  title,
  count,
  description,
  actions,
  sticky = false,
  divided = true,
  headingLevel = 2,
  className,
}: {
  title: ReactNode;
  /** Number shown next to the title, muted — «Игроки 128». */
  count?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Pins the header while the card's body scrolls under it. */
  sticky?: boolean;
  /** Supply own `px-4 py-3` + bottom border — for `Card padding="none"`. */
  divided?: boolean;
  /** Heading rank, so a card nested under a section heading stays in order. */
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  return (
    <div
      className={classes(
        divided && 'border-b border-line px-4 py-3',
        // Material only where a layer actually floats over content.
        sticky && 'sticky top-0 z-10 bg-surface/80 backdrop-blur-xl',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Heading className="truncate text-[13px] font-semibold text-ink">{title}</Heading>
          {count !== undefined && count !== null && count !== false && (
            <span className="shrink-0 text-xs tabular-nums text-ink-3">{count}</span>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="mt-1 text-xs text-ink-3">{description}</p>}
    </div>
  );
}

/** The card's content area. Pads itself, so the {@link Card} does not have to. */
export function CardBody({
  padding = 'md',
  className,
  children,
}: {
  padding?: CardPadding;
  className?: string;
  children?: ReactNode;
}) {
  return <div className={classes(PADDING[padding], className)}>{children}</div>;
}

/**
 * The card's action row. Actions are right-aligned per HIG: the confirming
 * button sits rightmost, where the eye finishes reading the card.
 */
export function CardFooter({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div
      className={classes(
        'flex items-center justify-end gap-2 border-t border-line px-4 py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Responsive grid of cards. The gutter is fixed at `gap-4` — the one spacing
 * step the design system allows between cards, so every dashboard on every
 * page lines up on the same 8-point rhythm regardless of column count.
 */
export function CardGrid({
  cols = 3,
  className,
  children,
}: {
  cols?: 2 | 3 | 4;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={classes('grid grid-cols-1 gap-4', GRID_COLS[cols], className)}>{children}</div>
  );
}
