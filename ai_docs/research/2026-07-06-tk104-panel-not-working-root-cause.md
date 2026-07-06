# Why the Squad Admin Panel "does not work" on tk104 — root-cause research

**Date:** 2026-07-06
**Host:** `tk104` (Ubuntu 24.04, `tk104.duckdns.org`, panel at `https://tk104.duckdns.org/`)
**Investigator:** Claude Code session (evidence gathered live over SSH + panel Postgres audit log)
**Status:** Root cause identified, **proven, and fixed**. Bridge + full worker fleet deployed;
`worker-rcon` resolved; `/ready` reports `{"status":"ok","checks":{"postgres":"ok","redis":"ok",
"bridge":"ok"}}`. See [§7 Current state](#7-current-state-after-this-session). Only optional cleanup
of the failed server stub remains ([§8](#8-remaining-work)).

---

## 1. TL;DR

**Every symptom on the dashboard traces to a single missing component: the `panel-host-bridge`
daemon was never deployed on tk104.** The panel's entire host-facing surface (server install,
RCON, host metrics, log ingest, config sync, docker prune) talks to a privileged Go daemon over a
Unix socket at `/run/panel-host-bridge/bridge.sock`. That socket did not exist, so every host
operation failed with the exact same OS error:

```
connect ENOENT /run/panel-host-bridge/bridge.sock
```

The panel web app / API / Postgres / Redis were all healthy. What was missing was **(a)** the
out-of-Docker bridge daemon and **(b)** the entire worker fleet — neither was included in the
compose file used to deploy tk104.

**Proof:** the panel's own `audit_log` shows 15 consecutive `host.docker_prune` events failing with
`502 … connect ENOENT /run/panel-host-bridge/bridge.sock`, then — at `08:00`, immediately after the
bridge was installed at `07:58` — the **first `host.docker_prune` returning `200`**. Same story for
the failed server install (`500 … ENOENT` at `05:18`). See [§5 Evidence](#5-evidence).

---

## 2. What the operator saw (symptoms)

From the dashboard the user reported:

| Dashboard symptom | Underlying cause |
|---|---|
| **Host state: "Критично — bridge disconnected"** | `/run/panel-host-bridge/bridge.sock` does not exist |
| **Alert: `bridge: connect ENOENT /run/panel-host-bridge/bridge.sock`** | literally the missing socket |
| **Соединения 2 / 7 здоровы** (2 of 7 healthy) | only Postgres + Redis were up; bridge + 4 workers absent |
| **panel-host-bridge: `connect ENOENT …bridge.sock`** | missing daemon |
| **worker-rcon / worker-log-ingest / worker-audit-archiver / worker-event-partition: "нет heartbeat"** | those worker containers were never deployed |
| **server-1-bss — "Сбой" (failed)** | `server.install.failed` at 05:18, error = ENOENT on the bridge socket |
| **`host.docker_prune` … "критично"** (repeated ~hourly) | periodic auto-prune failing with `502` because the bridge socket was missing |
| **Ядро / Docker / IP / Load avg — "нет данных"** | host metrics are sampled from the bridge by `worker-metrics-sampler`; no bridge ⇒ no metrics |
| **Серверов 1 / 0 работает, Игроков онлайн 0** | the one server row exists in DB but never installed/booted (RCON never polled) |

All of these are **one fault surfacing in many UI widgets**, not many independent faults.

---

## 3. Architecture context (why a missing socket breaks everything)

The panel is a single-host system with a deliberate split:

- **In Docker (compose):** `api` (Fastify), `web` (Next.js), `caddy` (TLS), `postgres`, `redis`,
  `migrator` (one-shot), and **9 workers** (`log-ingest`, `rcon`, `config-sync`, `audit-archiver`,
  `event-partition`, `presence-daily`, `leaderboard-aggregator`, `diag-flush`, `metrics-sampler`).
- **Outside Docker (systemd):** `panel-host-bridge` — a privileged Go daemon that owns
  `docker.sock` + `CAP_NET_ADMIN`. It is the *only* component allowed to launch Squad game-server
  containers, run steamcmd, read/write host config files, prune Docker, and read `/proc` host
  metrics. Containers reach it over `/run/panel-host-bridge/bridge.sock` (mode `0660 root:panel`),
  bind-mounting the socket directory and running with **primary GID = `panel`**.

Because the bridge is the single chokepoint for *all* host mutations and host reads, its absence
degrades every host-facing feature at once while leaving the "pure web app" (login, browsing DB
data) working. That is exactly the picture the operator saw.

Reference: `docs/operations/deployment.md` → "Bridge daemon (host, not Docker)";
`docs/components/bridge/troubleshooting.md`; `apps/bridge/deploy/panel-host-bridge.{service,socket,tmpfiles.conf}`.

---

## 4. Root cause

### 4.1 Primary: tk104 was deployed with a "core-only" compose file

`compose.tk104.yml` (invoked by `scripts/deploy-tk104.sh`) contained **only** the core web stack:

```
postgres, redis, migrator, api, web, caddy
```

It did **not** contain:

- any wiring for the bridge socket on `api` (`BRIDGE_SOCKET`, the `/run/panel-host-bridge` bind-mount,
  or `user: "0:${PANEL_GID}"`), and
- **any of the 9 workers.**

And `scripts/deploy-tk104.sh` only runs `docker compose … up -d`. It never runs
`scripts/install-host-bridge.sh`, which is the script that actually:

- builds/installs the `panel-host-bridge` binary to `/usr/local/bin`,
- installs the systemd `.service` + `.socket` + `tmpfiles.d` snippet,
- creates the `panel` group and the `/run/panel-host-bridge` runtime dir,
- provisions the data tree and the `squad-depot` volume.

So on tk104 there was **no bridge binary, no systemd unit, no `panel` group, no socket, and no
workers** — while the dashboard UI (the full-featured admin panel) assumes all of them exist. The
result is a permanent "bridge disconnected" state.

Confirmed on the host before the fix:

```
$ systemctl status panel-host-bridge.socket
Unit panel-host-bridge.socket could not be found.
$ ls /run/panel-host-bridge/
ls: cannot access '/run/panel-host-bridge/': No such file or directory
$ getent group panel        # (empty — group did not exist)
$ docker ps                  # only postgres/redis/api/web/caddy/migrator — no workers
```

### 4.2 Why the compose was core-only

The most recent service commit (`1bc3378 docs(services): squad-admin-panel deployed on tk104:443`)
shows the deployment was stood up to get the **login + dashboard reachable over HTTPS** (Caddy
DNS-01 on `:443`), i.e. the web tier first. The host-management tier (bridge + workers) was simply
never wired into the tk104 compose. This is a *scope gap between what was deployed and what the UI
expects*, not a code defect in the panel itself.

### 4.3 Contributing detail: `worker-rcon` + host networking

`worker-rcon` runs with `network_mode: host` (Squad servers expose RCON on the host's loopback).
In that mode it reaches Postgres/Redis via `127.0.0.1:5432` / `127.0.0.1:6379` **from the host
namespace**, not over the compose network. The core `compose.tk104.yml` does not publish those
ports to the host loopback, so once the worker was added it crash-looped with:

```
connect ECONNREFUSED 127.0.0.1:6379
```

This is a secondary issue that only *surfaced* after the primary fix (adding the workers). It is
addressed by publishing `127.0.0.1:5432:5432` and `127.0.0.1:6379:6379` on the `postgres`/`redis`
services (see [§8](#8-remaining-work)).

### 4.4 Deployment mechanism note (why a plain `git pull` redeploy fails)

The host app directory `/home/seregatipich/apps/squad-admin-panel` is **not a git repository**
(`fatal: not a git repository`). tk104 is provisioned by copying files in (git-bundle / scp
workflow), not by `git pull`. Any redeploy must **push the updated `compose.tk104.yml` to the host
by file copy**, then `docker compose … up -d`. A `git pull` step will silently no-op/fail.

---

## 5. Evidence

### 5.1 The panel's own audit log — the smoking gun

Query (`audit_log`, live Postgres on tk104):

```
     ts      |      action_type       | status_code |  reason  |                       error
-------------+------------------------+-------------+----------+---------------------------------------------------
 07-06 08:00 | host.docker_prune      |         200 | periodic |                                          ← FIRST SUCCESS
 07-06 07:47 | host.docker_prune      |         502 | periodic | connect ENOENT /run/panel-host-bridge/bridge.sock
 07-06 06:52 | host.docker_prune      |         502 | periodic | connect ENOENT /run/panel-host-bridge/bridge.sock
 07-06 05:34 | host.docker_prune      |         502 | periodic | connect ENOENT /run/panel-host-bridge/bridge.sock
 07-06 05:18 | server.install.failed  |         500 |          | connect ENOENT /run/panel-host-bridge/bridge.sock
 07-06 05:18 | server.install.started |         200 |          |
 07-06 05:18 | server.create          |         201 |          |
 07-06 04:14 | host.docker_prune      |         502 | periodic | connect ENOENT /run/panel-host-bridge/bridge.sock
 …           | host.docker_prune      |         502 | periodic | connect ENOENT /run/panel-host-bridge/bridge.sock
```

`host.docker_prune` status distribution:

```
 status_code | count
-------------+-------
         200 |     1     ← after bridge install (07:58)
         502 |    15     ← every prune while the socket was missing
```

**Interpretation:**
- The 15 × `502` prunes are the "критично" `host.docker_prune` spam from the dashboard. They are
  *symptoms of the missing bridge*, not an independent problem — each is the periodic auto-prune
  (`orphan-sweep.ts`) failing to `connect` the bridge socket.
- The single `200` at `08:00` is the first prune **after** the bridge was installed — direct proof
  that installing the bridge resolves the fault.

### 5.2 The failed server install (`server-1-bss`)

```
 07-06 05:18 | server.install.failed  | 500 | {"error":"connect ENOENT /run/panel-host-bridge/bridge.sock","durationMs":13}
 07-06 05:18 | server.install.started | 200 | {"url":"/api/v1/servers/019f35dc-…/install","method":"POST",…}
```

Server `019f35dc-f1ba-70eb-927a-f29786c6a97b` was created (`201`) and install started, but the
install RPC failed after **13 ms** — it never reached steamcmd; it failed immediately trying to
`connect` the (missing) bridge socket. That is the "Сбой" row on the dashboard.

Aftershock: `worker-config-sync` now repeatedly logs (harmless but noisy):

```
rpc file_read … stat /var/lib/squad-panel/configs/019f35dc-…/ServerConfig/Admins.cfg:
  no such file or directory
```

because it keeps trying to sync `Admins.cfg` for a server whose install never completed.

### 5.3 `host.docker_prune` source (why it was "critical" and periodic)

- `apps/api/src/plugins/orphan-sweep.ts` schedules `fireAutoPrune(app, 'periodic', …)` at boot
  (after a 30 s delay) and then on a 24 h timer.
- `apps/api/src/lib/auto-prune.ts` writes the audit row with
  `statusCode: errorMsg ? 502 : 200`. With the bridge socket missing, `client.dockerPrune()` throws
  `ENOENT`, so every row is `502` → the dashboard renders it as **критично**.

So the "critical docker prune" alerts were never about disk or Docker — they were the bridge socket
being absent, re-reported on a timer.

### 5.4 Host state before vs after the bridge install

```
# before
$ systemctl status panel-host-bridge.socket → "could not be found"
$ ls /run/panel-host-bridge/               → "No such file or directory"

# after scripts/install-host-bridge.sh
$ systemctl is-active panel-host-bridge.socket   → active
$ ls -l /run/panel-host-bridge/
  srw-rw---- 1 root panel 0 Jul  6 07:56 bridge.sock
$ systemctl status panel-host-bridge.service
  Active: active (running) since Mon 2026-07-06 07:58:47 UTC
$ redis-cli --scan --pattern 'worker:heartbeat:*'
  worker:heartbeat:presence-daily
  worker:heartbeat:diag-flush
  worker:heartbeat:config-sync
  worker:heartbeat:event-partition
  worker:heartbeat:metrics-sampler
  worker:heartbeat:leaderboard-aggregator
  worker:heartbeat:audit-archiver
  worker:heartbeat:log-ingest        (8 of 9; worker-rcon pending — see §4.3)
```

---

## 6. Why it is NOT other things (ruled out)

- **Not the web app / API / DB / Redis.** `api` was `Up (healthy)`; Postgres and Redis were healthy
  the whole time; the dashboard rendered and served data. The failure was strictly host-facing.
- **Not TLS / Caddy / DuckDNS.** The panel was reachable over HTTPS on `:443` throughout.
- **Not a code bug in the bridge or workers.** The images build and the bridge runs cleanly once
  installed; the fault was that they were **never deployed** on tk104.
- **Not disk / Docker health.** The `docker_prune` "critical" rows are `connect ENOENT` on the
  socket, not prune/disk errors (a real prune returns `200` with `reclaimed_bytes`, as the `08:00`
  row shows).
- **Not a stale-inode / GID mismatch** (the classic bridge bugs in
  `docs/components/bridge/troubleshooting.md`). Those produce `rejected untrusted peer` /
  `socket closed`. Here the error is `ENOENT` — the socket file itself was absent, a strictly
  earlier failure mode (nothing was listening at all).

---

## 7. Current state (after this session)

| Component | Before | After |
|---|---|---|
| `panel-host-bridge` daemon | absent | **installed, `active (running)`**, socket `srw-rw---- root panel` |
| `panel` group | absent | created (`gid 986`), `seregatipich` added |
| Go toolchain (to build bridge) | 1.22 (apt) — too old for `go.mod` 1.25.11 | **1.25.11 installed at `/usr/local/go1.25`** (apt untouched) |
| Workers | none deployed | **9 / 9 running with heartbeats** |
| `worker-rcon` | n/a | **`Up`, "worker-rcon ready"** — fixed by publishing postgres/redis on host loopback |
| `host.docker_prune` | `502` (critical) | **`200`** (healthy) |
| `/ready` | (bridge check failing) | **`{"status":"ok","checks":{"postgres":"ok","redis":"ok","bridge":"ok"}}`** |
| `scripts/verify-bridge.sh` | n/a | bridge responds to RPC (container_inspect returns JSON) |
| Squad images (`squad-server`, `depot-init`, `rnsquadjs`) | absent | **built locally on host** |
| Failed server `019f35dc` | failed install | still in DB (optional cleanup — see §8) |

The port-publish fix (`127.0.0.1:5432:5432` / `127.0.0.1:6379:6379`) was copied to the host and
`postgres`/`redis` recreated (named volumes preserved, no data loss); `worker-rcon` then started
cleanly and `worker:heartbeat:rcon` appeared in Redis.

---

## 8. Remaining work

The panel is functional; the items below are cleanup / hardening, not blockers.

1. **(Optional) Clean up the failed server `019f35dc`** (`server-1-bss`): either delete it from the
   panel — which stops the `worker-config-sync` `Admins.cfg` `file_read` log noise — or re-run the
   install now that the bridge exists (the original install only failed because the bridge was
   absent). Left in place pending operator decision (it is the operator's data).
2. **Make the deploy reproducible** so this can't regress: `scripts/deploy-tk104.sh` should run
   `scripts/install-host-bridge.sh` (idempotent) before `docker compose up`, and `compose.tk104.yml`
   should stay in sync with `docker-compose.yml`'s worker/bridge topology. The compose changes are in
   panel **PR #201 / branch `feature/tk104-full-stack`**; merging that makes the full-stack compose
   the committed source of truth. Note the host app dir is not a git repo (§4.4), so redeploys copy
   the file in rather than `git pull`.

### Fix applied (for the record)

1. Installed Go 1.25.11 to `/usr/local/go1.25` (apt's 1.22 is too old for `apps/bridge/go.mod`).
2. Built `panel-host-bridge` and ran `scripts/install-host-bridge.sh` (bridge daemon + socket +
   `panel` group + data tree + `squad-depot` volume).
3. Copied the full-stack `compose.tk104.yml` to the host, set `PANEL_GID=986` / `DATA_DIR` in
   `.env.tk104`, built the `images`-profile images, and `up -d` the full stack.
4. Published `postgres`/`redis` on the host loopback and recreated them so `worker-rcon`
   (`network_mode: host`) could connect.
5. Verified: `/ready` → all `ok` (incl. `bridge:ok`), 9/9 worker heartbeats, `host.docker_prune` →
   `200`, `verify-bridge.sh` bridge RPC responding.

---

## 9. One-paragraph answer

The Squad Admin Panel "doesn't work" on tk104 because it was deployed with a **web-only compose
file** that omitted the `panel-host-bridge` daemon and every background worker. The bridge is the
single privileged component that performs all host operations (install servers, RCON, host metrics,
docker prune, config sync) via `/run/panel-host-bridge/bridge.sock`; with the daemon never installed,
that socket didn't exist and **every** host action failed with
`connect ENOENT /run/panel-host-bridge/bridge.sock` — which the dashboard surfaces as "bridge
disconnected", dead workers, a failed server install, missing host metrics, and a stream of
"critical" docker-prune alerts. Installing the bridge (`scripts/install-host-bridge.sh`) plus the
full worker fleet fixes it; the panel's own audit log proves it, showing the first successful
(`200`) docker prune the moment the bridge came online.
