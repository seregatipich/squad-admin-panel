# worker-discord — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-discord test
```

The package is part of the root `pnpm test:cov` filter list, so these tests run
in CI.

## Test files

All tests live under `apps/workers/discord/test/`.

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:discord` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

### `sender.test.ts`, `consume.test.ts`, `mapping.test.ts`, `crypto.test.ts`

The notify path: template resolution, per-webhook filtering, 429 handling,
consumer-group bookkeeping, and the encryption round-trip against a local
reimplementation of the API's `encrypt()`.

### `discord-rest.test.ts` (DISCORD-5)

The three guild-member REST calls against an injected `fetchImpl`: the exact
URLs and the `Bot` header, `403` → `missing_permissions`, `404` →
"not in the guild", non-2xx → `http_error`, network throw → `network_error`,
`Retry-After` honoured from both the header and the JSON body, and the ceiling
on consecutive 429 retries.

### `role-sync.test.ts` (DISCORD-5)

Per-player derivation and reconcile against a fake drizzle client and a fake
Discord: grant, revoke on role change, revoke-all on role removal, an unmanaged
Discord role never touched, a disabled mapping ignored, no-op without a link,
no-op for a non-member, `Missing Permissions` surfaced rather than swallowed,
`Retry-After` respected, reconcile restoring a hand-removed role and stripping a
hand-granted one, and the `loadDiscordBotContext` gate in all four
not-configured shapes plus the configured one.

The fake client honours `where(eq(col, value))` rather than ignoring it —
without that it would hand the code another player's row and the "wrong player"
bugs the suite exists to catch would pass.

### `role-sync-consume.test.ts` (DISCORD-5)

The stream loop against a fake Redis: request parsing, per-player vs
full-reconcile dispatch, acking a malformed entry, acking without syncing while
the bot is unconfigured, the consumer group created on `discord:role-sync`, and
the ok/error status written to `discord:role-sync:status`.

### `status-channel.test.ts` (DISCORD-6)

`buildStatusChannelName`, `countOnlineAdmins`, and `parseStatusCache` as pure
functions: the SQSTAT §16.3 name template from a connected snapshot, the
offline marker and zeroed counters when disconnected or the status cache is
missing, a missing `public_queue` read as zero rather than dropped, and the
100-character Discord channel-name limit enforced. `renameStatusChannel`
against a fake Redis and fake Discord REST: PATCHes and records the new name on
first run, issues no request when the name is unchanged, never exceeds two
renames per ten minutes on one channel, renames again once the window has
rolled past, and does not consume budget when Discord rejects the rename.
`runStatusChannelTick` against a fake DB/Redis: skips servers with no status
channel configured, renames the configured channel to the live status of its
server, and reports a server whose status cache has expired as offline instead
of skipping it.

### `status-channel-loop.test.ts` (DISCORD-6)

`runStatusChannelLoop`: does nothing while the bot is not configured, ticks
once the guild id and bot token are stored, keeps running when one tick
throws, registers slash commands once when `DISCORD_APPLICATION_ID` is
configured, does not touch the commands API without an application id, and
retries command registration on the next tick after a failure.
`registerApplicationCommands`: `DISCORD_COMMAND_DEFINITIONS` declares exactly
the three read-only commands (`status`, `player`, `online-admins`) and never
`ban`/`kick`; `PUT`s the definitions with the bot authorization header; and
reports a rejection or a network failure instead of throwing.

## Not covered

The live Discord REST call. It needs a real bot token and a real guild, which
cannot be synthesised in CI, so every test injects `fetchImpl`. The wiring in
`index.ts` (which passes the real `fetch`) is exercised only by
`index-import.test.ts`/`contract.test.ts`, not against Discord itself.
