# worker-clan-guard - API surface

No HTTP surface. The worker is driven by its timer, reads Postgres, and writes to Redis streams and Postgres tables.

## Exported functions

[`src/tick.ts`](../../../../apps/workers/clan-guard/src/tick.ts):

| Function | Purpose |
|---|---|
| `runClanGuardTick(deps)` | One enforcement pass; returns `{ skipped, warned, kicked, errors }`. |
| `matchProtectedTag(rawName, tag)` | Case-insensitive prefix match of a tag against a raw player name (rules in [flows.md](./flows.md)). |
| `findImpostorMatch(rawName, clans, playerId)` | First protected clan, among clans the player is not a member of, with a tag that matches. Returns `{ clanId, clanName, tag }` or `null`. |
| `buildClanGuardMessage(tag, clanName)` | Single-line Russian warn/kick text. |

[`src/deps.ts`](../../../../apps/workers/clan-guard/src/deps.ts): `createClanGuardDeps(db, redis)` plus the individual implementations `loadSettings`, `loadProtectedClans`, `loadOnlinePlayers`, `findLastWarn`, `hasRecordedKick`, `recordModerationAction`, `writeClanGuardAuditEntry` and `sendRconCommand`.

The process entry point is [`src/index.ts`](../../../../apps/workers/clan-guard/src/index.ts); importing it from a test does not start the worker.

## Redis stream written: `rcon:commands:<serverId>`

`sendRconCommand` appends one entry per warn or kick, fire-and-forget (it does not wait for a result key):

```
XADD rcon:commands:<serverId> MAXLEN ~ 500 * request <json>
```

`<json>` is validated with `rconCommandRequestSchema` before it is sent:

```json
{
  "request_id": "<uuid v7>",
  "command": "AdminWarn" | "AdminKick",
  "args": ["<player eos_id>", "<message>"],
  "actor_player_id": null,
  "enqueued_at": "<ISO 8601>"
}
```

The schema is strict and limits `args` to 8 items of at most 1024 characters each; a violation throws and is counted as a per-player error. `worker-rcon` consumes the stream.

### Message text

`Тег <tag> защищён кланом <clan name>. Смените ник.` Line breaks inside the tag or clan name are replaced by a space and the values are trimmed.

## Postgres writes

| Table | Row |
|---|---|
| `moderation_actions` | `action_type = 'clan_tag_protection'`, `author_system_label = 'clan-guard'`, `reason` = the message, `context = { phase, clan_id, tag, matched_name }`. |
| `audit_log` | System actor `clan-guard`; `action_type` `clan.tag_protection.warn` or `clan.tag_protection.kick`; `target_type = 'player'`, `target_id` = player UUID; `context = { server_id, clan_id, message }`. |

## Heartbeat key: `worker:heartbeat:clan-guard`

Published every 5 s with TTL 30 s and status text `running`.

## Diagnostic events (`diag:queue` Redis Stream)

Every event carries `component: 'worker-clan-guard'`. There is no per-tick success event.

| Kind | Severity | Trigger | Payload |
|---|---|---|---|
| `clan_guard.started` | `info` | After startup wiring, before the first pass. | `{ pid }` |
| `clan_guard.stopped` | `info` | Inside the SIGTERM/SIGINT handler. | `{ sig }` |
| `clan_guard.skipped_disabled` | `info` | A tick found `clan_guard_settings.enabled = false` (emitted on every such tick). | `{}` |
| `clan_guard.player_failed` | `error` | Enforcement for one player threw (RCON enqueue, ledger or audit write). | `{ playerId, serverId, err }` |

## Related HTTP routes (served by the API)

- `GET /api/v1/settings/clan-guard` (any panel user) returns `{ enabled, grace_period_seconds, updated_at, updated_by_player_id }`; defaults are `enabled: true` and `300` seconds when the row does not exist.
- `PATCH /api/v1/settings/clan-guard` (`canManageClans`) updates `enabled` and/or `grace_period_seconds` (integer 0 through 3600) and audits `clan_guard.settings.update`.
