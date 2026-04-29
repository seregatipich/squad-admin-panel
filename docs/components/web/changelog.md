# Changelog

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
