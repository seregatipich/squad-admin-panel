# Changelog

## 2026-09-27

- [#35](https://github.com/seregatipich/squad-admin-panel/issues/35) (finding 989): the expiry scan no longer clears a role that an active VIP subscription is about to renew. Previously the 60 s expiry tick beat the hourly renewal tick at every period boundary, dropped the role, revoked every session, rewrote Admins.cfg twice and shifted `role_expires_at` off the billing schedule. Regression test: `test/find-expired-assignments.integration.test.ts`.

## 2026-09-16

- Roles granted through the removed bss.games store are no longer skipped: once migration 0115 drops `players.role_lifecycle_event_id`, the worker expires them like any other timed role.

## 2026-07-06

- Added `worker-role-expirer` for `players.role_expires_at`.
- Added audit rows, session revocation, diagnostics, heartbeat, and Admins.cfg sync enqueueing.
