# Changelog

## 2026-07-27 — VIDEO-4 публикация медиа в YouTube/Telegram (#160)

### Added

- `apps/web/src/app/(dashboard)/players/[id]/MediaPublishControl.tsx` — «Опубликовать» on each evidence item: pick the destinations, `POST /api/v1/media/:id/publications`, then per-destination status and the external link once published. `can_manage_media` is not exposed by `GET /api/v1/me`, so the control **self-hides on a 403** from the publications endpoint instead of reading a capability flag. It renders nothing for an `external_link` — there is no local file to upload, and the API would answer `not_a_stored_file`. Mounted from `EvidenceSection.tsx`.
- `apps/web/src/app/(dashboard)/players/[id]/media-publications.ts` — pure helpers with their own unit tests: `destinationLabel`, `publicationsUrl`, `isPublishable`, `statusLabel`, `publicationErrorLabel`. `statusLabel` splits the API's single `queued` state three ways («ждёт квоту YouTube» / «повтор запланирован» / «нет настроек интеграции»); an operator watching «в очереди» for six hours otherwise cannot tell which is happening. An unrecognised error code is shown verbatim rather than swallowed.
- `apps/web/src/app/(dashboard)/settings/integrations/media/page.tsx` — «Публикация медиа» settings page: connection status for both destinations (presence only, since the API returns booleans and never values) and the «освобождать локальный файл» switch, which keeps showing its stored value if the `PATCH` is rejected rather than pretending it moved. Registered in `nav.ts`, both i18n dictionaries, `test/pages-graph.test.ts` and `test/pages/settings.test.ts`.

## 2026-07-27 — MOD-3 moderation history with evidence on the player card (#60)

### Added

