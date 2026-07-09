# ADR: Panel-managed map rotation vs. configuring Squad's native rotation/voting

- **Status:** Accepted
- **Date:** 2026-07-09
- **Issue:** `ROT-1` (#144)
- **Blocks / referenced by:** `ROT-2` (rotation editor), `ROT-4` (rotation calendar / weekly profiles), `GAME-1` (map-voting automation)

## Context

Squad servers pick their next layer through one of two native mechanisms, both driven by files the dedicated server reads on startup / between matches:

1. **`LayerRotation.cfg`** — an ordered pool of layers the server cycles through sequentially (optionally with `Vote` markers that trigger Squad's own end-of-match vote among the following N entries).
2. **`LayerVoting.cfg` / `LayerVotingRandomization.cfg`** — configure Squad's built-in end-of-match voting UI: which candidate layers are eligible, how many are offered, and randomization weighting.

Everything the panel wants to offer around rotations depends on which of these two mechanisms is treated as the source of truth:

- **ROT-2** (rotation pool editor with drag-and-drop ordering) needs to read/write an ordered list the server will actually consume.
- **ROT-3** (current/next-map widget with "Set next" / "Change now" actions) needs to reason about "what layer plays next" independent of whatever the server's own rotation pointer is doing.
- **ROT-4** (rotation calendar, weekly day-of-week profiles) needs to *schedule* layer changes at specific times — something neither `LayerRotation.cfg` nor Squad's voting files can express; they have no concept of a clock.
- **GAME-1** (map-voting automation) needs to either drive Squad's built-in voting config or replace voting entirely with panel-issued `AdminSetNextLayer` calls.

Two designs were considered:

### Option A — Configure Squad's native mechanisms directly
The panel would be a smarter editor *for* `LayerRotation.cfg` and `LayerVoting*.cfg`: reorder the pool, toggle which layers are vote-eligible, and rely on Squad's own engine to advance through the rotation and run votes. `AdminSetNextLayer` / `AdminChangeLayer` (RCON-1) would only be used for one-off manual overrides.

### Option B — Panel-managed rotation on top of a minimal native config
`LayerRotation.cfg` becomes a single always-present managed segment (SYNC-3 managed-segment mechanics, same pattern as `Admins.cfg`) that the panel keeps in sync with whatever *it* decides should play next — driven by panel-side schedules (`rotation_schedule` / weekly profiles in ROT-4), seed-window logic (SEED-1/SEED-3), and admin actions (ROT-3). Squad's built-in end-of-match voting (`LayerVoting*.cfg`) is disabled or reduced to a fixed, panel-curated candidate set; the panel is free to implement its *own* voting/automation on top (GAME-1) using `AdminSetNextLayer` at the moment a match ends, informed by `match.started`/`match.ended` events (EVT-1).

## Decision

**We adopt Option B: a panel-managed rotation.**

The panel owns the scheduling and decision-making for "what layer plays next"; `LayerRotation.cfg` is treated as a *write target* the panel keeps synchronized with its own state, not as an independent source of truth the server advances through on its own. Squad's native end-of-match voting is not used as the primary mechanism — `GAME-1`'s automation issues `AdminSetNextLayer` directly, informed by the same layer catalog (this table) and the same scheduling primitives ROT-4 introduces.

Concretely, this means:

- `ROT-2` writes an ordered layer list into `LayerRotation.cfg`'s managed segment (read-modify-write via SYNC-3), but the panel does not depend on the server's own pointer through that list to know what plays next — it always resolves "next" through RCON (`ShowNextMap`, ROT-3) and/or its own schedule.
- `ROT-4`'s calendar/weekly-profile scheduling has nowhere to live in Squad's native config (no concept of time), so it must be panel-side regardless; making the rotation panel-managed end-to-end avoids having two competing sources of truth (native sequential rotation *and* a panel calendar layered on top of it).
- `GAME-1`'s "automatic voting" is reframed as panel-driven candidate selection + `AdminSetNextLayer`, not configuration of `LayerVoting*.cfg`. This ADR is the shared decision point referenced by GAME-1 so the two features don't independently pick contradictory answers.
- Manual admin actions (ROT-3: "Set next", "Change now", "End match") remain thin wrappers over RCON commands and always win over any pending schedule — the panel reconciles its managed segment / next pick after every such action.

## Consequences

**Positive**

- Single source of truth for "what plays next": the panel's own schedule/state, queried via RCON + the `layers` catalog — no need to reconcile Squad's internal rotation pointer with panel intent.
- Enables features Squad's native config cannot express at all: day-of-week rotation profiles (ROT-4), seed-window scheduling (SEED-1/SEED-3) that must interrupt normal rotation and resume afterward, and depot-update-aware scheduling — all without fighting the server's own advancement logic.
- `LayerRotation.cfg`'s managed segment stays a simple, panel-owned artifact (same mental model as `Admins.cfg`), consistent with the existing managed-segment pattern (CFG-1/SYNC-3) instead of a bespoke voting-config diff/merge.

**Negative / accepted trade-offs**

- The panel must implement its own end-of-match automation (GAME-1) instead of leaning on Squad's built-in voting UI — more code, but avoids maintaining two rotation authorities.
- If the panel/worker is down when a match ends, "what's next" falls back to whatever static list is currently in `LayerRotation.cfg`'s managed segment (last synced state) rather than a live decision — acceptable given RCON-1/EVT-1 already require the bridge to be up for most other panel functions.
- Admins who prefer Squad's native voting UI lose it; `LayerVoting*.cfg` is expected to be set to a minimal/disabled configuration by the managed segment once ROT-2 ships.

## Follow-up not covered by this issue

This issue (`ROT-1`) ships the `layers` catalog and `GET /api/v1/layers` against a **static fallback dataset** for the current Squad version (`depot_version`, see `packages/db/src/schema/layers.ts`). It intentionally does not implement live depot sync. The follow-up worker is expected to:

1. After a depot update, read the installed server's available layers via the bridge (`file_read` over the relevant pak/config listing — exact source file(s) to be confirmed when implemented).
2. Upsert rows by `name` (the RCON-facing identifier), refreshing `map`/`gamemode`/`version`/`teams`/`depot_version`.
3. Mark rows that disappear from the new listing as `deprecated = true` rather than deleting them, so historical references (`matches.layer`, rotation history) keep resolving.

`ROT-2`, `ROT-4`, and `GAME-1` build on the decision above; they should link back to this ADR rather than re-litigating managed-vs-native.
