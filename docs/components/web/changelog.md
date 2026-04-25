# Changelog

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