- `apps/web/src/app/(dashboard)/players/[id]/ModerationHistorySection.tsx` — «История модерации» section on `/players/{id}`, the first UI consumer of `GET /api/v1/players/:playerId/moderation-actions`. Each entry shows the action type as a coloured badge, the reason, the author (panel user or worker system label), the server and the time, plus an «отменено» marker on a reverted action. The media evidence attached to an action renders inline: images and video through the Range-streaming route (`/api/v1/media/:id/stream`, VIDEO-1 #157), external links as an anchor. The section self-hides on `401`/`403`, matching the other player-card sections.
- `apps/web/src/app/(dashboard)/players/[id]/moderation-history.ts` — pure helpers behind it: `moderationActionLabel`/`moderationActionBadgeClass` (Russian labels for the panel's `warn`/`kick`/`ban`/`unban` and the worker-issued `name_kick`/`external_ban_kick`/`external_ban.local_ban`/`clan_tag_protection`, raw value as fallback), `formatModerationDate`, `authorLabel`, `evidenceLabel`, `mediaStreamUrl`, `detachEvidenceUrl`, and `canDetachEvidence`.
- «Открепить» on an evidence item, calling `DELETE /api/v1/media/:id/links` (VIDEO-2, #158). It is offered **only on links the viewer created themselves**: the server also accepts someone else's link from a `can_manage_media` holder, but that flag is not exposed on `GET /api/v1/me`, so the panel cannot gate on it client-side — `canDetachEvidence` is the single place to widen once it is. A `403` from the route is surfaced rather than silently swallowed.
## 2026-07-27 — ISSUE-3 связанные объекты у тикета и связанные тикеты у игрока (#156)

### Added

- `apps/web/src/app/(dashboard)/issues/[id]/IssueLinksBlock.tsx` — «Связанные объекты» on the ticket card: the expanded `links[]` from `GET /api/v1/issues/:id`, each row a type badge plus a link to `/players/{id}`, `/servers/{id}` or the media stream. A target that no longer exists renders struck-through and non-clickable. Adding a link uses the existing `PlayerSearchSelect` autocomplete for players and a plain `<select>` for servers; the server option is offered only when `GET /api/v1/servers` succeeds, because that route needs `server:view` which a tracker user need not hold. The remove button appears only for links the viewer may detach (own link, or `can_manage_issues`), mirroring the API gate.
- `apps/web/src/app/(dashboard)/issues/[id]/issue-links.ts` — pure helpers behind that block: `entityTypeLabel`, `canRemoveLink`, `linkErrorMessage` (Russian text for 403/404/409/422), `sortLinks`.
- `apps/web/src/app/(dashboard)/players/[id]/IssueLinksSection.tsx` — «Связанные тикеты» on `/players/{id}`: the counter and list of unclosed tickets naming the player (`GET /api/v1/players/:playerId/issues`), each linking to `/issues/{id}`. Self-hides on `401`/`403` and when the player has no linked ticket, matching the other player-card sections.
## 2026-07-27 — LEAD-5 стат-дашборд `/statistics` (#176)

### Added

- `apps/web/src/app/(dashboard)/statistics/` — the `/statistics` server statistics dashboard: a thin `'use client'` page over `StatisticsBrowser`, which owns a single fetch, a single `loading` state and a single `data` state, so changing the date range or the server selection redraws every chart atomically.
- Controls: date-range presets (Сегодня / Вчера / Неделя / Месяц / 30 дней / Произвольно, with two `YYYY-MM-DD` inputs for the custom range) and a server multiselect defaulting to every server. The selection is committed when the dropdown closes and then debounced by 300 ms, so a burst of checkbox clicks collapses into one request.
- Blocks: население (средний онлайн, пик онлайна, средняя очередь, онлайн по часам суток, онлайн по дням недели), матчи (матчей за день, doughnut по режимам, топ боевых карт), сообщество (новых игроков, сообщений чата, тимкиллов) and модерация (наказаний, средний/пик онлайна админов). Each time-series prints a «Среднее / Максимум / Всего» KPI line computed from the same stacked values the chart draws.
- Export: a CSV link carrying the loaded window and a JSON blob download of the exact payload.
- Drill-down: clicking a bar segment offers a link into `/events`, `/chat`, `/combat-log` or `/external-bans` pre-filtered to that server and, where the destination supports it, that day (`preset=custom&from=D&to=D`). `/external-bans` parses neither filter today, so its link is deliberately bare.
- `apps/web/src/lib/server-color.ts` — deterministic `serverId → colour`, assigned by position in the **sorted** list of known server ids so a server keeps one colour across every chart and every refetch.
- `apps/web/src/app/(dashboard)/statistics/StatisticsCharts.tsx` — the recharts surface, loaded through `next/dynamic` so recharts stays out of the page's first-load bundle.
- Nav entry «Статистика» → `/statistics` with `nav.statistics` added to both `ru.ts` and `en.ts`.

Gating is self-hide-on-403: `GET /api/v1/me` does not expose `panelAccess`, so the page surfaces the API's refusal rather than pre-checking a capability, matching `dashboard/analytics-panel.tsx`. The clock is read in a post-mount `useEffect`, never during render, so the CSV href cannot cause a hydration mismatch.
## 2026-07-27 — VIDEO-3 публичная страница загрузки по одноразовой ссылке (#159)

### Added

- `apps/web/src/app/(public)/upload/[token]/page.tsx` + `UploadClient.tsx` — session-less upload page under the `(public)` route group (the `middleware.ts` matcher does not cover `/upload`, so no session gate applies). Drag-and-drop plus a file picker over the four allowlisted formats, a progress bar with transferred megabytes and speed via `XMLHttpRequest` (the only browser API that reports upload progress), and Russian status/error copy mapped from the public endpoint's `410`/`413`/`415`/`429`/`400`. The token is never validated client-side, so an invalid link fails at upload time with the same `410` as a spent one.
- `apps/web/src/app/(public)/upload/[token]/upload-progress.ts` — pure helpers (`formatMegabytes`, `formatSpeed`, `computeProgress`, `isAcceptedUploadType`, `uploadErrorMessage`) unit-tested independently of the component.
- `apps/web/e2e/public-upload.spec.ts` — Playwright confirmation that the page renders and uploads from a browser context carrying no `__Host-sid` cookie, and that the same link then fails. Runs only via `pnpm --filter @squad/web test:e2e`; the vitest config excludes `e2e/**`.

### Changed

- `EvidenceSection.tsx` gains «Получить ссылку для загрузки» (`POST /api/v1/media/upload-tokens`, pre-bound to the player being viewed), which renders the one-time URL exactly once in a read-only field because the API never returns it again. Evidence delivered through a link is labelled «загружено по ссылке, аноним», and the section refreshes itself on the `media.uploaded` live event (ignoring events bound to a different player's card).
- `apps/web/src/lib/live-bus.ts` — client `LiveEvent` union gains `media.uploaded`, kept in lockstep with `apps/api/src/plugins/live-bus.ts`.

## 2026-07-27 — VIDEO-2 evidence section on the player card (#158)

### Added

- `apps/web/src/app/(dashboard)/players/[id]/EvidenceSection.tsx` — «Доказательства» section on `/players/{id}`, listing media evidence attached to the player directly or via a moderation action against them (`GET /api/v1/players/:playerId/media`). Video and image files play/render inline through the existing Range-streaming route (`/api/v1/media/:id/stream`, VIDEO-1 #157); external links open in a new tab. The section self-hides on `401`/`403`, matching the other player-card sections.

## 2026-07-26 — DISCORD-3 Discord message-template editor

### Added

- `apps/web/src/app/(dashboard)/settings/integrations/discord/DiscordTemplatesSection.tsx` — «Шаблоны сообщений» section on `/settings/integrations/discord`: per-event-type embed editor (title, url, description, colour, fields) over `GET/PUT /api/v1/integrations/discord/templates`, a «Сбросить к дефолту» button on `POST …/reset`, and a debounced server-rendered live preview on `POST …/preview` that names every placeholder the renderer could not substitute. Gated on `integration:manage`; the section renders nothing on a 403.
## 2026-07-26 — PLAYER-6 sortable player list (#27)

### Added

- `apps/web/src/app/(dashboard)/players/helpers.ts` — pure sort/filter helpers for the list page: `nextSortState` (two-state per-column toggle with per-column first-click direction), `sortIndicator` (`↑`/`↓`/`↕`), and `buildPlayersListQuery` (emits `sort`, `dir`, and optional `filter=new`).
- **Created** column on `/players`, rendering each player's `first_seen_at` between Total playtime and Last seen.
- Sortable Ник, Total playtime, Created, and Last seen headers, each a `SortHeader` button that drives `GET /api/v1/players?sort=&dir=` server-side and shows its direction indicator.
- `новые (<7 дней)` checkbox that adds `filter=new` to the list request.

The Статус header's client-side online sort, the `только онлайн` checkbox, and the in-memory search box are unchanged and still client-side.
## 2026-07-26 — DOSSIER-6 player dossier tabs

### Added

- `apps/web/src/app/(dashboard)/players/[id]/DossierSection.tsx` — «Досье» block on the player card, fed by exactly one `GET /api/v1/players/:playerId/dossier` request per (server, period) selection; switching tabs never refetches.
- Four tabs render from that single payload: `DossierSkillTab.tsx` (eleven combat KPIs, period selector, kills-vs-deaths donut and stacked month trend), `DossierWeaponsTab.tsx` (top-N weapon table with kills/damage sorting), `DossierVehiclesTab.tsx` («На технике» and «Уничтожено» sub-tables) and `DossierKitsTab.tsx` (kit time, longest first).
- The block self-hides on `401`/`403` because the route is gated on `combat:view`, which `GET /api/v1/me` does not report — there is no permission flag to gate on client-side.
- `skill.damage_dealt` is permanently null upstream, so the «Урон» tile and every null damage cell render `—` titled «Источник не содержит данных об уроне»; a zero is never substituted.
- Vehicle names are localised from the `vehicle_catalog` `name_ru`/`name_en` columns via `useLocale()`; an uncatalogued row shows its raw asset id titled «Нет в каталоге техники».
- The server selector appears only on «Скилл» and «Киты»; «Оружие» and «Техника» state «Пожизненно, без разбивки по серверам», matching the route's own lifetime-only aggregates.
- `apps/web/src/app/(dashboard)/players/[id]/dossier.ts` — response types, formatters, sorters and the client-side zero-fill for the months the API's `matches_played > 0` filter drops, with `dossier.test.ts` unit coverage; `DossierSection.test.tsx` covers all four tabs, the empty state, the 401/403 self-hide and the no-refetch rule.
- `DossierSkillChart.tsx` is loaded through `next/dynamic`, keeping recharts out of the curated static import graphs.

## 2026-07-25 — WL-3 whitelist application portal

### Added

- `apps/web/src/app/(public)/public/whitelist/page.tsx` — public, no-session application form (SteamID64 + message + optional contact) reading the open/closed switch from `/api/v1/public/whitelist/settings` and posting to `/api/v1/public/whitelist/applications`; renders closed / success / duplicate / error states.
- `apps/web/src/app/(dashboard)/settings/whitelist/ApplicationsSection.tsx` — review queue on `/settings/whitelist`: portal open/closed toggle + default-term, status filter, and per-application approve (role + term preset → time-bounded grant) / reject (note). Gated on `whitelist:edit` for mutations, `whitelist:view` for reads.

## 2026-07-14 — CBAN-4 local-ban action

### Added

- The player card's external-ban section now shows «Забанить локально» for active records when the viewer has the Squad `ban` permission.
- The confirmation form requires a server, prefills the source/reason, accepts Squad's ban-duration syntax, and reports the successful target server inline.

## 2026-07-05 — PNOTE-2 global notes feed

### Added

- `apps/web/src/app/(dashboard)/notes/page.tsx` — new `/notes` page: cross-player admin-notes feed over `GET /api/v1/notes`. Columns: date, author (role-color dot), target player (links to `/players/{id}#notes`), note body (truncate + expand). Filter bar combines text search, target-nickname, author select (`GET /api/v1/notes/authors`), and a date range; keyset "показать ещё" pagination; "Экспорт CSV" downloads the current filtered selection via `GET /api/v1/notes/export`. A "Показывать удалённые" toggle appears only when the API reports `can_view_deleted`; deleted rows render struck-through with the deleting admin. Dark theme, Russian labels, mobile-friendly.
- `notes` link added to the sidebar "Управление" group.
- `NotesSection` (player card) gained an `id="notes"` anchor so the feed's target link opens the player's notes section.
- `apps/web/src/app/(dashboard)/notes/page.test.tsx` — validates the component export.

## 2026-07-05 — AN-1 dashboard analytics widgets

### Added

- `apps/web/src/app/(dashboard)/dashboard/analytics-panel.tsx` — dashboard analytics widget rendering a peak-players-by-hour bar chart, match-outcome distribution, popular maps/layers, summary stat tiles, per-server + time-window filters, and CSV/JSON export buttons. Fetches `GET /api/v1/analytics/dashboard`. Dark theme, Russian labels, accessible (single-hue magnitude bars, legend + direct labels so identity is never color-alone).
- `apps/web/src/app/(dashboard)/dashboard/analytics-data.ts` — pure presentation helpers (hour/duration formatting, outcome percentages, peak scaling, window range, query builder) with `analytics-data.test.ts` unit coverage; `analytics-panel.test.tsx` validates the component export.

## 2026-05-05 — Server settings editor page

### Added

- `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx` — new settings editor page at `/servers/:id/settings` with three sections: Сеть (network ports, disabled when server is running), Игра (maxPlayers, tickrate), and Ресурсы (memory, CPU, IO resource limits). Fetches from `GET /api/v1/servers/:id`, saves via `PUT /api/v1/servers/:id/settings`.
- "Настройки →" link added to the server detail page header alongside existing "Конфиги →" and "События →" links.
- `apps/web/src/app/(dashboard)/servers/[id]/settings/page.test.tsx` — unit test validating the component export.

## 2026-05-04 — Unit test coverage for lib utilities and middleware

### Added

- `src/lib/api.test.ts` — 9 unit tests for `apiFetch`: URL construction, headers, error throwing.
- `src/lib/dal.test.ts` — 8 unit tests for `getSession`, `requireSession`, and `SESSION_COOKIE`.
- `src/lib/live-bus.test.ts` — 8 unit tests for the SSR no-op stub returned by `getLiveBus()`.
- `src/lib/use-live-bus.test.ts` — 3 unit tests verifying hook exports.
- `test/middleware.test.ts` — 10 unit tests for `middleware` redirect logic and `config.matcher`.

## 2026-05-02 — Эпик 2 Phase 2 follow-up

### Added

- `/users` page now has a search box (nickname / SteamID64) and a role filter dropdown, plus a per-row "Снять" button (gated by `user:manage_roles`).
- Player card role widget renders read-only for users without `user:manage_roles` — they see the current role + color but no Изменить / Снять buttons.

### Changed

- Player card role dropdown excludes Owner and the player's current role per spec §2.6.4.
- Snять button on the player card now hits the new `DELETE /api/v1/players/:steamId/role` endpoint.

## 2026-05-01 — Эпик 2 Phase 2: groups editor + members page + drift banner

### Added

- `apps/web/src/app/(dashboard)/settings/groups/page.tsx` — inline role editor. Stacked role cards with name + hex color picker + 3 access-flag switches + 21 Squad permissions in 3 columns with ⚠️ on dangerous ones. Debounced auto-save (500 ms after the last click), optimistic UI with rollback on save failure, "+ Создать роль" button, ⌫ delete with confirm, "Открыть список членов" link, collapsible "Как это выглядит в Admins.cfg" preview, link to Squad wiki Server Administration.
- `apps/web/src/app/(dashboard)/settings/groups/[id]/members/page.tsx` — paginated members list per role with search by nickname/SteamID64, add-player modal with player search, remove button per row.
- `apps/web/src/components/AdminsCfgDriftBanner.tsx` — drift alert on the server detail page. Polls `/api/v1/admins-cfg/drift?server_id=...` every 30 s; when the file's managed segment hash diverges from the DB's (or the bridge is unreachable), shows a banner with a Force-sync button.

### Changed

- `apps/web/src/components/SidebarNav.tsx` — sidebar entry "Роли" replaced with "Группы" pointing at `/settings/groups`. The legacy `/roles` page remains in the codebase as a deprecated route but is no longer linked.
- `apps/web/src/components/RoleColorDot.tsx` — accepts hex color codes in addition to palette names; hex codes render via `style={{ backgroundColor: color }}`.

## 2026-04-27 — Sidebar redesign: grouped nav + active-route indicator

### Added

- `apps/web/src/components/SidebarNav.tsx` — client component that owns dashboard navigation. Five permission-filtered groups with uppercase tracked-out headers; active route gets a sky-400 left bar + `bg-neutral-900` row via `usePathname()`; whole group hidden when its only items are gated out.

### Changed

- `apps/web/src/app/(dashboard)/layout.tsx` — sidebar markup extracted into `SidebarNav`; the layout server component now only fetches the session and forwards `permissions` + `canonical_name`.
- `apps/web/src/styles/globals.css` — wrapped the global `a { @apply text-sky-400 ... }` rule in `@layer base` so per-component utility classes (e.g. `text-neutral-300` on nav links) actually win the cascade. Visual behaviour for plain `<a>` is unchanged.

### Removed

- "Серверы" link from the dashboard sidebar — the dashboard page already shows the live server table inline, so the entry was redundant. The `/servers` route still resolves; it is reachable from the dashboard "все →" CTA and from `/servers/[id]` deep links.

### Migration notes

- No env or API surface changes. `e2e/dashboard.spec.ts` continues to pass: `nav.toContainText('Серверы')` matches the new `СЕРВЕРЫ` group header.
## 2026-04-28 — Playwright e2e for the disk breakdown modal

### Added

- `apps/web/e2e/disk-breakdown.spec.ts` — four-case Playwright spec exercised against the live panel via the existing `ownerPage` fixture: (1) `[data-testid="disk-card"]` click opens the `role="dialog"` named «Что занимает панель» and renders the «Всего:» line plus the «По типу» heading; (2) the «Обновить» button drives `cache_age_seconds` to 0 within 10 s, asserted via «обновлено 0 сек назад»; (3) pressing Escape hides the dialog; (4) clicking the backdrop hides the dialog. The spec follows the existing `apps/web/e2e/` layout (the plan's `apps/web/test/e2e/` path was a planning-only artifact — Playwright's `testDir` is `./e2e`).

### Notes

- The spec is shipped as code only — like the bridge e2e suite it gets exercised on the deployment host (or staging replica) where the live panel stack and seeded Owner cookies are available. It is NOT executed in this commit.

## 2026-04-28 — `<DiskBreakdownModal>` for the dashboard disk card

### Added

- `apps/web/src/components/DiskBreakdownModal.tsx` — controlled modal opened when the operator clicks the dashboard disk card. Props: `{ open, onOpenChange, initialData, onRefresh }`. Renders the «По типу» list (configs / saved-total / squad-depot / docker volumes / docker images / audit-archive sorted by bytes desc) and the «По серверам (saved)» scrollable table (linked first-8-chars UUIDs to `/servers/<uuid>`). Component-private `fmt(bytes)` formats sizes in `B/KB/MB/GB/TB` with magnitude-dependent precision. Refresh button calls `onRefresh()`, which is the parent-supplied closure that hits `GET /api/v1/host/disk-usage?refresh=1`. Backdrop click and Escape close the modal.

### Changed

- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — disk-card click now opens the new `DiskBreakdownModal` instead of the metric-history modal. CPU / RAM / Network cards still open `MetricHistoryModal` unchanged. New state `diskModalOpen`, new callback `refreshDiskBreakdown` that hits `?refresh=1` and updates the dashboard's polled `diskBreakdown` state in addition to returning the fresh payload to the modal. Disk card's outer `<button>` now carries `data-testid="disk-card"` for the upcoming Playwright e2e.
- `apps/api/src/routes/host.ts` — `GET /api/v1/host/disk-usage` now accepts an optional `?refresh=1` query (Zod-coerced boolean). When truthy the API passes `{ force: true }` to `bridge.panelDiskUsage()`.
- `packages/bridge-client/src/client.ts` — `panelDiskUsage(opts?: { force?: boolean })` forwards the `force` flag to the bridge as a `{ force: true }` params payload.
- `apps/bridge/internal/handlers/handlers.go` — `panelDiskUsage` decodes optional `{ force?: bool }` params; when `force` is true it skips the 5-minute cache read but still writes the fresh result back into the cache so subsequent non-force calls benefit.

## 2026-04-28 — Dashboard disk bar renders Панель / Прочее sub-segments

### Changed

- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — `DiskCard` now consumes the `diskBreakdown` prop (renamed from the prior placeholder `_diskBreakdown`). When the payload is present the card's progress track stacks two segments inside it: `Панель` in `bg-purple-500` followed by `Прочее` in `bg-purple-300`, sized from `panel_pct` and `max(0, usedPct - panelPct)` so they always equal the total used % shown in the card title. A swatch legend below the bar shows both percentages with one-decimal precision. While `diskBreakdown` is `null` (initial load or transient fetch failure) the bar gracefully falls back to the existing single-segment threshold-tinted (emerald/amber/red) rendering and the legend is hidden.
- `ResourceCard` gained two optional props — `progressSegments` (array of `{widthPct, className}`) and `progressLegend` (array of `{label, pct, swatchClassName}`) — that toggle the segmented variant. RAM and CPU cards continue to render the original single-segment bar untouched.

### Notes

- Purple was chosen over the threshold-tinted hues to stay consistent with the existing disk-card identity (the `MetricHistoryModal` open-button hover ring is already `purple-700/40`) and to avoid colliding with the emerald/amber/red traffic-light tones used by the threshold logic. Keeping the segmented bar in a single distinct hue family means the operator can read «Панель vs Прочее» without confusing it with «healthy vs warning».

## 2026-04-28 — Dashboard fetches /host/disk-usage in preparation for disk sub-segment

### Added

- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — new `diskBreakdown` state populated by polling `GET /api/v1/host/disk-usage` every 30 s on mount. Failures are tolerated silently. The state is plumbed through `HostBlock` to `DiskCard` but not yet rendered — Task 6 will add the visual sub-segment that splits the disk bar into «панель» / «остальное» / «свободно».

## 2026-04-26 — Bundle F: archive UI + connection banner + live-bus client

### Added

- `apps/web/src/lib/live-bus.ts` — singleton `LiveBusHandle` for `wss://.../api/v1/ws/live` with the discriminated `LiveEvent` union mirrored from the API. Auto-pong, exponential reconnect (`[1s,2s,4s,8s,16s,30s]`), idle-close after 5 s with no subscribers.
- `apps/web/src/lib/use-live-bus.ts` — `useLiveBusEvents`, `useLiveBusState`, `useBridgeState` hooks.
- `apps/web/src/components/connection-banner.tsx` — sticky banner: red on WS loss, amber on bridge down, hidden when both healthy. Mounted in `(dashboard)/layout.tsx`.
- `apps/web/src/app/(dashboard)/servers/archive/page.tsx` — soft-deleted servers table.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/page.tsx` — archive detail + per-cfg backup viewer.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/restore/page.tsx` — restore wizard: slug input → POST /restore (handles 409 inline) → POST /install (WS log tail) → POST /restore-configs (summary card) → POST /start.

### Changed

- `apps/web/src/app/(dashboard)/servers/[id]/page.tsx` — delete confirm copy: «Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел Архив серверов).»
- `apps/web/src/app/(dashboard)/servers/page.tsx` — subscribes to `server.status` and `rcon.status` via `useLiveBusEvents` for instant row updates; REST poll dropped to 120 s focus-refetch fallback.

### Migration notes

- No env var changes. The WS URL is derived from `window.location`; Caddy already forwards the upgrade headers.

## 2026-04-25 (e2e Playwright specs)

### Added
- `apps/web/e2e/_fixtures.ts`: `ownerPage` / `unauthedPage` Playwright fixtures backed by Steam-only DB seeding (no email/password, no Steam OAuth needed in tests).
- `apps/web/e2e/helpers.ts`: Rewrote `seedOwner` / `teardownOwner` / `loginAndAttachCookie` for the new single-role RBAC model (players table, sessions table, Redis session cache). Removed dependency on the deleted `users`, `organizations`, `user_role_assignments`, `organization_members` tables.
- 7 new critical-page specs: `login.spec.ts`, `no-access.spec.ts`, `dashboard.spec.ts`, `servers-new.spec.ts`, `roles.spec.ts`, `users.spec.ts`, `player-detail.spec.ts` — 19 tests, all passing.

### Fixed
- `auth.spec.ts`: Updated for Steam-only login (removed email/password form assertions).
- `live-refresh.spec.ts`: Removed `getOrgId()` call (organizations table gone), removed `org_id` from synthetic server inserts, replaced `auth/login` probe with a direct session action, replaced `UPDATE users SET display_name` with `UPDATE players SET canonical_name`.
- `server-detail-live.spec.ts`: Updated `seedOwner` call to new signature.
- `server-logs-resilience.spec.ts`: Updated `seedOwner` call, removed `org_id` from synthetic server inserts.

## 2026-04-26 (property tests)

### Added
- Extracted `nameToSlug`, `sanitizeSlug`, and `CYRILLIC_TO_LATIN` from `page.tsx` into `apps/web/src/app/(dashboard)/servers/new/_slug.ts` so they are importable by tests.
- Property-based tests for slug logic in `apps/web/test/property/slug.test.ts` (4 properties, 100 runs each): output always matches SLUG_RE, no leading dash after sanitize, 64-char max, already-valid slugs round-trip.

## 2026-04-26

### Removed
- `/servers` page: status filter chips (`all/running/starting/stopped/ready/failed/installing/pending`). Free-text search remains. The status dot per row already conveys state at a glance, and the chips added noise without payoff. Underlying `STATUS_FILTERS` constant and `filter` state deleted.

## 2026-04-25

### Added
- `/roles` page: filterable role list with `RoleColorDot`, edit/delete actions gated by `role:edit` / `role:delete`.
- `/roles/new` page: `RoleEditor` in create mode, POST /api/v1/roles on submit.
- `/roles/[id]` page: `RoleEditor` in edit mode; read-only banner for Owner system role.
- `/users` page: panel user list (players with non-null `role_id`), `AssignModal` for role assignment via player search.
- `RoleEditor` component: full permission checkboxes grouped by category, color picker, search filter, read-only guard for Owner role.
- `RoleColorDot` component: 16-color dot for use in role tables and color pickers.
- `PanelAccessSection` on `/players/[steam_id64]`: inline role assignment with Owner confirm dialog and last-Owner guard (409 handling).
- `/no-access` landing page for authenticated users without a panel role.
- Sidebar conditional links for Roles (`role:view`) and Users (`user:view`).
- Owner role confirm dialog in `AssignModal` and `PanelAccessSection`.

### Removed
- `/setup` page removed from the route table (setup flow superseded by the first-owner auto-claim).

---

## 2026-04-20

### Added
- `/settings/account` page: profile display, active session list with individual and bulk revoke.
- `/settings/tokens` page: API token creation with scope subset picker, one-time plaintext reveal, revoke.
- `LiveIndicator` component: pulsing freshness indicator used across all polling pages.

---

## 2026-04-10

### Added
- Monaco config editor at `/servers/[id]/configs`: three-tab layout (Editor / History / Blame), dirty-tracking, optional commit message, diff viewer, restore action.
- `LogConsole` component: sticky-to-bottom log viewer with error banner and "↓ к последней" scroll pill.

---

## 2026-03-28

### Added
- Server install wizard at `/servers/new`: Cyrillic-to-Latin slug transliteration, port fields, WebSocket log tail during installation.
- `RestartBridgeButton` component: confirmation modal for `POST /api/v1/host/restart`.
- `MetricHistoryModal` and `MetricHistoryChart` components: 24-hour history charts for CPU, RAM, disk, and network metrics.

---

## 2026-03-15

### Added
- Initial dashboard page at `/dashboard`: summary cards, server table, host block, recent activity feed, connections health panel.
- `/servers` page: server list with status filter and action buttons.
- `/players` and `/players/[steam_id64]` pages.
- `/audit` page: full audit log with expandable context.
- `/logs` page: live log stream with `LogList` component.
- `LogList` component: source/level/server/text filters, pause, cursor-based polling, export.
- `LogoutButton` component in the dashboard sidebar.
