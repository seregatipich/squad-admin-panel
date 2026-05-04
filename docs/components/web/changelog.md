# Changelog

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
