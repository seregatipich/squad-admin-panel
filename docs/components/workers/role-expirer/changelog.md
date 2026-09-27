# Changelog

## 2026-09-27

- Subscription renewal re-checks the tier's current role inside the charge transaction: when the tier now maps to a panel-access or system role, nothing is charged or granted and the subscription ends with reason `role_grants_panel_access` (#31).

## 2026-09-16

- Roles granted through the removed bss.games store are no longer skipped: once migration 0115 drops `players.role_lifecycle_event_id`, the worker expires them like any other timed role.

## 2026-07-06

- Added `worker-role-expirer` for `players.role_expires_at`.
- Added audit rows, session revocation, diagnostics, heartbeat, and Admins.cfg sync enqueueing.
