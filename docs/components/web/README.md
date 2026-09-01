# `web` — Next.js dashboard

Next.js 15 (App Router) + React 19 + Tailwind CSS 4. UI is in Russian. Server components handle auth gates; client components do polling and live updates over WebSocket.

## Responsibilities

- Dashboard, server detail, install wizard, config editor, players, audit, panel-wide log console, account.
- Единый вход через `bss.games`, локальный и глобальный выход; `/me` для самообслуживания игроков без `panel_access`.
- Live indicators: connection state, polling staleness, WS reconnect with exponential backoff.

## What this component does NOT do

- It does not call the bridge directly — it goes through `api`.
- Next.js middleware never authorises. The real gate is server-side `requireSession()` inside `src/app/(dashboard)/layout.tsx`, deduped via `react.cache()`. This is intentional after CVE-2025-29927. Since VIPSUB-5 (#171) a session alone no longer implies panel access, so the same layout also redirects a session with an empty `permissions` array to `/me`.

## App Router pages

| Route | File | What it does |
|---|---|---|
| `/login` | `src/app/login/page.tsx` | Проверяет текущий сеанс и без лишнего клика запускает единый вход через `bss.games`; при ошибке оставляет ручную кнопку повтора без цикла. |
| `/me` | `src/app/(me)/me/page.tsx` | «Мой VIP» (VIPSUB-5, #171) для пользователя без `panel_access`. Показывает собственный баланс, срок VIP, тарифы, подписку и историю бонусов через `/api/v1/me/*`. Шапка даёт перейти на сайт, выйти только из панели либо завершить все сеансы сайта и панели. |
| `/dashboard` | `src/app/(dashboard)/dashboard/page.tsx` | Hub: bridge status, host metrics tile (live), per-worker heartbeats, server count summary. The metrics tile opens the `MetricHistoryModal` for 24 h history. |
| `/servers` | `src/app/(dashboard)/servers/page.tsx` | List with live `rcon_state` / `player_count` / `last_poll_at`. |
| `/servers/new` | `src/app/(dashboard)/servers/new/page.tsx` | Install wizard: collects display name + ports, `POST /servers`, then `POST /servers/:id/install`, subscribes to `/install/ws`. |
| `/servers/[id]/*` (section frame) | `src/app/(dashboard)/servers/[id]/layout.tsx` | Owns the server name as the section's single `<h1>` and renders the subsection tabs (`SegmentedNav`) with `aria-current`. Subpages render section titles only, never their own `<h1>`. Replaced the row of nine `Конфиги →`-style links that had no active state and no way back. |
| `/servers/[id]` | `src/app/(dashboard)/servers/[id]/page.tsx` | Detail: status, container stats, RCON, action buttons (start/stop/restart/delete), live `/logs/ws` console. Delete confirm copy explains: "Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел Архив серверов)." |
| `/servers/[id]/configs` | `src/app/(dashboard)/servers/[id]/configs/page.tsx` | Monaco editor with three tabs: Editor / История (versions, restore, diff) / Blame. `Admins.cfg`'s `//SQUAD-PANEL` managed segment is highlighted and made read-only inside the editor via a decorations overlay + undo-guard (`managed-segment.ts`; monaco 0.56.0 has no read-only-range API) — the rest of the file stays editable and a banner links to `/settings/groups`. `requires_restart` files show a "Рестарт сервера" button (needs `server:restart` from `/api/v1/me`). CRLF line endings are preserved on save. |
| `/servers/[id]/events` | `src/app/(dashboard)/servers/[id]/events/page.tsx` | Newest envelopes from `events:server:{id}` via `GET /servers/:id/events`. |
| `/servers/[id]/schedule` | `src/app/(dashboard)/servers/[id]/schedule/page.tsx` | AUTO-2 scheduled tasks (restart / layer / broadcast) on a one-off instant or 5-field UTC cron, plus a read-only run history. Actions the caller lacks permission for (per the API `capabilities`) are hidden. MSG-4 (#187): a `broadcast` task shows the `TemplatePicker` (`{server}` substituted at rule-creation) feeding an ordered rotation list (up to 10 messages, free-text fallback), a server multi-select ("all servers") posting `server_ids`, and a client-side 5-minute floor via `minCron5IntervalMinutes` that disables submit with an inline hint; each broadcast task lists its rotation and highlights the current `rotation_index`. |
| `/servers/archive` | `src/app/(dashboard)/servers/archive/page.tsx` | Soft-deleted servers table (`GET /api/v1/servers/archive`): display name, slug, deleted_at, deleted_by. Row click → archive detail. |
| `/servers/archive/[id]` | `src/app/(dashboard)/servers/archive/[id]/page.tsx` | Archive detail: settings snapshot + per-file backup browser. Each cfg row opens a read-only Monaco viewer fed by `GET /api/v1/servers/archive/:id/configs/:filename`. "Восстановить" CTA navigates to the restore wizard. |
| `/servers/archive/[id]/restore` | `src/app/(dashboard)/servers/archive/[id]/restore/page.tsx` | Restore wizard: enter slug + display_name → POST /restore (handles 409 inline) → POST /install → tail install WS → POST /restore-configs (shows `files_restored` / `files_skipped` / `files_missing` summary) → POST /start → "Открыть сервер". |
| `/players` | `src/app/(dashboard)/players/page.tsx` | Recently-seen players. |
| `/all-players/[id]` | `src/app/(dashboard)/all-players/[id]/page.tsx` | Player card with name, location and activity history. The role section (gated by `user:manage_roles`) shows the current assignment, removes it through `DELETE /api/v1/players/:id/role`, and opens the same locale-independent `ДД/ММ/ГГГГ` expiry field and explained optional grant comment as `/users`. Owner is excluded from assignment; 409 "last Owner" errors surface inline. |
| `/audit` | `src/app/(dashboard)/audit/page.tsx` | Page-paginated audit log; live indicator showing freshness. |
| `/logs` | `src/app/(dashboard)/logs/page.tsx` | Panel-wide connector logs with filters (source, level, server, free-text). Server component that pre-fetches the server list, hands off to the `LogList` client component which polls `GET /logs`. |
| `/roles` | `src/app/(dashboard)/roles/page.tsx` | List all roles with color dot, Системная badge, user count, edit/delete actions. Delete blocked for Owner; confirm dialog shows affected user count. |
| `/roles/new` | `src/app/(dashboard)/roles/new/page.tsx` | Create role form — wraps `RoleEditor`, POSTs to `/api/v1/roles`, redirects to list. |
| `/roles/[id]` | `src/app/(dashboard)/roles/[id]/page.tsx` | Edit role — loads via `GET /api/v1/roles/:id`, wraps `RoleEditor`; Owner role is rendered in read-only mode. |
| `/settings` | `src/app/(dashboard)/settings/page.tsx` | Section index. The address had no page of its own before the HIG redesign — the section's twenty pages existed only as dropdown entries. The list is derived from `lib/nav.ts` and gated by the same `permission` keys, so a page added to the menu appears here without a second edit. `settings/layout.tsx` fixes one content width for the whole section. |
| `/settings/account` | `src/app/(dashboard)/settings/account/page.tsx` | Account identity (name + nickname history in the header), own in-game statistics («Игровая статистика» + «Последние матчи») and session management — list active sessions, revoke individual or all. |
| `/users` | `src/app/(dashboard)/users/page.tsx` | Table of all players with a non-NULL role (nick, SteamID64, role with color dot, last_seen). "Назначить роль игроку" button (gated by `user:manage_roles`) opens a modal with debounced `GET /api/v1/players?q=` typeahead + role dropdown. The shared expiry control always renders `ДД/ММ/ГГГГ`, opens the native calendar from its whole visible surface, and stores the selected UTC day inclusively; the optional comment is identified as an admin-visible grant reason. Owner is excluded from assignment. |

## Design system

The panel is styled against Apple's Human Interface Guidelines, dark appearance.
[`design-system.md`](design-system.md) is the contract: type scale, 8-point
spacing, the four allowed content widths, the three surface levels, colour as
state, minimum hit targets, required screen states, and the rules for tables and
grouped lists. Tokens themselves live in `apps/web/src/styles/globals.css`.

`apps/web/src/components/ui/` holds the primitives that implement those rules.
New UI is composed from them rather than from hand-written utility strings:

| Primitive | What it is |
|---|---|
| `PageContainer`, `PageHeader` | The page frame — the only place a page's width, vertical rhythm and `<h1>` are decided. |
| `Card`, `CardHeader`, `CardBody`, `CardFooter`, `CardGrid` | Grouped surface at one elevation. |
| `Button`, `ButtonLink`, `IconButton` | Every action. Variants carry intent (`destructive` means irreversible), sizes carry the 32/28px control scale. |
| `Table`, `TableHead`, `TableBody`, `TableRow`, `Th`, `SortableTh`, `Td` | Thin wrappers over native table elements: sticky head, `aria-sort`, right-aligned numerics. |
| `Toolbar`, `SearchField`, `Pagination` | The fixed layout above every list — search, filters, counter, reset. |
| `EmptyState`, `Skeleton`, `SkeletonTable`, `InlineBanner` | The four screen states: loading, empty, error, filtered-empty. |
| `Modal`, `AlertDialog` | Built on native `<dialog>`, so focus trapping, the top layer and Escape come from the browser. |
| `Field` (`TextInput`, `Textarea`, `Select`, `Checkbox`, `Switch`, `FieldRow`), `GroupedList`, `GroupedRow` | Forms and inset-grouped settings lists. |
| `SegmentedControl`, `SegmentedNav`, `Menu` | Switching state and switching route, keyboard-navigable. |
| `Badge`, `StatusBadge`, `StatusDot`, `StatTile`, `DateTime` | Labels, state, metrics and a single time format. |

Primitives never read the translation dictionary — every human-readable string,
`aria-label` included, arrives as a prop. That keeps them free of locale
plumbing and keeps the dictionary a single-owner file.

### Dates and times

Every timestamp goes through `DateTime`, `formatAbsolute` or `formatClock`, and
each of them **requires** an explicit BCP-47 locale — call sites read it from
`useIntlLocale()` (`src/i18n/LocaleProvider.tsx`), which maps the (single) UI
locale to the tag `Intl` wants (`ru` → `ru-RU`).

A bare `toLocaleString()` / `toLocaleDateString()` / `toLocaleTimeString()`
formats in the *viewer's browser* locale, which has nothing to do with the
language the panel is showing: the players table printed
`8/23/2026, 11:35:00 AM` while the report queue two clicks away printed
`22.08.2026, 03:33`, and both changed with the machine and its ICU version.
`src/i18n/date-locale.regression.test.ts` scans the sources and fails the build
if a locale-less call comes back.

## Components

`apps/web/src/components/`:

| File | Purpose |
|---|---|
| `LiveIndicator.tsx` | Shared "fresh / stale / disconnected" pill used by every polling surface. Hover shows last-success age. |
| `connection-banner.tsx` | Sticky top banner rendered by the dashboard layout. Reads `useLiveBusState()` + `useBridgeState()` from `src/lib/use-live-bus.ts`. Renders nothing when WS is `open` and bridge state is not `down`; renders red "Связь с панелью потеряна — переподключаемся…" when WS is not open; renders amber "Bridge не отвечает — операции с сервером временно недоступны" when the bridge is down. |
| `LogConsole.tsx` | Per-server live log viewer over `/api/v1/servers/:id/logs/ws`. Auto-scroll, ANSI stripping, error/`done` frames. |
| `LogList.tsx` | Panel-wide connector-logs client component used by `/logs`. Cursor-paginated against `GET /logs`, filter pills, "live tail" toggle. |
| `LogoutButton.tsx` | Локальный `POST /auth/logout` с возвратом на `/login` и глобальный `POST /auth/logout-all` с переходом на проверенный адрес сайта. |
| `RestartBridgeButton.tsx` | `POST /host/restart`, requires `host:bridge_control`. |
| `SystemStatus.tsx` | Dashboard system-health card: bridge ping, worker heartbeats, depot status. |
| `MetricHistoryChart.tsx` | Recharts `AreaChart` rendering 24 h cpu/ram/disk (% axis) or net (KB/s axis, two areas: rx + tx). Lazy-loaded — never imported at module level. Exports `MetricKey` (`'cpu'\|'ram'\|'disk'\|'net'`) and `MetricPoint` types. |
| `MetricHistoryModal.tsx` | Backdrop modal that fetches `GET /api/v1/host/metrics/history?seconds=86400`, decodes the packed integer tuple inline (cpu/load values divided by 100; bytes pass through), then `next/dynamic`-loads `MetricHistoryChart`. ESC / backdrop-click to close. The unpack is inlined rather than imported from `@squad/shared-config` so Next.js doesn't try to bundle the server-only `node:stream`-using modules from that package. |
| `RoleColorDot.tsx` | Coloured dot used wherever a role's colour needs to be shown inline (e.g. role lists). Accepts `color: RoleColor` from `@squad/shared-config/role-colors` and an optional `size` (`'sm'`/`'md'`). Purely presentational — no click handlers. |
| `RoleExpiryDateField.tsx` | Shared role-expiry calendar trigger for `/users` and the player card. Displays a locale-independent `ДД/ММ/ГГГГ`, opens the native date picker from the full button, supports an explicit reset to a permanent role, and explains the inclusive UTC-day boundary. |
| `RoleEditor.tsx` | Shared editor used by `/roles/new` and `/roles/[id]`. Loads permission registry from `GET /api/v1/permissions` on mount. Features: name field, 16-color swatch picker, description textarea, permission search bar, permissions grouped by 16 categories in 3-column responsive grid with ⚠️ for `dangerous` and "(в разработке)" for `unimplemented`. Owner read-only mode: amber banner + all inputs disabled. |
| `TopNav.tsx` | Верхняя навигация над `NAV_GROUPS`: фильтрует пункты по правам, показывает счётчик жалоб, поиск и меню пользователя. В меню находятся переход на `bss.games`, локальный выход и глобальный выход. Монтируется из `(dashboard)/layout.tsx` с правами и именем из `requireSession()`. |
| `ServerBar.tsx` | Contextual server switcher rendered under `TopNav` on `/dashboard`, `/servers`, `/statistics`, `/matches` and `/chat` only. One chip per server from `GET /api/v1/servers` — status dot, display name, and the RCON poller's last player count (omitted entirely when the server has never been polled, so it never reads as "0 online"). Refreshes on `server.status` / `server.deleted` / `rcon.status` live-bus events. Renders nothing when the panel has no servers or the request fails. |

## Lib utilities

`apps/web/src/lib/`:

| File | Purpose |
|---|---|
| `api.ts` | Typed `fetch` wrapper that re-uses session cookies, surfaces `error.code` from JSON responses. |
| `dal.ts` | Server-side Data Access Layer used by server components (`requireSession`, etc.). `Me` interface matches `/api/v1/me`: `steam_id64`, `canonical_name`, `avatar_url`, `permissions`. |
| `format.ts` | Number / duration / bytes / SteamID formatters. Tested. |
| `host-health.ts` | Aggregates `bridge-status` + worker heartbeats into one health enum for the dashboard. Tested. |
| `ws-backoff.ts` | Exponential-backoff WebSocket reconnect helper used by `LogConsole` and the install/depot WS subscribers. Tested. |
| `live-bus.ts` | Singleton `LiveBusHandle` for `wss://.../api/v1/ws/live`. Mirrors the API-side `LiveEvent` discriminated union, exposes `subscribe(cb)`, `state()`, `bridgeState()`, `onStateChange(cb)`, `onBridgeChange(cb)`. Connection is shared across all `useLiveBus*` hooks; `BACKOFF_STEPS_MS = [1s, 2s, 4s, 8s, 16s, 30s]`; idle close after `IDLE_CLOSE_DELAY_MS = 5s` with no subscribers. Replies `{type:'pong'}` to every server ping. |
| `use-live-bus.ts` | React hooks: `useLiveBusEvents(filter, cb)` for typed event subscriptions, `useLiveBusState()` and `useBridgeState()` for connection state; both used by `ConnectionBanner` and the live `/servers` list. |

## Live-refresh and staleness

Every polling surface uses `LiveIndicator` + the same shape: poll every N seconds, show last-success age, switch to amber when staleness exceeds a per-surface threshold, surface visible error state instead of silently failing. WS surfaces use `ws-backoff` for reconnect; the server-logs WS gets a 20 s heartbeat frame from the API so proxies don't kill the socket on quiet servers.

## Code location

- App Router: [`apps/web/src/app/`](../../../apps/web/src/app/) — `(dashboard)/`, `login/`.
- Components: [`apps/web/src/components/`](../../../apps/web/src/components/).
- Auth helper: `apps/web/src/app/(dashboard)/layout.tsx` calls `requireSession()`.

## Dependencies

- `next` 15.5, `react` 19, `react-dom` 19
- `tailwindcss` 4 + `@tailwindcss/postcss`
- `@monaco-editor/react` 4.7
- `recharts` 3 — used only inside `MetricHistoryChart`, split into its own JS chunk via `next/dynamic`
- Tests: `@playwright/test` 1.59, `vitest` 3 (currently `--passWithNoTests` for Vitest; component-level `*.test.ts` like `LiveIndicator.test.ts` and `format.test.ts` ARE wired)

## Components that depend on it

- Operators in their browsers.

## Components it depends on

- [`api`](../api/README.md) — every page is data-driven by REST or WebSocket.
- [`shared-types`](../shared-types/README.md), [`shared-config`](../shared-config/README.md) — Zod schemas, permission keys, hot-reload table. Client-side code imports sub-paths (`@squad/shared-config/role-colors`, `@squad/shared-config/permissions`) instead of the barrel to avoid bundling the server-only `node:stream`-dependent log-stream sink. The metric-unpack math in `MetricHistoryModal` is inlined for the same reason.

## Basic usage

```bash
pnpm --filter @squad/web dev          # next dev --port 3000
```

In compose, Caddy serves the prebuilt `next start` output.

## See also

- [Design system](design-system.md)
- [Configuration](configuration.md)
- [Testing](testing.md)
