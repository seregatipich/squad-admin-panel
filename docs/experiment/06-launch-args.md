# §0A.6 — Launch arguments

Four invocations were tested against the same binary:

| Invocation | Result |
|---|---|
| `./SquadGameServer.sh Port=7787 QueryPort=27165 BeaconPort=15000 FIXEDMAXPLAYERS=20 RANDOM=ALWAYS -log` | boots in ~24 s |
| `./SquadGameServer.sh` (no args, `-log` stdout disabled) | boots; stdout silent; native log still written |
| `./SquadGameServer.sh RANDOM=ALWAYS -log` (minimal) | boots; falls back to default ports |
| `./SquadGameServer.sh Port=7787 FIXEDMAXPLAYERS=20 -log` (partial) | boots on 7787 game port, 27015 query, 15000 beacon |

## Default ports (verified)

Squad uses the standard Unreal Engine / Steam defaults when args are omitted:

| Port | Default | Meaning |
|---:|---:|---|
| Game (`Port=`) | **7777** | UDP, GameNetDriver |
| Query (`QueryPort=`) | **27015** | Steam A2S (Source Query Protocol) |
| Beacon (`BeaconPort=`) | **15000** | UDP, BeaconNetDriver (EOS) |
| RCON (`Rcon.cfg Port=`) | **21114** | TCP, RCON over TCP/IP |

**Correction to TZ §11.1**: the wizard's "auto-suggested defaults" 7787/27165 are panel conventions, not Squad defaults. TZ reads correctly if you interpret those as panel conventions; the wizard should still scan and suggest the lowest free set of (game, query, beacon) starting from 7787/27165 to avoid colliding with any manually-run Squad server on 7777.

## Mandatory vs optional args

None of the command-line args are **mandatory**. Squad boots with zero args — all settings come from `SquadGame/ServerConfig/*.cfg`. Everything on the command line is either a runtime override (`Port=`, `QueryPort=`, `BeaconPort=`, `FIXEDMAXPLAYERS=`, `FIXEDMAXTICKRATE=`, `MULTIHOME=`) or a diagnostic switch (`-log`, `RANDOM=ALWAYS`).

Argument form is `KEY=VALUE` (engine override) or `-FLAG` (boolean). Mixing works.

## Notable args

- `RANDOM=ALWAYS` — skips the interactive first-run prompt Squad would otherwise show (an internal remnant; required for non-interactive boot). Always set in unit file.
- `-log` — redirects engine logs to stdout in addition to the SquadGame.log file. **Not required for panel operation** (we tail the file), but useful in the systemd unit so `journalctl -u squad-server-...` shows output too.
- `FIXEDMAXPLAYERS=<n>` — overrides `Server.cfg MaxPlayers`. Used so the wizard's resource-limit advice (MemoryMax vs player count) stays consistent.
- `FIXEDMAXTICKRATE=<n>` — tickrate override (30/40/50). Unset → uses Server.cfg.
- `MULTIHOME=<ip>` — bind sockets to a specific interface. `0.0.0.0` is the default and correct for most installs.

Errors observed when abusing args:

- Typing `Port=abc` → Squad ignores (uses default 7777) without a complaint. Engine arg parser is permissive.
- Duplicate `Port=` — last one wins.
- Unknown `Foo=bar` — ignored silently.

## Recommended systemd `ExecStart`

Matches TZ §8 template almost verbatim; only change is **drop `RANDOM=ALWAYS` from the template** — it is a first-run placeholder that has no observable effect on subsequent boots (no interactive prompts appeared in runs 3+). Keeping it also harmless.

```
ExecStart=/opt/squad-servers/%i/SquadGameServer.sh \
  Port=${PORT} \
  QueryPort=${QUERY_PORT} \
  BeaconPort=${BEACON_PORT} \
  FIXEDMAXPLAYERS=${MAX_PLAYERS} \
  FIXEDMAXTICKRATE=${TICKRATE} \
  MULTIHOME=${MULTIHOME} \
  -log
```

With per-instance env file under `/etc/squad-server/instance-{uuid}.env`.
