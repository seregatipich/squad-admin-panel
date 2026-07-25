# worker-config-sync

## Purpose

Synthesizes the **managed segment of `Admins.cfg`** on every controlled Squad server from the panel's role/player database, pushes it atomically through the host bridge, and detects drift if anyone edits the managed segment outside the panel. The worker is the single writer of the marker-fenced section between `//SQUAD-PANEL BEGIN` and `//SQUAD-PANEL END`; everything outside those markers is preserved verbatim. After every successful write it issues an RCON `AdminReloadServerConfig` (via worker-rcon) so permission changes take effect without a container restart.

## What it does NOT do

- Does not parse Admins.cfg back into the database. Manual edits inside the markers are flagged as drift; the operator decides whether to force-sync (overwriting them) or copy them by hand into the UI.
- Does not touch any other `.cfg` file (Server.cfg, MapRotation.cfg, etc.) — the editor at `/servers/:id/configs` owns those.
- Does not push to a Git remote (that was the prior P2 stub plan; superseded — config history lives in `config_versions`).

## Code location

```
apps/workers/config-sync/
  src/
    index.ts        main loop: stream consumer + drift sweep
    syncer.ts       per-server reconcile (bridge round-trip, RCON reload, audit, status)
    rcon-reload.ts  best-effort AdminReloadServerConfig enqueue onto worker-rcon
    segment.ts      pure generator/parser/splicer for the managed segment
    db-snapshot.ts  read roles + players + role_squad_permissions for synth
    audit.ts        chained-hash audit_log append from the worker side
  test/
    contract.test.ts   subprocess contract tests (heartbeat, SIGTERM)
    segment.test.ts    unit coverage of generator/parser/splicer
    rcon-reload.test.ts unit coverage of the reload enqueue + gating
    syncer.test.ts     per-branch reconcile + reload wiring coverage
```

## Dependencies

- `@squad/bridge-client` — talks to `/run/panel-host-bridge/bridge.sock` for `file_read` + `file_atomic_write`.
- `@squad/db` + `drizzle-orm` — reads roles / role_squad_permissions / players.
- `ioredis` — XREADGROUP consumer for `events:admins-cfg-sync:<server_id>` streams + status publishing + RCON reload enqueue.
- `@squad/shared-config` — shared heartbeat / log-stream sink.
- `@squad/shared-types` — `rconCommandRequestSchema` / `rconCommandStream` for the `AdminReloadServerConfig` enqueue.
- `uuid` — v7 `request_id` for the enqueued RCON command (byte-parity with sibling workers).

## Components that depend on it

- `apps/api` enqueues sync events on every role / player-role mutation (`apps/api/src/lib/admins-cfg-sync.ts`).
- The `/api/v1/admins-cfg/drift` endpoint reads the status keys this worker writes.
- The `/settings/groups` UI relies on it to make role edits actually reach the Squad server.

## Basic usage example

```bash
# After editing a role or assigning a role to a player, the API publishes
# an event to events:admins-cfg-sync:<server_id>. The worker picks it up
# automatically.
#
# To inspect current sync state for a server:
redis-cli get admins-cfg:status:<server_id>
# → {"state":"in_sync","last_synced_at":"2026-04-27T10:30:00Z",...}
#
# Force-sync via the API (audit-logged):
curl -X POST -b "__Host-sid=$COOKIE" \
     "https://squad-panel.lan/api/v1/admins-cfg/sync?server_id=<uuid>"
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
