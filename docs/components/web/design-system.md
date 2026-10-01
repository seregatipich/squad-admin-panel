# Panel design system — Apple HIG, dark appearance

The panel follows the Apple Human Interface Guidelines to the extent they apply
to a dense desktop web interface: the operator looks at the same screen
for an entire shift, works with a mouse and keyboard, and almost everything they do is
reading wide tables and launching actions against a server.

The tokens live in [`apps/web/src/styles/globals.css`](../../../apps/web/src/styles/globals.css);
this document describes **how** to use them and is the source of truth
for any new markup. The primitives that implement the rules are in
`apps/web/src/components/ui/`.

## 1. Hierarchy and typography

The base font size is 13px (`body`). The scale is derived from the macOS HIG scale and compressed to
five levels; the HIG does not recommend more levels on a single screen.

| Role | Classes | Where it applies |
|---|---|---|
| Page title | `text-[22px] font-semibold tracking-[-0.01em]` | exactly one per page, via `PageHeader` |
| Section title | `text-[17px] font-semibold` | heading of a large block within a page |
| Card title | `text-[13px] font-semibold` | `CardHeader` |
| Body text | `text-[13px]` (default) | content, table cells |
| Secondary text | `text-xs text-ink-3` | captions, hints, metadata |
| Overline | `text-2xs uppercase tracking-[0.06em] text-ink-3` | only utility labels above a value |

Rules:

- **11px is the lower bound.** Nothing smaller than `text-2xs` exists in the interface.
- **Capital letters only for utility labels** («СЕРВЕРЫ» (SERVERS), «CPU»). Meaningful
  text — page titles, column names, names — is set in regular
  case: the HIG considers capitals harmful to reading speed.
- **Weight instead of size.** Levels are distinguished with `font-semibold`, not by a
  jump in font size: this keeps the density even.
- Numbers that stack into columns are set with `tabular-nums` (enabled
  globally for `table` and the `.tabular` class).

## 2. Grid and spacing

8-point grid. Allowed: `gap-1 gap-2 gap-3 gap-4 gap-6 gap-8`
(4/8/12/16/24/32px) — and nothing in between.

The only exception is `gap-1.5` (6px) **inside a single row group**:
an icon and its caption, a label and the number next to it. The grid lays out blocks, while
the optical gap inside a single control does not follow it: 4px
glues an icon to its text, 8px tears them into two things. In page markup
and between cards `gap-1.5` is not used.

| Level | Spacing |
|---|---|
| Between large page blocks | `space-y-6` |
| Between cards in a grid | `gap-4` |
| Inside a card | `p-4`, for a dense one — `p-3` |
| Between a caption and a value | `gap-1` |

The vertical page margins are set **only** by `PageContainer`. A page does not
add `py-*` or `pb-20`.

### 2.1. What to do when it does not fit

**There is no horizontal scrolling in navigation.** An item that slips past the edge of the
bar is unreachable, and the only sign of its existence is a
thin scrollbar that cannot be seen. At 1024px three of seven
sections disappeared this way, including «Настройки» (Settings).

The rule: whatever does not fit goes into the «Ещё» (More) menu — the bar stays on one
line at any width, and no section becomes unreachable. The decision is
made by `fitNavEntries` (`src/lib/nav-overflow.ts`) from the measured widths;
space for the «Ещё» (More) button itself is reserved in advance, otherwise the last item that fit
would push it past the edge.

Horizontal scrolling is acceptable only for **content** that is wider than the screen
by nature: a wide table, a code block, a log. Navigation is
not among them.

## 3. Content width

Five different `max-w` values in one application make five different applications. The width
is chosen from four variants via `PageContainer width=…`:

| `width` | Value | What it is for |
|---|---|---|
| `full` (default) | `max-w-[1600px]` | tables, dashboards, operational screens |
| `wide` | `max-w-6xl` | list + details, calendars |
| `reading` | `max-w-3xl` | settings, grouped lists |
| `form` | `max-w-xl` | a single form, a wizard |

## 4. Surfaces, borders, radii

Three levels and only these: `bg-bg` (page) → `bg-surface` (card) →
`bg-raised` (nested control, active state).

- Dividers — `border-line`, inside lists — `divide-y divide-line`.
- Radii — `rounded-card` (10px) for cards and `rounded-ctl` (6px) for
  controls. The `rounded` value (4px) is not used.
  The exception is `rounded-sm` on **data marks** 8–10px in size (a legend
  swatch, a heatmap cell, the tip of a bar): 6px turns such a
  square into a circle, and a circle in a legend already means something else — a state.
- Shadows are not used **anywhere, including floating layers**: menus, the command
  palette, the dialog and the popup notification are separated from the background by a border and a
  surface. Depth is conveyed by the surface, as in Apple's dark appearance.
- **Material only on sticky layers; floating layers are opaque.** The top
  bar, the server strip, the table header, the sticky card header are
  `bg-surface/80 backdrop-blur-xl`: content scrolls under them, and the blur
  shows that it is there. Menus, the command palette, search suggestions are
  solid `bg-surface`. The reason is technical and hard: `backdrop-filter`
  creates its own root, and an element **inside** a blurred ancestor gets no blur of its own at
  all — only a semi-transparent fill remains, through
  which the page text shows. The top bar's dropdown menu was see-through
  in exactly this way.
- Material (`bg-surface/80 backdrop-blur-xl`) is only for sticky layers:
  the top bar, the server bar, the table header, the dialog backdrop.

