# Architectural decisions

Meaningful architectural choices, recorded as we make them.

## 2026-04-25 — Panel observability via two capped Redis Streams + pino multistream sink

### Context

Operators needed a single place to see what every panel component (api, bridge, rcon supervisor, log-ingest tail, depot/install steps, all workers) was doing — including connection state of the host bridge and per-RPC latency — plus a 24 h history graph for the dashboard's CPU/RAM/Disk/Network cards and a one-click export bundle for off-host triage. The existing surfaces only showed live state: pino → stdout → journald, `rcon:status:{id}` (live), `bridge.host_metrics` (live).

### Decision

Two new capped Redis Streams plus a pino multistream sink that fans every log line into one of them:

- **`panel:logs`** (`MAXLEN ~ 100000`, ≈ 10 MB) — every pino line from api + every worker + every bridge `onLog` event, encoded with single-letter field names (`s` source code, `l` level code, `i` server uuid optional, `m` message, `c` ctx json optional). The Redis stream-id millisecond prefix is the timestamp, so `ts` is never duplicated. Source codes `B/R/L/W/D/I/A`. Encoder/decoder in [`packages/shared-config/src/log-stream.ts`](../../packages/shared-config/src/log-stream.ts), pino multistream `Writable` in [`log-stream-sink.ts`](../../packages/shared-config/src/log-stream-sink.ts).
- **`host:metrics`** (`MAXLEN ~ 5760` = 24 h × 4/min, ≈ 300 KB) — packed 8-int tuple per sample, written every 15 s by the new `worker-metrics-sampler`. Helpers in [`metrics-pack.ts`](../../packages/shared-config/src/metrics-pack.ts).

GET endpoints on top: `/api/v1/logs` (filter + cursor pagination), `/api/v1/logs/export` (gzip-streamed sectioned bundle, gated by `host:metrics`), `/api/v1/host/metrics/history` (paired arrays). UI: `/logs` page with live-tail polling and an export button, click-to-expand `MetricHistoryModal` on the four dashboard cards.

### Rationale

- **Existing infrastructure.** Redis was already the event/heartbeat hub; adding two streams costs nothing and reuses the rotation pattern (`MAXLEN ~`).
- **Per-record packing > gzip.** For sub-100-byte log records gzip's per-block overhead exceeds savings. Single-letter keys + 1-byte enum codes get ~70 % of gzip's ratio at zero CPU cost. The export endpoint is the right place for gzip — long repeated lines and the CSV block compress well.
- **Postgres stays the durable security record.** `audit_log` keeps its hash chain. `panel:logs` is diagnostic and ephemeral — losing it on a Redis restart is fine. The export bundle includes a recent slice of `audit_log` for convenience but the canonical record is unchanged.
- **No new datastore, no Prometheus, no Grafana.** Diagnostic-only, human-eyeballed. Histograms / alerting can be a future sub-project.

### Consequences

- New worker `worker-metrics-sampler` in compose; uses `user: "0:${PANEL_GID}"` (primary GID `panel`) because the bridge's `SO_PEERCRED` check only sees the peer's primary GID — supplementary groups added via `group_add` aren't visible across the host user namespace.
- The api's `buildLogger` switched to `pino.multistream([stdout, lateSink])`; the late-bound sink wires up after `redisPlugin` registers. The ≈ 7 plugin registrations of api logs that fire before the wire-up land in stdout/journald only — acceptable for boot noise.
- Pino-http meta keys (`req`, `res`, `responseTime`, `reqId`, `name`) are stripped from the encoded `ctx` to keep entries small and avoid leaking full HTTP request/response objects into a 100 k-cap stream.
- The web client cannot import `unpackHostMetrics` from `@squad/shared-config` because the package barrel re-exports the `node:stream`-using log-stream sink; the modal duplicates the unpack math (5 lines) instead. Sub-path exports were considered and rejected as scope creep — the duplicated math is trivial and obvious.

### Alternatives considered

- **A separate Prometheus scrape + Grafana dashboard.** Rejected — adds two services, an HTTP scrape endpoint, label cardinality decisions, and config maintenance for a feature that fits in two Redis streams plus one chart library.
- **Postgres `panel_logs` table.** Rejected — every connector log line would write to disk, and the existing `audit_log` is doing similar work for security; doubling it for diagnostic noise is wrong.
- **Per-source streams (`panel:logs:bridge`, `panel:logs:rcon:{id}`, …).** Rejected — bookkeeping overhead, harder export iteration, and natural per-source backfill isn't a real operational need versus a single filter parameter.

## 2025-11-15 — One Docker container per Squad server (replaces native systemd units)

### Context

The original Phase-0 design ran each Squad server as a native `squad-server-{uuid}.service` systemd unit under `/opt/squad-servers/{uuid}/`, with the bridge spawning `steamcmd`, `apt`, and `systemctl` operations directly. The bridge surface included `steamcmd_run`, `systemctl_action`, `systemctl_write_unit`, `apt_install`, `journalctl_follow`.

