# worker-discord — API surface

No HTTP surface of its own. Its contracts are Redis keys/streams (outbound) and
Discord itself (outbound REST calls, plus inbound slash-command invocations
handled elsewhere).

## Inbound: Discord slash commands

Discord POSTs `/status`, `/player`, and `/online-admins` invocations to the API,
not to this worker — `POST /api/v1/integrations/discord/interactions` in
`apps/api/src/routes/discord-interactions.ts`. This worker only *registers* the
command definitions (`command-registration.ts`, `PUT
/applications/{id}/commands`, gated on `DISCORD_APPLICATION_ID`); it never
receives an invocation itself.

## Heartbeat key: `worker:heartbeat:discord`

Published every 5 s (default interval), TTL 30 s — whenever `REDIS_URL` is set.

`status` field: `"sent=N failed=N rateLimited=N"`, the notify loop's running
delivery counters (zero for all three while the notify loop is disabled or has
not yet delivered anything).

## Outbound: Discord REST calls (`discord-rest.ts`, `command-registration.ts`)

All calls authenticate with `Bot <token>` against `https://discord.com/api/v10`.

| Call | Method + route | Used by | Requires |
|---|---|---|---|
| Fetch a guild member's roles | `GET /guilds/{guild}/members/{user}` | `role-sync.ts` derivation | — |
| Grant a guild role | `PUT /guilds/{guild}/members/{user}/roles/{role}` | `role-sync.ts` derivation | **Manage Roles**, bot above the role in the hierarchy |
| Revoke a guild role | `DELETE /guilds/{guild}/members/{user}/roles/{role}` | `role-sync.ts` derivation | **Manage Roles**, bot above the role in the hierarchy |
| Rename a channel | `PATCH /channels/{id}` | `status-channel.ts` rename tick | **Manage Channels**; capped at 2 updates/10 min per channel |
| Register slash commands | `PUT /applications/{id}/commands` | `command-registration.ts`, once per boot | `DISCORD_APPLICATION_ID`; `applications.commands` scope |
