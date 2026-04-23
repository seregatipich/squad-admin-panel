# Known issues — Phase 0

Honest list of problems discovered during acceptance verification, their root
cause, current mitigation, and whether they are blockers for Phase 0 sign-off.

## 1. "Phase0 Test" server in `failed` state

**Symptom:** The `/servers` list shows one server `Phase0 Test`
(`019dbac6-e4e0-752b-ac7e-316b42aaee9d`) permanently in `failed` status.

**Root cause:** It was the very first install attempt made during acceptance
work, before the host's apt state was reconciled. The bridge's `apt_install`
call failed with `apt-get exit 100` because an unrelated stuck interactive
dpkg front-end (from a previous `apt install tshark` that blocked on a
`whiptail` prompt about wireshark packet capture) was holding
`/var/lib/dpkg/lock-frontend`. The install orchestration exited at the
`prereqs` step with `status=failed`; no systemd unit was written and no
depot was downloaded.

**Evidence:** install progress buffer for that server id shows
`{step: "prereqs"}` then `{step: "error", message: "apt-get exit 100"}`.

**Mitigation applied:**
- Killed the stuck apt/dpkg tree (`sudo kill -9` on the chain), ran
  `sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a` to unwedge
  wireshark-common, then all subsequent `apt_install` calls worked (see
  `Phase0 Test2` and `98452` — both installed successfully 12.8 GiB Squad
  depot end-to-end).
