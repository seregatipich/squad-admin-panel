# `shared-types` — changelog

## 2026-09-27

### Security
- `api.ts` (#34): `externalRconHost` refuses hosts that land on the panel host itself (loopback, unspecified, link-local, IPv4-mapped/compatible IPv6, `localhost`, `*.docker.internal`, `*.containers.internal`, single-label names, non-canonical numeric IPv4 such as `127.1`), and `rconPasswordString` refuses CR, LF and NUL. Both replace the bare `rconHostString` / `z.string()` fields in `externalServerCreateInput` and `externalServerConnectionUpdate`; `rconHostString` itself (used by `ssh_host`) is unchanged.

## 2026-09-28

### Security
- `serverCreateInput.multihome` и `serverSettingsUpdate.multihome` принимают только IP-литерал (`z.string().ip()`): bridge подставляет значение в командную строку сервера Squad (`RCONIP=`/`MULTIHOME=`), и строка с пробелами могла добавить параметры запуска (#52).

## 2026-09-28 — Validation gaps from the #53 audit

### Fixed
- `automation.ts`: `kickActionSchema.reason` is required (non-blank) — worker-rcon refuses `AdminKick` with an empty reason, yet such rules were saved and every firing recorded as executed. Migration `0119_automation_kick_default_reason` backfills a reason on existing blank-reason kick rules.
- `automation.ts`: `rconCommandActionSchema` requires exactly the argument count worker-rcon demands for the command (new `RCON_OPERATOR_COMMAND_ARG_COUNTS` in `rcon-commands.ts`), each argument non-blank.
- `automation.ts`: `timeOfDayConditionSchema.timezone` must resolve through `Intl` (`unknown IANA timezone` otherwise) instead of saving a rule that silently never fires.
- `automation-engine.ts`: `chat_keyword` `word` mode uses Unicode letter/digit boundaries (`u` flag), so Cyrillic keywords no longer match inside other words.
- `api.ts` / `server-settings.ts`: `multihome` must be an IPv4/IPv6 literal. `extra_args`, `launch_args_override`, `cpu_affinity`, `cpu_weight`, `niceness`, `memory_high_mb`, `memory_max_mb`, `io_weight` accept only their unset value (`''`/`null`): the container was never started with them, so a value is now rejected instead of pretending a limit is in force.

## 2026-07-27

### Added
- `events.ts` (`DISCORD-5`, #152): `DISCORD_ROLE_SYNC_STREAM` (`discord:role-sync`), `DISCORD_ROLE_SYNC_GROUP` (`discord-role-sync:v1`), `DISCORD_ROLE_SYNC_MAXLEN`, `DISCORD_ROLE_SYNC_STATUS_KEY` (`discord:role-sync:status`), and the `discordRoleSyncRequest` / `discordRoleSyncStatus` Zod schemas. Deliberately a stream of its own rather than an `EventEnvelope` on `events:*`: the payload is a work item ("re-derive this player's Discord roles"), not a domain event, and worker-discord's notify loop must not see it. `player_id: null` means "reconcile every linked player".

## 2026-07-09

### Added
- `plugins.ts` (`INT-4`): `pluginManifest` Zod schema, `PLUGIN_PERMISSIONS`/`PluginPermission`, `PluginHandler` contract, `hasPluginPermission` helper — the plugin/event-hook contract hosted by `apps/workers/automation`.

## 2026-04-25

### Added
- Full 8/8 component documentation (api, data-model, flows, configuration, testing, troubleshooting, changelog).

## 2025-11-15

### Added
- `api.ts`: `serverCreateInput` (resource limits, CPU affinity, niceness, memory, IO weight fields); `serverRow`, `playerRow`, `auditEntry`, `paginated` factory; `hostInfo`, `hostMetrics`, `bridgeStatus`, `serverStatus`.
- `events.ts`: `server.install.started`, `server.install.progress`, `server.install.failed`, `server.install.completed` types for install WebSocket progress.
- `events.ts`: `bridge.connected`, `bridge.disconnected` types for bridge health events.
- `STREAM_NAME`, `CONSUMER_GROUP`, `DEDUP_KEY`, `DEDUP_TTL_SECONDS`, `XAUTOCLAIM_IDLE_MS`, `XAUTOCLAIM_TICK_MS`, `DLQ_DELIVER_THRESHOLD` constants.
- `matchStateChangedPayload`, `serverLifecyclePayload` Zod schemas.
- Sub-path exports `./events` and `./api` in `package.json`.

### Changed
- `EventEnvelope.event_id` clarified to UUIDv7 (producers use `uuid` v7).
- `auditEntry.id` changed from `z.number()` to `z.string()` to handle `bigserial` safely.

## 2025-09-01

### Added
- Initial package: `events.ts` with `EventEnvelope`, `EVENT_TYPES` (12 initial types), `playerConnectedPayload`, `playerDisconnectedPayload`, `rconPlayersPolledPayload`, `validatePayload` dispatcher.
