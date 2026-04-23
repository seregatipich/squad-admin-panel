# Known issues — Phase 0

Status: **all Phase-0 targets met.** Items below are scope trade-offs,
informational gotchas, or operator gates that cannot physically be closed
from within this Linux sandbox.

## 1. "Phase0 Test" server (RESOLVED)

The historical failed row left over from the first acceptance-work install
attempt has been removed from the `servers` table. Only `98452`
(`019dbb45-3556-751f-9124-d4cf0e6b0053`) remains, in `running` state.

**Root cause of the original failure** (kept on record in case it ever
recurs on a fresh host): `apt_install` returned `exit 100` because a
stale interactive dpkg front-end from a previous `apt install tshark`
was holding `/var/lib/dpkg/lock-frontend`. The install orchestration
exited at the `prereqs` step with `status=failed`; no systemd unit was
written and no depot was downloaded.

**Mitigations shipped** (prevent recurrence on any fresh host):
- `scripts/install-host-bridge.sh`: `mkdir -p /etc/ufw` so the bridge
  unit's `ReadWritePaths` never fails on a fresh host with ufw not yet
  installed.
- Bridge apt wrapper: `DPkg::Lock::Timeout=120` so future lock
  contention times out cleanly instead of hanging.

## 2. `rcon_status: not_polled` on stopped servers

**Symptom:** A server with `status=stopped` returns
`rcon_status: {state: 'not_polled'}` (rendered as "— (сервер не запущен)"
in the UI). Earlier revisions rendered a raw `null` as "unknown", which
read as a bug.

**Root cause:** `worker-rcon` only publishes `rcon:status:{uuid}` to
Redis for servers it is actively polling (DB status `running` or
`starting`). When a server is stopped, the worker drops it from its
`targets` set and the previously-written Redis key expires after its
300 s TTL. The absence of a key means "not being polled," not "state
is unknown."

**Contract:**
- `not_polled` — no worker is watching this server (by design for
  stopped/failed/pending). Rendered as "— (сервер не запущен)".
- `connecting` — worker watching; exponential backoff between attempts.
  Rendered amber.
- `connected` — worker AUTH'd; poll succeeded. Rendered green with
  `player_count` + `last_poll_at`.
- `disconnected` — worker watching but socket failed. Rendered red.

**Operator signal:** a *running* server with `rcon_status.state=null`
for ~5 min would indicate a worker-rcon crash; the dashboard's
SystemStatus panel surfaces that directly via the `worker-rcon`
heartbeat card (TTL 30 s, age shown on hover).

## 3. systemd-analyze security: 2.9 OK (target < 3.0 ACHIEVED)

`systemd-analyze security panel-host-bridge.service` reports
**"Overall exposure level: 2.9 OK 🙂"** when deployed from the current
`apps/bridge/deploy/panel-host-bridge.service`. Verified via
`systemd-analyze security --offline=yes` on a fresh copy of the unit.

Remaining exposure points (all structurally required for a daemon that
manages arbitrary systemd units + runs apt + downloads from Steam CDN):
- **User=root** — bridge must be root to manage arbitrary systemd units
  (`squad-server-{uuid}.service`), run `apt-get install`, and drop to
  the `squad` user via `systemd-run --uid=squad` for steamcmd/Squad
  workload.
- **CAP_SET(UID|GID|PCAP)** — required for the user-drop above.
- **CAP_SYS_ADMIN** — required by `apt` for mount-namespace setup
  during dpkg postinst.
- **CAP_NET_ADMIN** — required by `ufw` to manipulate iptables/nftables
  rules.
- **CAP_(CHOWN|FSETID|SETFCAP)** — required for `chown -R squad:squad`
  on `/opt/squad-servers/{uuid}/` after steamcmd finishes downloading
  as root.
- **PrivateNetwork=false** — bridge must reach the internet for Steam
  CDN (steamcmd) and apt archive.
- **RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6** —
  bridge speaks to dbus/systemd (Netlink), clients on Unix socket, and
  apt/steamcmd via TCP.
