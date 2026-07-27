# worker-discord — Flows

Two independent loops run in one process; either can be idle without affecting
the other.

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
