# Squad Server Experiment Report

**Date:** 2026-04-23
**Host:** Ubuntu 24.04.4 LTS, kernel 6.8.0-110-generic, 10 cores, 11 GiB RAM, 226 GB disk free
**SteamCMD version:** 1773426366 (Steam Console Client)
**Squad dedicated server version tested:** v10.3.1.576590 (UE 5.5.4-576590+//Squad/v10.3.1 1013 0) linux depot
**Branch:** `public`, manifest `gid=2508294661980328343`
**Install time:** ~2 min 26 s for download + verify
**Download size:** 11.26 GiB on-wire / 11.82 GiB on-disk

## Key findings

### 1. Config files lifecycle (TZ §17.6 correction)

Configs are **created by SteamCMD**, not by first boot. Immediately after `app_update 403240 validate`, `SquadGame/ServerConfig/` contains all 19 default `.cfg` files. The "bootstrap-boot → read configs → patch → register systemd" dance specified in TZ §17.6 is unnecessary. Install flow simplifies to:

```
apt_install(deps)
steamcmd_run(+@sSteamCmdForcePlatformType linux +force_install_dir ... +app_update 403240 validate +quit)
patch Rcon.cfg (Password=...), patch Server.cfg (ServerName=..., MaxPlayers=...)
write systemd unit + env + daemon-reload + enable
ufw_rule add for game/query/beacon ports
```

Full list of configs with sizes in [`01-install.md`](01-install.md).

### 2. Squad directory structure (actual after install + first boot)

```
server/
├── Engine/                    # UE5 engine (~300 MB)
├── SquadGame/
│   ├── Binaries/Linux/        # SquadGameServer binary (268 MB) + boost libs + EOS SDK
│   ├── Content/               # Game content
│   ├── Plugins/
│   ├── ServerConfig/          # 19 .cfg files shipped with depot
│   └── Saved/                 # created by first boot
│       ├── .bazaar            # EOS SDK marker
│       ├── Config/CrashReportClient/
│       ├── Logs/SquadGame.log # primary log file
│       └── PersistentDownloadDir/
├── SquadGameServer.sh         # launcher
├── installscript.vdf          # Valve install script (unused)
├── Manifest_*_Linux.txt       # 3 manifests
├── linux64/steamclient.so
├── steamapps/appmanifest_403240.acf
└── libsteamwebrtc.so
```

### 3. Log patterns — actual vs PDD Appendix A

| Pattern | PDD Appendix A | Actual | Verdict |
|---|---|---|---|
| `server.ready` | `LogInit: Engine is initialized` | `[t][c]LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()` | 🔧 Matches as substring. But this fires ~17 s **before** the beacon port is open. Prefer `Log(Net): Created socket for bind address: 0\.0\.0\.0:<beacon_port>` as the real ready signal. |
| `match.started` | `LogGameMode: Match State Changed from \S+ to InProgress` | `Log(?:GameMode\|GameState): (?:Display: )?Match State Changed from <x> to <y>` | 🔧 Squad logs both categories; dedupe by from/to. |
| `match.ended` | `LogGameMode: Match State Changed from InProgress to WaitingPostMatch` | same as above with `to=WaitingPostMatch` | 🔧 |
| `player.connected` | `LogNet: Join succeeded` + `LogEOS: [EOS Connection]` correlation | **Not captured** — no real client available in isolated VM. EOS category is `LogRedpointEOS:` not `LogEOS:`. | 📝 Mark for live-client capture during §17.8 verification; commit fixture at that point. |
| `player.disconnected` | `LogNet: UChannel::Close: ...UniqueId: (EOS:\|STEAM:)?<sid>` | Not captured — same reason. | 📝 Same as above. |

**New events to capture (not in PDD)**:

- `rcon.admin_command`: `LogSquad: ADMIN COMMAND: <summary> from RCON` — every RCON admin action echoes here → free audit tamper detection.
- `server.exiting`: `LogExit: Exiting.`
- `server.exit_code`: `LogCore: FUnixPlatformMisc::RequestExit(bForce=<bool>, ReturnCode=<int>)` — 143 = clean SIGTERM.

**Benign noise to filter out** (~1500 lines per cold boot):

```
LogStreaming: (Error|Warning): .+ EngineFailedStartAudio|PropellerMistEffectsAudio|SQCenterOfMassWaterFX
LogSquad: Error: Failed to spawn EquipableItem
LogRedpointEOS: Verbose: .+
```

Details in [`05-log-patterns.md`](05-log-patterns.md).

### 4. RCON protocol findings (§0A.4)

Squad implements **standard Valve Source RCON** over TCP. Wire format verified via tcpdump + Python reference implementation.

- Auth flow: server responds with two packets — empty `SERVERDATA_RESPONSE_VALUE` (id=1 type=0) then `SERVERDATA_AUTH_RESPONSE` (id=1 type=2). Success = id matches request; failure = id is −1.
- Multi-packet responses: use the empty-ping trick per Valve wiki.
- `SecondsBeforeTimeoutCheck=120` → our 90 s keepalive is safe.
- `MaxConnections=5` → default room for panel + ops tools.

**Huge finding**: `ShowServerInfo` returns JSON:

```json
{"MaxPlayers":20,"GameMode_s":"AAS","MapName_s":"AlBasrah_AAS_v1",
 "GameVersion_s":"v10.3.1.576590.1719","PlayerCount_I":"0",
 "ServerName_s":"Squad Dedicated Server","TeamOne_s":"USMC_LO_CombinedArms",
 "TeamTwo_s":"MEI_LO_CombinedArms","BeaconPort_I":"15000","Password_b":false, ...}
```

Panel's health card uses `ShowServerInfo` + `ListPlayers` for all metadata. No A2S needed.

`mcrcon` does **not** work against Squad — auth succeeds but response is swallowed. Panel ships its own hand-rolled TS RCON client under `apps/workers/rcon/`.

Full command inventory (88 commands verified): [`04-rcon.md`](04-rcon.md).

### 5. Launch arguments — required vs optional

| Arg | Required? | Default if omitted | Notes |
|---|---|---|---|
| `Port=<n>` | No | 7777 | Squad default, not TZ's 7787 |
| `QueryPort=<n>` | No | 27015 | Squad default |
| `BeaconPort=<n>` | No | 15000 | Squad default |
| `FIXEDMAXPLAYERS=<n>` | No | from Server.cfg | |
| `FIXEDMAXTICKRATE=<n>` | No | from Server.cfg | |
| `MULTIHOME=<ip>` | No | 0.0.0.0 | |
| `RANDOM=ALWAYS` | No | — | skips first-run prompt; harmless to leave |
| `-log` | No | — | routes engine logs to stdout + file (file only otherwise) |

None mandatory. All config can live in the `.cfg` files. Details: [`06-launch-args.md`](06-launch-args.md).

### 6. systemd integration

Final hardened unit passes `systemd-analyze security` with score **1.3 OK** (TZ target < 3.0).

- `MemoryDenyWriteExecute=yes` — compatible (UE5 does not JIT; `libboost_*.so` and EOS SDK are file-backed PROT_EXEC).
- `SystemCallFilter=@system-service ~@debug @mount @swap @reboot @obsolete @cpu-emulation @raw-io @privileged` — Squad boots + plays + stops cleanly.
- `CapabilityBoundingSet=` empty — no caps needed since all ports ≥ 1024.
- `PrivateUsers=yes`, `ProtectProc=invisible`, `ProcSubset=pid`, `RestrictAddressFamilies=AF_INET AF_INET6`.
- Stop timings: graceful SIGTERM on booted server = **~16 s**; `TimeoutStopSec=60s` has 3–4× headroom.
- Crash recovery (SIGKILL): systemd relaunches within **12 s** (`RestartSec=10s` + 2 s scheduling).
- Exit code 143 after SIGTERM. "Exiting abnormally" wording in Squad's exit log is misleading — it's clean.

Details: [`07-systemd.md`](07-systemd.md).

### 7. Steam Server Browser discovery

A2S (Source Query Protocol) on Squad's QueryPort is effectively **dead**: server receives the query packets but never responds. Squad v10.x uses EOS Session + Steam backend for discovery, not A2S. Panel should not rely on A2S for liveness — use RCON `ShowServerInfo` + systemd state instead.

Public discovery visibility check is a manual, deploy-time validation that requires an internet-reachable host with `ShouldAdvertise=true`; it cannot be exercised inside the isolated experiment VM.

Details: [`08-discovery.md`](08-discovery.md).

### 8. Deviations from PDD / TZ assumptions

| TZ/PDD assumption | Reality | Action |
|---|---|---|
| Squad download is ~95 GB | 12 GB (linux depot) | Update §1.E.1, §17.6, §1C/UC-01 install-time budget (was 45 min, now 8–10 min on typical link). |
| Configs created on first boot | Shipped with depot; no bootstrap boot needed | Update §17.6 acceptance. Remove "initial boot → wait for ready → stop" step from install flow. |
| A2S query works | Squad v10 does not respond to A2S | Remove A2S from §11.1 discovery. No `python-a2s` dep. `Server ready for connections` marker is beacon-port bind, not A2S. |
| PDD regex `LogInit: Engine is initialized` | Full line: `LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()` | Regex works as substring, but this marker fires 17 s before actual ready state; prefer beacon-port bind. |
| PDD regex `LogGameMode: Match State Changed` | Squad logs both `LogGameMode:` and `LogGameState:` | Update §9 regex to accept either + dedupe. |
| PDD assumes `LogEOS:` category for EOS connect | Actual category is `LogRedpointEOS:` (Redpoint Games SDK) | Update §9 regex when real-player capture happens in §17.8 verification. |
| CRLF line endings in Squad configs | Confirmed; panel's `file_atomic_write` must preserve them | Add to `bridge/internal/fsx` behaviour. |
| `SIGINT` for graceful shutdown | Squad ignores SIGINT; use SIGTERM (systemd default) | No template change needed (systemd already SIGTERM); remove any "use Ctrl+C" instructions from ops docs. |
| `mcrcon` works against Squad | Silent failure | Don't depend on `mcrcon`; panel ships own RCON client. |
| Default ports 7787/27165 | Squad defaults are 7777/27015 | §11.1 wizard should "auto-suggest next free from 7787" as panel convention, not "Squad default". |

### 9. Updates applied to TZ / PDD

All changes to source docs deferred to §0A.10 commit (`docs: update PDD/TZ per experiment findings`). PDD Appendix A updates the patterns above; TZ §11.1/§17.6/§17.7/§8 take the corrections.

### 10. Ready to proceed?

- [x] All 8 experimental steps performed on Ubuntu 24.04 with Squad v10.3.1.
- [x] All findings documented across `00-setup.md` through `08-discovery.md` plus this report.
- [x] `configs-default/` contains every default `.cfg` as-shipped.
- [x] Squad installs, boots (~25 s to ready), answers RCON, logs to file, rotates log on restart, stops cleanly on SIGTERM in ~16 s.
- [x] Hardened systemd unit verified: security score 1.3 OK; crash recovery 12 s.
- [x] 9 concrete TZ / PDD corrections identified and ready for §0A.10 commit.
- [x] Two items (`player.connected`, `player.disconnected` regex) deferred to §17.8 live-client verification because no external Squad client available in the experiment environment; fixtures will be captured then and committed.

**Signed off to start main implementation.**
