# Roles and Access (Эпик 2 Phase 2) — Implementation Plan

**Goal:** Implement the unified role model from the spec — name + hex color + 21 Squad permissions + 3 access flags (`panel_access`, `can_assign_roles`, `can_edit_roles`) — wire it through the API, the config-sync worker that synthesizes the managed `Admins.cfg` segment with marker-fenced atomic writes, and the `/settings/groups` editor + `/settings/groups/:id/members` listing UI. Keep existing fine-grained panel permission keys as derived view of the 3 flags so existing route guards keep working.

**Architecture:**
- DB: extend `roles` with `panel_access`, `can_assign_roles`, `can_edit_roles` boolean columns; add `role_squad_permissions(role_id, squad_permission_key)` M2M for the 21 in-game perms; loosen color CHECK to allow `#RRGGBB`.
- API: existing `/api/v1/roles` extended; new `/api/v1/roles/:id/members`, `/api/v1/admins-cfg/drift`, `/api/v1/admins-cfg/sync`; mutations enqueue Redis Stream tasks `events:admins-cfg-sync:<server_id>`.
- RBAC: panel-perm derivation `flags → permission_key set` in `loadUserPermissions`. Owner is hardcoded super-set.
- Worker `config-sync`: consumer of the stream + 5-min drift detector; bridge `file_read` + `file_atomic_write` with managed-segment markers `//SQUAD-PANEL BEGIN/END`, CRLF preservation, sha256 idempotency.
- UI: `/settings/groups` is the inline editor (debounced auto-save, optimistic, hex color picker), `/settings/groups/[id]/members` is paginated members. Drift alert on server detail page. Player card gets role widget update.

**Tech stack:** TypeScript + Fastify + Zod + Drizzle + Postgres + Redis + Next.js 15 + React 19 + Tailwind 4 + Biome + Vitest. No Go bridge changes needed (existing `file_read`, `file_atomic_write` allowlist already covers `/var/lib/squad-panel/configs/{uuid}/ServerConfig/Admins.cfg`).

---

## Spec coverage matrix

| Spec § | Requirement | Implemented in |
|---|---|---|
| 2.1 / 2.1.1 | Role model + 3 flags | T1, T2, T6 |
| 2.2 | `/settings/groups` inline editor | T11, T14 |
| 2.3 | Role card UI (3-column perms, ⚠️ badges, color, switches) | T11 |
| 2.4 | 21 Squad permissions catalog | T2 |
| 2.5 | Default seeded roles | T3 |
| 2.6.1 | Player ↔ role lifecycle | T7 |
| 2.6.2 | Login-time panel_access check | T5 |
| 2.6.3 | First-login Owner trick (existing) | (kept) |
| 2.6.4 | Role assign UI on player card | T7, T11 (player widget) |
| 2.6.5 | `/users` list | (existing, augmented in T6/T11) |
| 2.6.6 | Owner self-protection | T6, T7 |
| 2.7.1 | Mutation triggers sync event | T6, T7 |
| 2.7.2 | Admins.cfg format | T10 |
| 2.7.3 | Marker-fenced managed segment | T10 |
| 2.7.4 | Sync flow (worker) | T10 |
| 2.7.5 | Audit `admins_cfg.synced` | T10 |
| 2.7.6 | Drift detection + force sync | T9, T10, T13 |
| 2.7.7 | Per-server lifecycle | T10 |
| 2.8 | Members page | T12 |

P1 items (CSV bulk add, comments, copy-from preset, perm search) are noted in code TODO-free way (i.e. left for follow-up); the spec marks them P1 explicitly.

---

## Execution

Tasks tracked in TaskCreate. Final gate: `pnpm turbo run typecheck && pnpm turbo run test && biome check` green; then `/codex:rescue` review pass against this plan and the spec until 100% coverage confirmed.