## 5. Color

Color means state, not decoration.

- `accent` — "you can click here": links, the primary action, selection.
- `good` / `warn` / `crit` — system state.
- `crit` as a button background is **only** for an irreversible destructive action.
  The ordinary «Удалить фильтр» (Delete filter), «Завершить сессию» (End session), «Отмена» (Cancel) are secondary buttons.
- The remaining hues exist only so that neighboring categories (chart series, role
  colors) can be told apart. A categorical hue is declared as a named constant
  with a comment on why it is categorical, rather than written as an inline string.
- **Text on a tinted background uses `*-ink`, not the token itself.** On its own
  tinted background (`bg-accent-dim`, `bg-warn/10`, …) the state token drops to
  4.01:1 (accent) and 3.98:1 (crit) over the card and fails AA for 11px —
  and nothing smaller than 11px exists in the panel. The `accent-ink` / `good-ink` /
  `warn-ink` / `crit-ink` tokens give 4.96–6.55 on the same backgrounds.
- **Never color alone.** Any state is duplicated with text or an icon.

The stock Tailwind scales (`neutral-800`, `sky-300`, …) are not used at all in new
markup: they exist only for compatibility and are allowed only
where the hue is genuinely categorical (`RoleColorDot`, chart shares).

## 6. Controls

| Element | Height | Classes |
|---|---|---|
| Button `md` | 32px | `h-8 px-3 rounded-ctl text-xs font-medium` |
| Button `sm` | 28px | `h-7 px-2.5 rounded-ctl text-2xs font-medium` |
| Icon button | 28×28px | `h-7 w-7 grid place-items-center rounded-ctl` |
| Input field | 32px | `h-8 px-2.5 rounded-ctl bg-raised border border-line` |

28px is the lower bound of a pointer target (macOS HIG); anything
smaller is considered a defect. An icon button must have an `aria-label`.

Button variants: `primary` (`bg-accent text-bg`), `secondary`
(`bg-raised text-ink border border-line`), `ghost` (no background, `hover:bg-raised`),
`destructive` (`bg-crit text-bg`), `success` (`bg-green-700 text-white`),
`plain` (text-only, `text-accent`).

`success` is an affirmative action that unlocks a capability (for example
«Изменить» (Edit), which lifts read-only mode in the config editor). It is not
`primary`: the main action of a form stays blue. The background is taken from the dark
step of the green scale, not from the semantic `good` (#30d158) — that one is designed for
text and badges, white on it gives 1.9:1, whereas `green-700` gives 5.35:1.

The order in a dialog footer follows the HIG: the confirm button is on the **right**, cancel
to its left; Escape and «Отмена» (Cancel) do the same thing.

## 7. Focus and keyboard

The global rule `:focus-visible { outline: 2px solid accent; offset 2px }`
is already in place. No component may remove it.

- Dropdown menu — `role="menu"` + `role="menuitem"`, up/down arrows,
  Home/End, Escape, focus returns to the trigger.
- Modal window — a native `<dialog>`: the browser itself provides the focus trap,
  the top layer, `::backdrop` and Escape.
- A sortable table header — a `<button>` with `aria-sort` on the `<th>`.

## 8. States

Every screen must answer four questions: what is loading, what is empty, what
broke, what is happening.

- **Loading** — a `Skeleton` in the shape of the future content, not a «Загрузка…» (Loading…) string.
- **Empty** — an `EmptyState` with a title, an explanation and an action. "Nothing exists" and
  "nothing matched the filter" are distinguished.
- **Error** — `InlineBanner tone="crit"` with text and a «Повторить» (Retry) button.
- **In progress** — the button switches to `loading`, stays in place and does not change
  width.

## 9. Motion

Only to explain a change: `transition-colors duration-150`,
a layer appearing — `duration-200 ease-out`. Pulsing is reserved for the
"data is flowing right now" indicator and is not applied anywhere else.
`prefers-reduced-motion` is already handled globally.

## 10. Tables

- The header sticks and knows to what. `Table` chooses the scroll model: without
  `maxHeight` the table scrolls with the page and the header sticks to the window under the
  top bar, with `maxHeight` the table has its own scroller and the header sticks to
  its edge. The offset is published as the `--table-head-top` variable, and `TableHead`
  simply reads it. There is no intermediate variant: a block with `overflow-x: auto`
  computes `overflow-y` to `auto` as well and becomes a scroll container itself,
  inside which `sticky` no longer reacts to page scrolling.
- Numeric columns — `text-right tabular-nums`.
- Row height — 36px (`h-9`), dividers `divide-y divide-line`,
  hover — `hover:bg-raised/40`.
- A link row — a real `<a>` inside the first cell, not an `onClick` on the `<tr>`.
- Column headers are translated: there are no English labels in a Russian header.

## 11. Grouped lists (settings)

The settings screen is a `Card` with `divide-y divide-line`: a row = caption on the left,
control on the right, explanation under the caption in `text-xs text-ink-3`.
The explanation for a group goes under the card, not inside it. This is a direct analog of Apple's inset grouped
tables and replaces a scatter of heterogeneous forms.

## 12. Navigation

- The top bar (46px) is the only global navigation; there is no side column.
- Subsections of a section — `SegmentedNav`, not a row of links with arrows.
- Depth does not exceed two levels: bar → menu → page.
- Any nested page shows a way back via `PageHeader backHref`.