### Decision

Each Squad server now runs as a Docker container (`squad-server:latest`, debian-bookworm-slim base). The bridge no longer spawns systemd units, apt, or steamcmd directly; instead it has `container_run|start|stop|rm|inspect|logs_follow`, `depot_update`, and the file/ufw subset.

### Rationale

- **Lower bridge surface area.** The new method set is structured params only — there is no string-arg passthrough to `steamcmd` or `apt`. Image allowlist is two entries.
- **Reproducibility.** SteamCMD's depot is now a shared named volume populated once; per-server containers mount it `:ro`. Spinning up a new server takes seconds instead of minutes.
- **Cleaner upgrade path.** Updating Squad becomes "rerun `depot_update` and recycle containers" rather than touching every host's systemd state.
- **EAC + EOS work natively in the container** with `--network host` and no extra capabilities (verified during the migration risk-spike).

### Consequences

- The bridge dropped `steamcmd_run`, `systemctl_action`, `systemctl_daemon_reload`, `systemctl_write_unit`, `systemctl_read_unit`, `apt_install`, `journalctl_follow`.
- Host-level apt/install logic moved into [`scripts/install-host-bridge.sh`](../../scripts/install-host-bridge.sh) (one-time setup) instead of being on the runtime path.
- The `squad` host user is no longer used; the container runs as uid 1001 internally and `chown`s the bind mounts on entrypoint.
- All Phase-0 doc artifacts that referred to systemd-units / steamcmd / apt-install (the original flat `architecture.md`, `bridge-protocol.md`, and the `experiment/` research notes) became stale and were removed when the new nested `docs/` structure landed.

### Alternatives considered

- **Keep native systemd, harden bridge args further.** Rejected — apt + steamcmd are unbounded surfaces; whitelisting them safely is harder than removing them.
- **Run Squad in `network_mode: bridge` with explicit port mapping.** Rejected — Squad's EOS handshake misbehaves behind a NAT layer; `--network host` is the supported config.

## 2026-04-25 — Steam-only login + steam_id64 PK + dual-anchor first-owner trick

### Context

Email/password + TOTP login was scoped for Phase 0 but never shipped to users. Spec §1.1–§1.6 mandated Steam OpenID 2.0 as the only authentication path. The panel manages Squad servers; players already have a primary identity (Steam ID) that is captured automatically by `worker-rcon` and `worker-log-ingest`.

### Decision

- Steam OpenID 2.0 is the only login method. `/api/v1/auth/login` and TOTP endpoints are removed.
- Identity anchor moves from `users.id uuid` to `players.steam_id64 bigint`. The `users` table is dropped.
- "Pending users" UI is replaced by "players without panel role" — assignment lives in `/players/<steam_id64>` profile under "Доступ к панели".
- First Steam-login after fresh install becomes Owner exactly once via dual anchor:
  - `organizations.settings.first_owner_claimed: true`.
  - Bridge-managed sentinel file `/var/lib/squad-panel/.first-owner-claimed`.
  - `pg_advisory_xact_lock(hashtext('first_owner'))` serialises concurrent callbacks.
- audit_log gains discriminated actor union: `(actor_kind='steam', actor_steam_id64)` or `(actor_kind='system', actor_system_label)`. `actor_token_id` traces actions taken via API tokens (P1+ surface, schema-only for now).
- Sessions are sliding with 6h TTL and 60s touch throttle (Redis `SETNX session-touch:{id}`).

### Rationale

Steam ID is the universal Squad identity. Anchoring everything (sessions, audit, role assignments) on `players.steam_id64` removes the artificial split between "panel users" and "game players" — a moderator IS a player who happens to have a panel role.

The dual anchor for first-owner survives `DROP DATABASE` + restore: the sentinel file persists on the host. Deleting both the DB row and the sentinel file requires root + bridge access — i.e., a deliberate operator action, never accidental.

### Consequences

- Steam Web API key (`STEAM_API_KEY`) is optional. Without it, persona is `Player <last 4 of steam_id64>`; the player can update their canonical name when they next play on a server (RCON ListPlayers updates).
- Audit hash chain uses `action_type|target_type|target_id|context|created_at` — actor fields are NOT in the canonical payload, so the discriminated actor change does not break `pnpm verify:audit-chain`.
- e2e tests cannot fully exercise the OpenID 2.0 verifier without a real Steam account; they verify post-login state via `PANEL_TEST_COOKIE` env. The cookie-supply pattern is documented in `docs/components/api/testing.md`.

### Alternatives considered

- **Soft-cut behind a feature flag** — kept email/password as a backdoor. Rejected: doubled the auth attack surface and the spec explicitly required "единственный способ входа".
- **Discord OAuth as alternative** — rejected for Phase 1; Discord remains a linked identity for notifications/bot scope (P1+).
- **Steam OAuth instead of OpenID 2.0** — Steam has no OAuth endpoint. OpenID 2.0 is the only public auth surface Steam offers.
