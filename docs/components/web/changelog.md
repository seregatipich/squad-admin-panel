# Changelog

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
