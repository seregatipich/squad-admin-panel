# `web` — Next.js dashboard

Next.js 15 (App Router) + React 19 + Tailwind CSS 4. UI is in Russian. Server components handle auth gates; client components do polling and live updates over WebSocket.

## Responsibilities

- Dashboard, server detail, install wizard, config editor, players, audit, panel-wide log console, account.
- Auth screens: Steam login button → OpenID redirect, `/me` self-service page for players whose role has no `panel_access`.
- Live indicators: connection state, polling staleness, WS reconnect with exponential backoff.

## What this component does NOT do

- It does not call the bridge directly — it goes through `api`.
- Next.js middleware never authorises. The real gate is server-side `requireSession()` inside `src/app/(dashboard)/layout.tsx`, deduped via `react.cache()`. This is intentional after CVE-2025-29927. Since VIPSUB-5 (#171) a session alone no longer implies panel access, so the same layout also redirects a session with an empty `permissions` array to `/me`.

## App Router pages

| Route | File | What it does |
|---|---|---|
| `/login` | `src/app/login/page.tsx` | "Войти через Steam" button. Redirects to Steam OpenID 2.0. Immediately redirects to `/dashboard` if already authenticated. |
| `/me` | `src/app/(me)/me/page.tsx` | «Мой VIP» self-service page (VIPSUB-5, #171). Where a successful Steam login lands when the player's role has no `panel_access` — including a player with no role at all: the API issues a `self_service`-scoped session and redirects here instead of into the panel. Shows the player's own bonus balance, VIP expiry, tariff list («Купить разово» / «Подписаться»), active subscription with «Отменить подписку», and a paginated bonus history — all over `/api/v1/me/*`, which take no player id. Lives in the `(me)` route group, whose layout requires a session but no panel access and deliberately renders no sidebar or live-bus widgets. |
| `/dashboard` | `src/app/(dashboard)/dashboard/page.tsx` | Hub: bridge status, host metrics tile (live), per-worker heartbeats, server count summary. The metrics tile opens the `MetricHistoryModal` for 24 h history. |
| `/servers` | `src/app/(dashboard)/servers/page.tsx` | List with live `rcon_state` / `player_count` / `last_poll_at`. |
| `/servers/new` | `src/app/(dashboard)/servers/new/page.tsx` | Install wizard: collects display name + ports, `POST /servers`, then `POST /servers/:id/install`, subscribes to `/install/ws`. |
| `/servers/[id]` | `src/app/(dashboard)/servers/[id]/page.tsx` | Detail: status, container stats, RCON, action buttons (start/stop/restart/delete), live `/logs/ws` console. Delete confirm copy explains: "Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел Архив серверов)." |
| `/servers/[id]/configs` | `src/app/(dashboard)/servers/[id]/configs/page.tsx` | Monaco editor with three tabs: Editor / История (versions, restore, diff) / Blame. `Admins.cfg`'s `//SQUAD-PANEL` managed segment is highlighted and made read-only inside the editor via a decorations overlay + undo-guard (`managed-segment.ts`; monaco 0.55.1 has no read-only-range API) — the rest of the file stays editable and a banner links to `/settings/groups`. `requires_restart` files show a "Рестарт сервера" button (needs `server:restart` from `/api/v1/me`). CRLF line endings are preserved on save. |
| `/servers/[id]/events` | `src/app/(dashboard)/servers/[id]/events/page.tsx` | Newest envelopes from `events:server:{id}` via `GET /servers/:id/events`. |
| `/servers/[id]/schedule` | `src/app/(dashboard)/servers/[id]/schedule/page.tsx` | AUTO-2 scheduled tasks (restart / layer / broadcast) on a one-off instant or 5-field UTC cron, plus a read-only run history. Actions the caller lacks permission for (per the API `capabilities`) are hidden. MSG-4 (#187): a `broadcast` task shows the `TemplatePicker` (`{server}` substituted at rule-creation) feeding an ordered rotation list (up to 10 messages, free-text fallback), a server multi-select ("all servers") posting `server_ids`, and a client-side 5-minute floor via `minCron5IntervalMinutes` that disables submit with an inline hint; each broadcast task lists its rotation and highlights the current `rotation_index`. |
| `/servers/archive` | `src/app/(dashboard)/servers/archive/page.tsx` | Soft-deleted servers table (`GET /api/v1/servers/archive`): display name, slug, deleted_at, deleted_by. Row click → archive detail. |
| `/servers/archive/[id]` | `src/app/(dashboard)/servers/archive/[id]/page.tsx` | Archive detail: settings snapshot + per-file backup browser. Each cfg row opens a read-only Monaco viewer fed by `GET /api/v1/servers/archive/:id/configs/:filename`. "Восстановить" CTA navigates to the restore wizard. |
| `/servers/archive/[id]/restore` | `src/app/(dashboard)/servers/archive/[id]/restore/page.tsx` | Restore wizard: enter slug + display_name → POST /restore (handles 409 inline) → POST /install → tail install WS → POST /restore-configs (shows `files_restored` / `files_skipped` / `files_missing` summary) → POST /start → "Открыть сервер". |
| `/players` | `src/app/(dashboard)/players/page.tsx` | Recently-seen players. |
| `/players/[steam_id64]` | `src/app/(dashboard)/players/[steam_id64]/page.tsx` | Detail with name history; IP history is gated by `player:view_ips`. Section "Доступ к панели" (gated by `user:manage_roles`) shows the player's current single role with a color dot, an "Изменить" button to open a dropdown of all roles, and a "Снять роль" button (`PUT /api/v1/players/:id/role` with `role_id: null`). Picking the Owner role triggers a confirm dialog. 409 "last Owner" errors surface as an inline message. |
| `/audit` | `src/app/(dashboard)/audit/page.tsx` | Page-paginated audit log; live indicator showing freshness. |
| `/logs` | `src/app/(dashboard)/logs/page.tsx` | Panel-wide connector logs with filters (source, level, server, free-text). Server component that pre-fetches the server list, hands off to the `LogList` client component which polls `GET /logs`. |
| `/roles` | `src/app/(dashboard)/roles/page.tsx` | List all roles with color dot, Системная badge, user count, edit/delete actions. Delete blocked for Owner; confirm dialog shows affected user count. |
| `/roles/new` | `src/app/(dashboard)/roles/new/page.tsx` | Create role form — wraps `RoleEditor`, POSTs to `/api/v1/roles`, redirects to list. |
| `/roles/[id]` | `src/app/(dashboard)/roles/[id]/page.tsx` | Edit role — loads via `GET /api/v1/roles/:id`, wraps `RoleEditor`; Owner role is rendered in read-only mode. |
| `/settings/account` | `src/app/(dashboard)/settings/account/page.tsx` | Session management — list active sessions, revoke individual or all. |
| `/users` | `src/app/(dashboard)/users/page.tsx` | Table of all players with a non-NULL role (nick, SteamID64, role with color dot, last_seen). "Назначить роль игроку" button (gated by `user:manage_roles`) opens a modal with debounced `GET /api/v1/players?q=` typeahead + role dropdown; assigning the Owner role requires an explicit `confirm()` before submitting. |

## Components

`apps/web/src/components/`:

| File | Purpose |
|---|---|
| `LiveIndicator.tsx` | Shared "fresh / stale / disconnected" pill used by every polling surface. Hover shows last-success age. |
| `connection-banner.tsx` | Sticky top banner rendered by the dashboard layout. Reads `useLiveBusState()` + `useBridgeState()` from `src/lib/use-live-bus.ts`. Renders nothing when WS is `open` and bridge state is not `down`; renders red "Связь с панелью потеряна — переподключаемся…" when WS is not open; renders amber "Bridge не отвечает — операции с сервером временно недоступны" when the bridge is down. |
| `LogConsole.tsx` | Per-server live log viewer over `/api/v1/servers/:id/logs/ws`. Auto-scroll, ANSI stripping, error/`done` frames. |
| `LogList.tsx` | Panel-wide connector-logs client component used by `/logs`. Cursor-paginated against `GET /logs`, filter pills, "live tail" toggle. |
| `LogoutButton.tsx` | `POST /auth/logout`, redirect to `/login`. |
| `RestartBridgeButton.tsx` | `POST /host/restart`, requires `host:bridge_control`. |
| `SystemStatus.tsx` | Dashboard system-health card: bridge ping, worker heartbeats, depot status. |
| `MetricHistoryChart.tsx` | Recharts `AreaChart` rendering 24 h cpu/ram/disk (% axis) or net (KB/s axis, two areas: rx + tx). Lazy-loaded — never imported at module level. Exports `MetricKey` (`'cpu'\|'ram'\|'disk'\|'net'`) and `MetricPoint` types. |
| `MetricHistoryModal.tsx` | Backdrop modal that fetches `GET /api/v1/host/metrics/history?seconds=86400`, decodes the packed integer tuple inline (cpu/load values divided by 100; bytes pass through), then `next/dynamic`-loads `MetricHistoryChart`. ESC / backdrop-click to close. The unpack is inlined rather than imported from `@squad/shared-config` so Next.js doesn't try to bundle the server-only `node:stream`-using modules from that package. |
| `RoleColorDot.tsx` | Coloured dot used wherever a role's colour needs to be shown inline (e.g. role lists). Accepts `color: RoleColor` from `@squad/shared-config/role-colors` and an optional `size` (`'sm'`/`'md'`). Purely presentational — no click handlers. |
| `RoleEditor.tsx` | Shared editor used by `/roles/new` and `/roles/[id]`. Loads permission registry from `GET /api/v1/permissions` on mount. Features: name field, 16-color swatch picker, description textarea, permission search bar, permissions grouped by 16 categories in 3-column responsive grid with ⚠️ for `dangerous` and "(в разработке)" for `unimplemented`. Owner read-only mode: amber banner + all inputs disabled. |
| `SidebarNav.tsx` | Client-side dashboard sidebar. Renders five permission-gated groups (Дашборд / Серверы / Управление / Аудит / Настройки), highlights the active route via `usePathname()` with a sky-400 left bar + `bg-neutral-900` row, hides whole groups when permission filter empties them. Mounted from `(dashboard)/layout.tsx` with `permissions` + `displayName` props derived server-side from `requireSession()`. |

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

- [Configuration](configuration.md)
- [Testing](testing.md)