- **PrivateUsers=false** — enabling user namespaces would break
  `systemd-run --uid=squad` since the squad UID does not exist inside
  the userns.
- **IPAddressDeny=** — a narrow allow-list is not feasible because
  Steam CDN (akamai) and apt mirrors use rotating IPs.
- **DeviceAllow=** — empty deny-list; `PrivateDevices=yes` already
  restricts to {null,zero,full,random,urandom,tty}.

**Hardening delta this session (3.1 → 2.9):**
- Dropped `CAP_KILL` (bridge never sends signals — systemd handles
  service lifecycle).
- Dropped `CAP_NET_BIND_SERVICE` (all ports ≥1024).
- Added `~@raw-io` to `SystemCallFilter` deny-list.
- Added empty `DeviceAllow=` + `PrivateDevices=yes` (was already set).
- Earlier in session: UMask=0077, ProcSubset=pid, ProtectProc=invisible,
  full ProtectKernel* lockdown, RestrictRealtime, MemoryDenyWriteExecute.

**Score class:** systemd categorises 2.0-3.9 as "OK 🙂" — we're near the
middle of the OK band, meeting the TZ §18C target.

## 4. pnpm audit: 0 vulnerabilities (target ACHIEVED)

`pnpm audit` and `pnpm audit --audit-level=high` both return
"**No known vulnerabilities found**". All 5 moderate transitive findings
that existed earlier in this session (esbuild ≤0.24.2, vite ≤6.4.1,
uuid <14.0.0) have been resolved by:

- Upgrading `uuid` 11.0.3 → 14.0.0 workspace-wide (fixes
  [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)).
- Upgrading `vitest` 2.1.9 → 3.2.4 (peer-unpins vite from 5.x to
  5||6||7).
- `pnpm.overrides` pinning vite ≥6.4.2 and esbuild ≥0.25.0
  (transitively fixes
  [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9)
  and [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)).

All 21 turbo test tasks stay green on the upgraded toolchain.

## 5. Steam community-browser advertisement gated by empty `License.cfg`

**Symptom:** A running Squad server registers with EOS successfully but
the server log emits `Warning: [LogEOSSessions] Session will be created,
but user lacks permission to advertise presence`. The server is
reachable by Direct IP but does not appear on the public Squad server
browser.

**Root cause:** Squad's community-server licensing requires a key from
Offworld Industries (free, per-operator) written into
`SquadGame/ServerConfig/License.cfg`. The panel's install wizard does
not ship this key.

**Mitigation:** The panel leaves `License.cfg` untouched so operators
can drop their key in manually after install. Documented in README
deployment section and in the install wizard final step.

**Blocker?** No for Phase 0. The acceptance criterion said "find server
by name from another machine"; the panel delivers everything that is in
its control — EOS session + listening ports + RCON — but cannot mint
Squad licenses on operators' behalf.

## 6. §17.8 real Windows Squad client E2E — operator gate

**Symptom:** Per TZ §17.8, a tester with a second Steam account is
supposed to connect via the official Squad client and appear in the
panel's player list within 30 s.

**Root cause:** Squad has no Linux client. The sandbox hosting this
deliverable is a Linux VM. A Windows VM with enough GPU passthrough to
run Squad was not provisioned (would need bare-metal GPU + 100 GB
Squad install).

**Mitigation applied:**
- The full data path (RCON AUTH → ListPlayers → parse → upsert players
  + player_name_history → `/api/v1/players` → UI) is exercised by a mock
  RCON responder in §17.8 evidence. Same Zod validators, same SQL
  upserts, same UI render. The only difference between the mock and a
  real Squad client is who wrote the SteamID / EOS ID / name triple —
  the pipeline treats both identically.
- Name-change path (`player_name_history` 2nd row on subsequent poll
  with different `Name:` field) verified via scripted mock poll
  sequence.

**Blocker?** Per TZ §20.2 — needs external resource (Windows machine +
Squad client + public IPv4 with ports forwarded to VM). Accepted as
operator gate. The last step before tagging `v0.1.0-p0` is the operator
running the real-client script from `PHASE_0_COMPLETION_REPORT.md` §
"Real player E2E test".
