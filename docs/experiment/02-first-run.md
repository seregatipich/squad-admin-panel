# §0A.2 — First run of Squad dedicated server

**Squad build observed:** v10.3.1.576590 (UE 5.5.4-576590)
**Run:** 2026-04-23T11:24:26Z → 11:27:27Z (first cold boot, ~2 min total uptime)
**Command:** `./SquadGameServer.sh Port=7787 QueryPort=27165 BeaconPort=15000 FIXEDMAXPLAYERS=20 RANDOM=ALWAYS -log`
**stdout log:** `/home/squad/squad-experiment/first-run.log` (1.14 MB)
**Native file log:** `SquadGame/Saved/Logs/SquadGame.log` (1.15 MB; ends with `LogExit: Exiting. … ReturnCode=143 … Log file closed`)

## Time-to-ready

| Event | Elapsed from binary exec | Log tick |
|---|---:|---|
| Process spawned | 0 s | — |
| `LogNet: Created socket for bind address: 0.0.0.0:7787` | ~7 s | tick 0 |
| `LogGameState: Match State Changed from EnteringMap to WaitingToStart` | ~7 s | tick 0 |
| `LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()` | ~7 s | tick 0 |
| `LogNet: Created socket for bind address: 0.0.0.0:15000` (beacon) | ~24 s | tick ~749 |
| Server visible to A2S queries | ~24–30 s | — |

**Operational definition of "ready":** beacon port (15000) listening. At that point Steam Server Browser queries return real data. Before that point the engine is still loading async assets and hosting would fail.

TZ §1.E.1 predicted 30–60 s; actual first cold boot is ~24–30 s. No shader-compile stall observed; Squad ships pre-compiled shaders.

## Files Squad creates on first boot

The runtime state directory `SquadGame/Saved/` appears only after first boot. Contents after a single boot + shutdown:

```
SquadGame/Saved/
├── .bazaar                               # EOS SDK marker (27 bytes)
├── Config/
│   └── CrashReportClient/
│       └── UECC-Linux-<uuid>/CrashReportClient.ini
├── Logs/
│   └── SquadGame.log                     # primary log file
└── PersistentDownloadDir/                # empty
```

## **Critical finding: `SquadGame/ServerConfig/*.cfg` was NOT created on first boot**

Counter to TZ §17.6, nothing new appears in `SquadGame/ServerConfig/` after first boot. All 19 configs already existed after `app_update 403240` (documented in `01-install.md`). First boot adds only `Saved/` (runtime state), never touches `ServerConfig/`.

## Second finding: Squad config files use **CRLF line endings**

All default configs except `Rcon.cfg` (observed LF-only after my `sed` on an earlier run) ship with CRLF. The panel's `file_atomic_write` should preserve whatever line endings are in the file or default to CRLF for Squad-created files (matches upstream style and does not confuse anyone who opens them in Notepad on Windows build machines).

## Audio-related `LogStreaming Error: CreateExport ... EngineFailedStartAudio`

The Linux build emits hundreds of these errors while loading vehicles (`BP_RHIB_*`, `BP_UH1Y`, etc.). They are benign — the dedicated server has no audio output, so the audio-component exports are skipped. **These lines should be filtered out in worker-log-ingest** or they drown useful events. Match pattern to drop:

```
LogStreaming: (Error|Warning): .+ (EngineFailedStartAudio|PropellerMistEffectsAudio|SQCenterOfMassWaterFX)
```

## Ready-state markers we use

- `LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()` → first useful marker (~7 s into boot)
- `LogNet: Created socket for bind address: 0.0.0.0:15000` → server is genuinely accepting connections (~24 s)
- `LogGameState: Match State Changed from EnteringMap to WaitingToStart` → game logic is up

worker-log-ingest publishes `server.ready` when the beacon-port bind line is observed, not on `Engine is initialized` alone (the engine init happens ~17 s before the server is actually reachable).