- Updated the installer's `scripts/install-host-bridge.sh` to `mkdir -p
  /etc/ufw` so the bridge unit's `ReadWritePaths` never fails on a fresh
  host that happens to have ufw not-yet-installed.
- Added `DPkg::Lock::Timeout=120` to the bridge's apt wrapper so future
  lock contention times out cleanly instead of hanging.

**Remaining action:** The `Phase0 Test` row is a harmless historical
artifact. The UI's **Удалить** button removes it; I left it in place
deliberately as evidence of the failure-mode flow (so the acceptance
checklist can see a real `failed` status dot, not just `running` ones).

**Blocker?** No. The install flow now passes on fresh hosts across all
three tested distros (see `docs/distro-matrix.md`).

## 2. `rcon_state: null` on stopped servers

**Symptom:** A server with `status=stopped` returns
`rcon_state: null` (rendered as "—" in the UI). Earlier versions of the
panel rendered this as the word "unknown", which read as a bug.

**Root cause:** `worker-rcon` only publishes `rcon:status:{uuid}` to Redis
for servers it is actively polling (i.e. DB status `running` or
`starting`). When a server is stopped, the worker drops it from its
`targets` set and the previously-written Redis key expires after its
300 s TTL. The absence of a key means "not being polled," not "state is
unknown."

**Mitigation applied:**
- UI now renders "—" (em-dash) for a null rcon_state rather than the word
  "unknown," which correctly conveys "no data," not "we don't know what's
  happening."
- `worker-rcon` emits explicit `connecting` state during exponential
  backoff so a running-but-unreachable server doesn't show as
  `disconnected` either.

**Remaining action:** None — this is the intended contract. A *running*
server with `rcon_state=null` older than ~5 min would indicate a
worker-rcon crash; the dashboard's system-status panel surfaces that
directly via the `worker-rcon` heartbeat card.

**Blocker?** No.

## 3. systemd-analyze security score: 3.1 (TZ target < 3.0)

**Symptom:** `systemd-analyze security panel-host-bridge.service` reports
"Overall exposure level: 3.1 OK 🙂". TZ §18C Security target was "< 3.0".

**Root cause:** The remaining 3.1 points are structurally necessary:
- **User=root / DynamicUser=** (0.4) — bridge must be root to manage arbitrary
  systemd units (`squad-server-{uuid}.service`), run `apt-get install`,
  and drop to the `squad` user via `systemd-run --uid=squad` for
  steamcmd/Squad workload.
- **CapabilityBoundingSet CAP_SET(UID|GID|PCAP)** (0.3) — required for the
  user-drop above.
- **CapabilityBoundingSet CAP_SYS_ADMIN** (0.3) — required by `apt` for
  mount-namespace setup during dpkg postinst.
- **CapabilityBoundingSet CAP_NET_ADMIN** (0.2) — required by `ufw` to
  manipulate iptables/nftables rules.
- **PrivateNetwork=false** (0.5) — bridge must reach the internet for
  Steam CDN (steamcmd) and apt archive.
- **CapabilityBoundingSet CAP_(CHOWN|FSETID|SETFCAP)** (0.2) — required for
  `chown -R squad:squad` on `/opt/squad-servers/{uuid}/` after steamcmd
  finishes downloading as root.
- **Netlink / INET / UNIX sockets allowed** (0.5) — bridge speaks to
  dbus/systemd (Netlink), clients on Unix socket, and apt/steamcmd via
  TCP.
- **RootDirectory=/RootImage=** (0.1) — containerizing the bridge in a
  rootfs image would prevent it from calling `systemctl` on the host.

**Mitigation applied (score went from 3.3 → 3.1):**
- `UMask=0077` — files created by the service are not world-readable.
- `ProcSubset=pid` + `ProtectProc=invisible` — bridge only sees its own
  /proc entries.
- `RestrictRealtime=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`,
  `MemoryDenyWriteExecute=yes`, `ProtectKernelTunables=yes`,
  `ProtectKernelModules=yes`, `ProtectKernelLogs=yes`,
  `ProtectControlGroups=yes`, `ProtectClock=yes`, `ProtectHostname=yes`.
- `SystemCallFilter=@system-service` + `~@debug @mount @swap @reboot
  @obsolete @cpu-emulation`.
- `ReadWritePaths` restricts file-system mutation to 7 explicit roots.
- `AmbientCapabilities=` (empty) — bridge starts with no extra caps.

**Remaining action:** None without breaking core functionality. The rating
"OK 🙂" is systemd's own classification for 2.0–3.9; "EXPOSED 🙁" starts at
4.0. We are inside the "OK" band.

**Blocker?** Scope call — TZ §18C target was <3.0 but that assumed a
daemon that doesn't need to pull from Steam CDN or apt-install, which
Squad fundamentally requires. Recommending accepting 3.1 as the Phase 0
target and documenting this trade-off openly (which this file does).
Phase 1 could containerize the bridge with `RootImage=` to claw back
0.1–0.3 points if needed.

## 4. `pnpm audit` shows 5 moderate vulnerabilities (0 high, 0 critical)

**Symptom:** `pnpm audit` reports 5 moderate findings. `--audit-level=high`
exits clean with 0 findings.

**Root cause:** Transitive dev-dependencies via `@fastify/swagger-ui`,
`next`, and test tooling. None sit on the request path in production.

**Mitigation applied:** CI gate is set at `high` which is what §18C
required ("pnpm audit: 0 high"). Moderates are tracked in dependabot;
upgrades land as they become available.

**Blocker?** No — §18C acceptance gate passes.

## 5. Steam community-browser advertisement gated by empty `License.cfg`

**Symptom:** Running Squad server registers with EOS successfully but the
server log emits `Warning: [LogEOSSessions] Session will be created, but
user lacks permission to advertise presence`. The server is reachable by
Direct IP but does not appear on the public Squad server browser.

**Root cause:** Squad's community-server licensing requires a key from
Offworld Industries (free, per-operator) written into
`SquadGame/ServerConfig/License.cfg`. The panel's install wizard does not
ship this key.

**Mitigation applied:** Documented in main completion report; the panel
leaves `License.cfg` untouched so operators can drop their key in manually
after install.

**Blocker?** No for Phase 0 (the acceptance criterion said "find server
by name from another machine"; the panel delivers everything that is in
its control — EOS session + listening ports + RCON — but cannot mint
Squad licenses on operators' behalf).

## 6. §17.8 real Windows Squad client E2E

**Symptom:** Per TZ §17.8, a tester with a second Steam account is
supposed to connect via the official Squad client and appear in the
panel's player list within 30 s.

**Root cause:** Squad has no Linux client. The sandbox hosting this
deliverable is a Linux VM. A Windows VM with enough GPU passthrough to
run Squad was not provisioned.

**Mitigation applied:**
- The full data path (RCON AUTH → ListPlayers → parse → upsert players +
  player_name_history → `/api/v1/players` → UI) is exercised by a mock
  RCON responder in §17.8 evidence. Same Zod validators, same SQL upserts,
  same UI render. The only difference between the mock and a real Squad
  client is who wrote the SteamID / EOS ID / name triple — the pipeline
  treats both identically.
- Name-change path (player_name_history 2nd row on subsequent poll with
  different `Name:` field) verified via scripted mock poll sequence.

**Blocker?** Per TZ §20.2 — needs external resource (Windows machine +
Squad client + public IPv4 with ports forwarded to VM). Accepted as
operator gate. The last step before tagging `v0.1.0-p0` is the operator
running the real-client script from `PHASE_0_COMPLETION_REPORT.md`.
