# §0A.3 — Shutdown and re-run timing

## Finding: **Squad does NOT respond to SIGINT**

During the first-run shutdown attempt, `kill -INT` was sent to the `SquadGameServer` PID. Over the next 60 s the process did not exit. Eventually a competing run-2 invocation started and both processes coexisted for ~1 min until a targeted `kill -TERM` on the binary PID reaped them.

**Conclusion:** panel and `squad-server-{uuid}.service` must use `SIGTERM`, not `SIGINT`. systemd's default `KillSignal=SIGTERM` is correct; no override needed.

## Finding: SIGTERM → clean exit in ~16 s

With Squad running a WaitingToStart match on AlBasrah_AAS_v1:

| Step | Time |
|---|---|
| `kill -TERM <pid>` | t = 0 |
| Last log line `LogExit: Exiting. … ReturnCode=143` | t + ~15.6 s |
| Process exits, ports released | t + ~16.0 s |

Exit trace from `run3.log` (full shutdown sequence):

```
[2026.04.23-11.36.27:293][366]LogPakFile: Destroying PakPlatformFile
[2026.04.23-11.36.27:300][366]LogExit: Exiting.
[2026.04.23-11.36.27:300][366]LogCore: FUnixPlatformMisc::RequestExit(bForce=false, ReturnCode=143)
Exiting abnormally (error code: 143)
Shutdown handler: cleanup.
```

ReturnCode 143 = 128 + 15 (SIGTERM). Squad's "Exiting abnormally" text is misleading — the shutdown is clean. systemd maps exit 143 to `status=143/n/a` which is treated as success; `Restart=on-failure` will not re-spawn.

## TZ §8 unit template review

- `TimeoutStopSec=60s` — safe (60 s >> 16 s observed)
- `KillSignal` — unset → defaults to SIGTERM → correct
- `Restart=on-failure` — will NOT restart after clean admin stop (exit 143 = clean), but WILL restart after segfault or OOM kill → correct

## Finding: Log file rotation on restart

When a new Squad process starts, it renames the previous `SquadGame/Saved/Logs/SquadGame.log` → `SquadGame-backup-YYYY.MM.DD-HH.MM.SS.log` and opens a fresh file. Evidence after run 2 started while run 1 was still alive:

```
SquadGame_2.log                                 # 1.08 MB — concurrent write; race against run 1
SquadGame-backup-2026.04.23-11.28.27.log        # 1.15 MB — rotated pre-run-2
SquadGame.log                                   # 1.16 MB — active log
```

**Implication for worker-log-ingest:**
- Must handle file rename (inotify `IN_MOVE_SELF`) — re-open by path after rotation.
- If two Squad processes share a `Saved/Logs/` dir (never happens in practice because panel enforces one dir per server UUID), logs interleave and correlation breaks. Panel's per-UUID `/opt/squad-servers/{uuid}/` install layout prevents this.

## Second cold-boot timing is identical

Two cold boots (run 1 at 11:24:26 and run 3 at 11:30:13) both reached beacon-port-listening in ~24 s. No shader-cache speed-up because Squad ships pre-compiled shaders — the long shader-compile-on-first-boot that affects consumer UE titles does not apply here.
