# worker-discord — Flows

Three independent loops run in one process; any one can be idle without
affecting the others.

## Notify (DISCORD-2)

Discover event streams → reclaim anything a dead consumer left pending →
`XREADGROUP` → map the envelope type to a Discord event type → render the
stored (or default) template → POST to every enabled matching webhook → set the
dedup key → `XACK`. Delivery is at-least-once: the dedup key is only written
after a successful send, and the `XACK` only after that.

## Role sync (DISCORD-5)

**Reaction (≤60 s).** `PUT`/`DELETE /api/v1/players/:playerId/role` commits,
then publishes `{ player_id, reason }` to `discord:role-sync`. The loop reads
the request, resolves the Discord bot credentials, and re-derives that player's
Discord roles.

**Per-player derivation.** Look up the player's `player_discord_links` row — no
row means no-op. Load every *enabled* `discord_role_mappings` row; the union of
their `discord_role_id`s is the **managed set**, and the subset keyed by the
player's `players.role_id` is the **desired set**. `GET
/guilds/{guild}/members/{user}` gives the member's current roles — a `404` means
the account is simply not in the guild, which is a no-op, not an error. Then:

- add `desired \ current`;
- remove `(managed ∩ current) \ desired`.

A role outside the managed set is never touched, so operators keep manual
control of every guild role the panel does not map.

**Reconcile (hourly, or on demand).** A request with `player_id: null` — from
the tick, or from `POST /api/v1/integrations/discord/role-mappings/reconcile` —
runs the same derivation for every `player_discord_links` row. The panel wins
both ways: a role removed by hand in Discord is restored, and a managed role
granted by hand is stripped. The link table is walked rather than the guild
member list because batch member listing needs the privileged `GUILD_MEMBERS`
intent.

Reconcile is also the durability backstop: the `XADD` is best-effort, so a lost
request self-heals within one interval instead of needing a transactional
outbox.

**Failure reporting.** Every outcome is written to `discord:role-sync:status`;
a `403` from Discord becomes `state: "error", reason: "missing_permissions"`,
which the settings page renders as a banner. Nothing fails silently.

## Status channel (DISCORD-6)

**Tick (default 10 min, `DISCORD_STATUS_CHANNEL_MS`).** Resolve the Discord bot
credentials via `loadDiscordBotContext` — until an operator stores a guild id
and a bot token the tick runs, finds nothing to do, and sleeps. If a
`DISCORD_APPLICATION_ID` is configured and slash commands have not yet been
registered this boot, `registerApplicationCommands` `PUT`s the `/status`,
`/player`, `/online-admins` definitions to Discord (`DISCORD_COMMAND_DEFINITIONS`
in `command-registration.ts`); a full-replace `PUT` is idempotent, so retrying
on a later tick after a failure is safe.

**Per-server rename.** Load every server with a `status_channel_id` set (and not
deleted), plus the panel-access admin `steam_id64` set (`players` joined to
`roles`, `panel_access` or the system `Owner` role) once for the whole tick.
For each target server: read `rcon:status:{serverId}` and
`rcon:roster:{serverId}` from Redis, build the channel name
(`{emoji}{map}_{players}x{queue}_👮{admins}`, offline/zeroed when the status
cache is absent or not `connected`), and call `renameStatusChannel`.

**Rate limiting.** `renameStatusChannel` skips the Discord call entirely when
the desired name matches the last applied name (a no-op rename still spends
budget). Otherwise it enforces Discord's own **two renames per ten minutes per
channel** (`STATUS_CHANNEL_RENAME_WINDOW_MS` = 600 000 ms,
`STATUS_CHANNEL_MAX_RENAMES_PER_WINDOW` = 2), tracked in the
`discord:status-channel:{channelId}` Redis key so the budget survives a worker
restart. A rename attempted over budget is reported as rate-limited rather than
sent, since Discord locks the channel out for minutes if the caller goes over
it.

**Admin count.** `👮N` counts online roster players (from `rcon:roster:*`)
whose SteamID is in the panel-access set — the same rule the slash-command gate
uses, so the number matches who could actually act through the panel.
