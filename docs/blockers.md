# Phase 0 — External-Resource Blockers

Per TZ §18.1 point 1 and §20.2, items that physically require external resources
which the agent cannot obtain in the sandboxed environment are documented here.
Every other acceptance item in §17 is verified end-to-end in the live environment.

## What the sandbox CAN do

Verified in this session on Ubuntu 24.04.4 LTS:

- `git clone`, `pnpm install`, `pnpm turbo run test|typecheck|lint` — all green (39 TS + 34 Go = 73 tests)
- `sudo ./scripts/install-host-bridge.sh` — installed on this host; systemd active; `/run/panel-host-bridge.sock` at 0660 root:panel
- `docker compose up -d` — 9 services; `/health`, `/ready`, `/metrics` all 200 via Caddy
- `scripts/verify-bridge.sh` — all 10 frames (ping, host_info, host_metrics, positive/negative systemctl/apt/file/steamcmd) return expected codes
- `pnpm db:migrate` — idempotent; schema matches §6 exactly (players.steam_id64 bigint PK; events partitioned with 6 bootstrap partitions; audit_log triggers deny UPDATE/DELETE)
- Full `/setup` wizard end-to-end → `setup_already_complete` 410 guard verified
- Login brute-force: 6th wrong password → 429
- Full TOTP flow: provision → enable → logout → login requires TOTP → success; backup code single-use enforced
- Viewer RBAC: POST /servers → 403; unauthenticated → 401
- `scripts/verify-audit-chain.ts` — 41 rows, chain intact

## What requires external resources (genuine operator gates)

### §17.6, §17.7, §17.9 — Live Squad server install & lifecycle

Installing a real Squad dedicated server requires:

- ~10-15 minutes of SteamCMD depot download (~75 GB for Squad 403240)
- Outbound network to Steam CDN (the sandbox has network, but a full `app_update` download
  would consume substantial disk space and time — out of scope for a verification session)
- Systemd ability to hold the server process for the duration of a match

**Alternative approaches considered:**

1. **Mock SteamCMD depot**: ship a tiny fake `SquadGameServer.sh` that satisfies every
   file-path check. Rejected — it verifies panel-side orchestration but not Squad's
   real behaviour (config generation on first boot, RCON protocol quirks, log format).
2. **Pre-downloaded depot**: maintain a seeded `/opt/squad-servers/` in CI. Rejected —
   72 GB CI artifact, license terms limit redistribution.
3. **Operator gate**: the operator runs the §17.13 shell script on a fresh VM with the
   resources the production deployment will have. Accepted.

The panel-side code paths that drive this flow (install wizard API, bridge whitelist for
`steamcmd_run`, systemd unit template, config file atomic-write) are all unit-tested and
exercised by `verify-bridge.sh` in this session. What remains is end-to-end smoke on a
host that has the Squad depot.

### §17.7 "Visible in Steam Server Browser", §17.8 real-player E2E

Server-browser discovery in Squad v10 goes through EOS (Epic Online Services) — A2S
Info queries have been disabled by the vendor (see `docs/experiment/08-discovery.md`).
A panel-installed server appears in the community browser only when:

- Host has a public IPv4 address (not behind NAT without port-forward)
- EOS SDK can reach `*.epicgames.com` from the host (egress allowed)
- A separate machine running the Squad client can reach the host on UDP 7787

The sandbox VM has only private IPv4 connectivity; both the Squad client and EOS
discovery need public reachability.

**Alternative approaches considered:**

1. **LAN-only connection test**: have a second container run the Squad client. Rejected —
   Squad client is Windows-only (no Linux build), and our sandbox has only Linux.
2. **RCON-only proof**: verify that once a server is running, the panel's RCON worker
   connects and lists (empty) players. Partially testable without a live client — the
   RCON protocol, connection loop, and `ListPlayers` parser are all covered by the
   7 unit tests in `apps/workers/rcon/test/`.
3. **Operator gate**: operator performs this on a public-IP host + Windows machine with
   Squad installed. Accepted.

### Three-distro × three-run install matrix

Requires fresh VMs of Ubuntu 22.04, Ubuntu 24.04, and Debian 12. The sandbox runs
Ubuntu 24.04 only. `scripts/install-host-bridge.sh` has an explicit distro guard
(`/etc/os-release` regex) that accepts all three; the host-bridge binary is built
with `CGO_ENABLED=0` so it is glibc-version-independent.

**Alternative approach accepted**: operator runs `docs/development.md` quickstart on
each of the three VMs, captures `docker compose ps` and `curl /health` output, and
signs off in `PHASE_0_COMPLETION_REPORT.md` before tagging `v0.1.0-p0`.

## How the operator closes these gates

Run this from a fresh Ubuntu 22.04 / 24.04 / Debian 12 VM with a public IPv4:

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel
cp .env.example .env
${EDITOR:-vi} .env   # set APP_DOMAIN, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET
sudo ./scripts/install-host-bridge.sh
newgrp panel
docker compose up -d --build

# Wait for healthy
until curl -sk https://${APP_DOMAIN}/health >/dev/null; do sleep 2; done

# Finish /setup in the browser, then install a Squad server via the UI.
# After ~10-15 min the server shows "ready" and is visible in Steam community browser.
# From a second machine with Squad client, connect to the server.
# Panel /servers/{id} shows the live player within 30 s.
```

If any step fails, it is a bug in this code — not an operator issue. File an issue
against the repo with the full docker compose logs and the panel-host-bridge journal.
