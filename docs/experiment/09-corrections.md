# §0A.10 — Corrections to TZ / PDD Appendix A per experiment findings

This is the formal delta between the Phase 0 TZ / PDD as written and the Squad v10.3.1 reality observed in §0A.1–§0A.8. All subsequent implementation follows the corrected versions below; the original TZ / PDD statements are kept in the user-provided brief for historical context.

## C-1. Squad dedicated server depot size (TZ §1.E.1, §17.6, §1C/UC-01)

- **Old:** "~95 GB SteamCMD depot; 30–60 min download on 200 Mbps"
- **New:** Linux depot = 11.26 GiB on the wire, 11.82 GiB on disk. On the measurement VM (85 MB/s to Steam CDN edge), install completes in **~2:30**.
- **Install-time budget:** step 13 in TZ §1C/UC-01 drops from "30–60 min" to "~5–10 min on a typical residential fiber link; sub-3-min on datacenter fiber".

## C-2. `SquadGame/ServerConfig/*.cfg` is created by the depot, not by first boot (TZ §17.6)

- **Old:** "Squad create `SquadGame/ServerConfig/*.cfg` только при первом запуске сервера". Install flow required a bootstrap boot.
- **New:** All 19 default configs ship with the depot itself. **No bootstrap boot.** Install flow becomes:

```
apt_install(<deps>)
steamcmd_run(+@sSteamCmdForcePlatformType linux
             +force_install_dir /opt/squad-servers/{uuid}
             +login anonymous
             +app_update 403240 validate
             +quit)
file_atomic_write ServerConfig/Rcon.cfg    # Password=<generated 32-char>
file_atomic_write ServerConfig/Server.cfg  # ServerName=<user>, MaxPlayers=<user>, any other whitelisted keys
systemctl_write_unit squad-server-{uuid}.service
systemctl_daemon_reload
systemctl enable squad-server-{uuid}
ufw_rule add game_port query_port beacon_port
```

Acceptance §17.6 should stop asserting "post-bootstrap-boot" config generation, and should assert that depot-shipped configs are left untouched except for RCON password and server name.

## C-3. Squad v10.x does not respond to A2S / Source Query Protocol (TZ §11.1, §17.7)

- **Old:** TZ §11.1 implies A2S as a liveness signal; §17.7 verification has an A2S query step.
- **New:** Server binds UDP on `QueryPort` but never replies. Squad publishes via EOS sessions + Steam's backend directly. The panel's liveness signal is RCON `ShowServerInfo` (JSON) + `systemctl is-active` + `process_info`.
- **Action:**
  - Drop A2S from `worker-rcon`'s health loop.
  - §17.7 "server appears in Steam Server Browser" stays as a manual deploy-time check with screenshot evidence; it is *not* a CI/automated gate.

## C-4. Log pattern corrections (PDD Appendix A, TZ §9)

- **`server.ready`**
  - PDD regex `LogInit: Engine is initialized` matches as substring but fires ~17 s before the server can actually accept connections. Use `LogNet: Created socket for bind address: 0\.0\.0\.0:<beacon_port>` where `<beacon_port>` equals the configured beacon port (default 15000). Emit **one** `server.ready` event per boot.

- **`match.started` / `match.ended`**
  - Squad logs every match-state transition under **both** `LogGameMode:` and `LogGameState:`. Regex:

    ```regex
    ^Log(?:GameMode|GameState): (?:Display: )?Match State Changed from (?<from>\S+) to (?<to>\S+)$
    ```

  - worker-log-ingest deduplicates pairs with a 250 ms window.

- **`player.connected` / `player.disconnected`**
  - PDD assumes `LogEOS:` category. Actual v10 category is `LogRedpointEOS:` (RedpointGames EOS SDK). Finalised regex **deferred** to §17.8 live-client capture (no Squad client in the experiment environment). Code under `apps/workers/log-ingest/src/parser/` uses a placeholder with a TODO marker keyed to §17.8; the verification phase captures real log lines, commits them as fixtures under `apps/workers/log-ingest/test/fixtures/`, and tightens the regex.

- **New: `rcon.admin_command`**
  - Every RCON admin call echoes `LogSquad: ADMIN COMMAND: <summary> from RCON` in the log. Worker emits this as an event; cross-checking against the panel's own audit trail yields free tamper detection.

- **New: `server.exiting` / `server.exit_code`**
  - `LogExit: Exiting.` followed by `LogCore: FUnixPlatformMisc::RequestExit(bForce=<bool>, ReturnCode=<int>)`. Exit 143 = clean SIGTERM (treat as normal stop). Any other code → `server.crashed`.

- **Filter out (benign noise, ~1500 lines per boot)**:

  ```regex
  LogStreaming: (?:Error|Warning): CreateExport: .+ (?:EngineFailedStartAudio|PropellerMistEffectsAudio|SQCenterOfMassWaterFX)
  LogSquad: Error: Failed to spawn EquipableItem
  LogRedpointEOS: Verbose: .+
  ```

## C-5. Config file line endings (new, not in TZ)

Squad ships configs with **CRLF** line endings (all 19 except occasionally `Rcon.cfg` after our edits). `bridge/internal/fsx.atomic_write` preserves whatever line endings exist in the original file and defaults to CRLF when writing new Squad config files. Tests cover both cases.

## C-6. `SIGINT` is not a graceful signal for Squad (new)

Squad ignores SIGINT. systemd's default `KillSignal=SIGTERM` is correct; no override needed. Ops docs / troubleshooting should not recommend "Ctrl+C" as a stop method.

## C-7. Default port assumptions (TZ §11.1)

Squad's own defaults are `Port=7777`, `QueryPort=27015`, `BeaconPort=15000`, `Rcon.cfg Port=21114`. The TZ's "7787 / 27165" is a **panel convention** to avoid colliding with anyone manually running Squad on the standard UE port. The wizard should scan for the lowest free triplet starting from `7787/27165/15000` and note this convention in the docs.

## C-8. `mcrcon` incompatible; panel ships its own RCON client (new)

`mcrcon 0.7.2` authenticates against Squad but its multi-packet termination heuristic swallows the response body. Panel must not shell out to `mcrcon`; `worker-rcon` uses a hand-rolled TS `net.createConnection` client implementing the Valve Source RCON Protocol spec verbatim (including the empty-ping trick).

## C-9. SteamCMD invocation ordering (TZ §2.1 / §7.4)

`+@sSteamCmdForcePlatformType linux` **must** appear **before** `+login anonymous`, otherwise `app_update 403240` fails with `Failed to install app '403240' (Missing configuration)`. TZ §2.1 whitelists the flag correctly but doesn't stress the ordering. Bridge validator in `bridge/internal/validate/steamcmd.go` enforces "`@sSteamCmdForcePlatformType` before `login`" as a structural rule.

## Commit plan

After skeleton / code foundation exists, a docs-only commit lands these corrections inside `docs/experiment/corrections.md` (this file) and, where appropriate, updates the public PDD / TZ excerpts under `docs/`. Implementation code that post-dates this commit follows the corrected specification only.
