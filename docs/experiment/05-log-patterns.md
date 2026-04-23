# §0A.5 — Log parsing reality check vs PDD Appendix A

## Log file layout

- **Native file**: `SquadGame/Saved/Logs/SquadGame.log` — this is what panel tails via `journalctl_follow` (when the server runs under systemd) or direct file tail (fallback). It opens with a UTF-8 BOM (`ef bb bf`) + a header line `Log file open, MM/DD/YY HH:MM:SS`.
- **stdout log** (when launched with `-log`): identical content minus the BOM/header, plus a few early `Shutdown handler: initialize` lines before Squad's own logging kicks in.

Both contain timestamps in the format `[YYYY.MM.DD-HH.MM.SS:mmm][<tick>]`. Tick is the engine tick counter; useful for relative ordering within a boot but not across restarts.

## Line format

```
[2026.04.23-11.30.20:507][  0]LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()
└──────── absolute time ──────┘└──┘└────────────┘└──────┘└────────────────────────────────────────┘
         bracketed prefix     tick category :  verbosity   message
```

Verbosity levels observed: `Display`, `Verbose`, `Warning`, `Error`. Most gameplay events use `Display`; diagnostics use `Verbose`. The verbosity prefix is present for most log categories but **not** `LogGameState` (observed: `LogGameState: Match State Changed from EnteringMap to WaitingToStart` has no `Display:`).

## Pattern-by-pattern verification against PDD Appendix A

Legend: ✅ matches as-is, 🔧 matches with a small regex tweak, 📝 partially — needs additional rules, ❌ incorrect assumption in PDD.

### 1. `server.ready`

- **PDD:** `LogInit: Engine is initialized`
- **Actual:** `[2026.04.23-11.30.20:507][  0]LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()`
- **Verdict:** 🔧 — substring match works; anchored regex must allow `LogInit: (?:Display: )?Engine is initialized`.
- **Caveat:** this fires ~17 s **before** the beacon port opens. If we emit `server.ready` on this line, the server still can't accept UDP connections.
- **Preferred pattern:** fire `server.ready` on `LogNet: Created socket for bind address: 0\.0\.0\.0:(?<port>\d+)` where `port` matches the configured `BeaconPort` (15000 default).

### 2. `match.started`

- **PDD:** `LogGameMode: Match State Changed from \S+ to InProgress`
- **Actual** (v10.3.1): Squad writes the message **twice** on every state change:
  ```
  LogGameMode: Display: Match State Changed from <x> to <y>
  LogGameState: Match State Changed from <x> to <y>
  ```
- **Verdict:** 🔧 — accept either category and optional `Display:` prefix. Updated regex:

  ```regex
  ^Log(?:GameMode|GameState): (?:Display: )?Match State Changed from (?<from>\S+) to (?<to>\S+)$
  ```

- Deduplication required: emit **one** event per transition (log-ingest correlates the two lines by a short window + same from/to).

### 3. `match.ended`

- **PDD:** `LogGameMode: Match State Changed from InProgress to WaitingPostMatch`
- **Actual:** same pattern as `match.started`, with `to = WaitingPostMatch`. Use the same composite regex and branch on `to`.

### 4. `player.connected` (join + EOS correlation)

PDD Appendix A builds `player.connected` from two adjacent log lines:

```
LogNet: Join succeeded: <name>
LogEOS: [EOS Connection] ... EOS:<eos> Steam:<sid>
```

**I could not generate this pair in the experiment** — there is no Squad client available on the host network to produce a real join. The v10.3 log does show `LogRedpointEOS: …` (not `LogEOS:`) for SDK traffic, so the EOS line category is almost certainly **different from what PDD assumes**.

**Action item for main implementation:** before writing the `player.connected` correlator, exercise it end-to-end against a real Squad client in the P0 verification phase (§18C front 10). Record the exact log lines and commit the confirmed regex + a fixture under `apps/workers/log-ingest/test/fixtures/player-connect.log`.

### 5. `player.disconnected`

- **PDD:** `LogNet: UChannel::Close: ...UniqueId: (?:EOS:<eos>\|STEAM:)?<sid>`
- Same status as #4 — needs live-client validation. Placeholder regex stays in the code, marked with a test that asserts against a real fixture once captured.

## New patterns worth ingesting

### Admin-command audit marker

```
LogSquad: ADMIN COMMAND: <summary> from (RCON|<source>)
```

Examples observed this session:

```
LogSquad: ADMIN COMMAND: Message broadcasted <TEST-SIGNAL-1234> from RCON
LogSquad: ADMIN COMMAND: Match ended from RCON
```

Worker-log-ingest emits `rcon.admin_command` so audit can cross-check that every admin command in the panel's own audit trail has a matching log entry (tamper detection in Phase 2).

### Benign noise to **drop** in the ingester

v10.3 emits ~1500 lines of these per cold boot; all benign:

```regex
LogStreaming: (?:Error|Warning): CreateExport: .+ EngineFailedStartAudio|PropellerMistEffectsAudio|SQCenterOfMassWaterFX
LogSquad: Error: Failed to spawn EquipableItem
LogRedpointEOS: Verbose: .+
```

The log-ingest worker filters these in a pre-ingest step so Redis Streams aren't flooded with non-events.

### Native exit marker

```
LogExit: Exiting.
LogCore: FUnixPlatformMisc::RequestExit\(bForce=(?<force>true|false), ReturnCode=(?<code>\d+)\)
```

Correlate with systemd's exit code to produce `server.stopped` vs `server.crashed`. Exit 143 = clean SIGTERM (panel stop or admin action). Exit 0 = same but via normal exit path. Any other code (11, 134, 137) = crash.

## Updated pattern table (to seed worker-log-ingest)

| Kind | Regex (Unicode, multiline off) | Source |
|---|---|---|
| `server.ready` | `^Log(?:Init: Display: Engine is initialized\. Leaving FEngineLoop::Init\(\)\|Net: Created socket for bind address: 0\.0\.0\.0:(?<beacon_port>15\d{3}))$` | derived |
| `match.state_changed` | `^Log(?:GameMode\|GameState): (?:Display: )?Match State Changed from (?<from>\S+) to (?<to>\S+)$` | derived |
| `rcon.admin_command` | `^LogSquad: ADMIN COMMAND: (?<summary>.+?) from (?<source>RCON\|\S+)$` | new |
| `server.exiting` | `^LogExit: Exiting\.$` | derived |
| `server.exit_code` | `^LogCore: FUnixPlatformMisc::RequestExit\(bForce=\S+, ReturnCode=(?<code>\d+)\)$` | new |
| `player.connected` (provisional, pending §17.8 live validation) | per PDD, flagged for recapture | PDD |
| `player.disconnected` (provisional) | per PDD, flagged for recapture | PDD |

## Summary for §0A.10 corrections

- Appendix A pattern #1 (`server.ready`): tweak regex to handle `Display:` verbosity prefix; prefer beacon-port-bind as the trigger.
- Appendix A patterns #2/#3 (`match.*`): accept both `LogGameMode:` and `LogGameState:`; dedupe.
- Appendix A patterns #4/#5 (`player.*`): recapture against a real client; commit fixture.
- Appendix A is missing: `rcon.admin_command`, `server.exiting`, `server.exit_code`. Add them.
- Appendix A should call out the ~1500-line audio-export noise so ingest authors filter it out.
