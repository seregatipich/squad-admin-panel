# §0A.4 — RCON protocol verification

## Default `Rcon.cfg` (ships with depot)

```ini
IP=0.0.0.0
Port=21114
Password=          # empty → RCON disabled until set
MaxConnections=5
ConnectionTimeout=300
SecondsBeforeTimeoutCheck=120
AuthenticationTimeout=5
```

RCON TCP port binds **only when `Password=` is non-empty**. With empty password, `ss -tlnp` shows nothing on 21114 (first run confirmed this — port never appeared; after setting password, it bound within 4 s of process start).

## Finding: `mcrcon` does not work against Squad

`mcrcon -H 127.0.0.1 -P 21114 -p $RCON_PW "ShowCurrentMap"` prints nothing. Auth succeeds (no error, no hang) but the command output is swallowed. Suspected cause: mcrcon's multi-packet detection assumes a different server-side framing; Squad sends the response in `SERVERDATA_RESPONSE_VALUE` type-0 packets that mcrcon may treat as auth response continuation.

**Conclusion:** the panel ships its own RCON client in `apps/workers/rcon/`. Do not shell out to `mcrcon`.

## Protocol: standard Valve Source RCON

Captured via `tcpdump -i lo port 21114`, verified with a Python implementation. Wire format matches [Source_RCON_Protocol spec](https://developer.valvesoftware.com/wiki/Source_RCON_Protocol) verbatim:

Each packet:

```
struct {
    int32_t size;       // little-endian, in bytes, not counting this field
    int32_t id;         // echoed back in the response
    int32_t type;       // SERVERDATA_AUTH=3, SERVERDATA_EXECCOMMAND=2,
                        // SERVERDATA_RESPONSE_VALUE=0, SERVERDATA_AUTH_RESPONSE=2
    char    body[];     // null-terminated ASCII
    char    trailing_null;
}
```

Note that `SERVERDATA_EXECCOMMAND` and `SERVERDATA_AUTH_RESPONSE` share the integer value 2. Context disambiguates them (auth-response always follows auth).

### Auth flow, observed wire dump

Client → server (AUTH packet, id=1, payload=`"rc0nT3st_e30ee3497e9e"`):

```
0000: 1f 00 00 00  01 00 00 00  03 00 00 00  72 63 30 6e  ............rc0n
0010: 54 33 73 74  5f 65 33 30  65 65 33 34  39 37 65 39  T3st_e30ee3497e9
0020: 65 00 00                                             e..
```

Server → client, **two** response packets:

```
// Packet 1: empty SERVERDATA_RESPONSE_VALUE (id=1, type=0)
0000: 0a 00 00 00  01 00 00 00  00 00 00 00  00 00        ..............

// Packet 2: SERVERDATA_AUTH_RESPONSE (id=1, type=2)
0000: 0a 00 00 00  01 00 00 00  02 00 00 00  00 00        ..............
```

Auth success signalled by `id` in the auth-response matching the request id; on failure the id would be −1 (0xFFFFFFFF).

### Exec flow

Client → server `ShowCurrentMap` (id=101, type=2, 28 bytes):

```
0000: 18 00 00 00  65 00 00 00  02 00 00 00  53 68 6f 77  ....e.......Show
0010: 43 75 72 72  65 6e 74 4d  61 70 00 00               CurrentMap..
```

Server → client `SERVERDATA_RESPONSE_VALUE` (id=101, type=0, payload=`"Current level is Al Basrah, layer is AlBasrah_AAS_v1, factions USMC MEI"`, 71 bytes + 2 null terminators).

### Multi-packet handling (the "empty ping" trick)

Long responses (e.g. `ListCommands false` returns ~4 KB) may be split across multiple 4 KB TCP frames. Per Valve wiki protocol, the client should send an **empty** SERVERDATA_EXECCOMMAND packet with id=N right after the real command with id=M. The server echoes the empty packet's response last; when the client sees id=N come back, it knows all id=M chunks arrived.

Our implementation will do this; a simple "wait for a small idle timeout" works in practice but is not robust when latency is high. Use the empty-ping trick.

## Command inventory (verified on v10.3.1)

`ListCommands false` output captured in full; 88 commands total. Relevant ones for Phase 0:

| RCON command | Phase-0 usage |
|---|---|
| `ListPlayers` | player snapshot every 30 s |
| `ShowCurrentMap` | server health card |
| `ShowNextMap` | server health card |
| `ShowServerInfo` | **returns JSON** — full server state in one call |
| `AdminBroadcast <msg>` | graceful shutdown announce, operator messages |
| `AdminEndMatch` | graceful shutdown before systemctl stop |
| `ListSquads` | future phase moderation |

Phase-1+ commands (recorded for future use): `AdminKick`, `AdminKickById`, `AdminBan`, `AdminBanById`, `AdminWarn`, `AdminWarnById`, `AdminChangeLayer`, `AdminChangeLevel`, `AdminSetNextLayer`, `AdminSetNextLevel`, `AdminPauseMatch`, `AdminUnpauseMatch`, `AdminRestartMatch`, `AdminReloadServerConfig`, `AdminKillServer`.

### **`ShowServerInfo` returns JSON — big finding**

No need to parse A2S output for most server metadata. One RCON call returns everything:

```json
{
  "MaxPlayers": 20,
  "GameMode_s": "AAS",
  "MapName_s": "AlBasrah_AAS_v1",
  "GameVersion_s": "v10.3.1.576590.1719",
  "PlayerCount_I": "0",
  "PublicQueue_I": "0",
  "ServerName_s": "Squad Dedicated Server",
  "TeamOne_s": "USMC_LO_CombinedArms",
  "TeamTwo_s": "MEI_LO_CombinedArms",
  "BeaconPort_I": "15000",
  "Password_b": false,
  "LICENSEDSERVER_b": false,
  "Region_s": "eu-central-1",
  "ap-southeast-2_I": "984",
  "eu-central-1_I": "140",
  "...": "..."
}
```

Panel health card will primarily use `ShowServerInfo` + `ListPlayers`. A2S query is reserved for §0A.8 discovery verification.

## Response formats (samples from empty server)

```
# ShowCurrentMap (71 bytes)
Current level is Al Basrah, layer is AlBasrah_AAS_v1, factions USMC MEI

# ShowNextMap (23 bytes)
Next map is not defined

# ListPlayers (80 bytes, 0 players)
----- Active Players -----
----- Recently Disconnected Players [Max of 15] -----

# ListSquads (105 bytes, 0 squads)
----- Active Squads -----
Team ID: 1 (31st Marine Expeditionary Unit)
Team ID: 2 (Irregular Battle Group)

# AdminBroadcast result (39 bytes)
Message broadcasted <TEST-SIGNAL-1234>

# help (53 bytes)
Use ListCommands to get a list of available commands.
```

### `ListPlayers` structure (to be confirmed with real player)

Based on Squad wiki and community parsers, with 1+ players the response expands to:

```
----- Active Players -----
ID: 0 | Online IDs: EOS: abc123... Steam: 76561198012345678 | Name: PlayerOne | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01
ID: 1 | Online IDs: EOS: def456... Steam: 76561198087654321 | Name: PlayerTwo | Team ID: 2 | Squad ID: N/A | Is Leader: False | Role: INS_Grenadier_01
----- Recently Disconnected Players [Max of 15] -----
ID: 2 | Online IDs: EOS: ...        Steam: ... | Since Disconnect: 05m.32s | Name: PlayerGone
```

Per-player regex (provisional, to be validated against a real join in verification phase):

```regex
^ID: (?<id>\d+) \| Online IDs: EOS: (?<eos>[a-f0-9]{32}) Steam: (?<steam>\d{17}) \| Name: (?<name>.+?) \| Team ID: (?<team>\d+) \| Squad ID: (?<squad>\d+|N/A) \| Is Leader: (?<leader>True|False) \| Role: (?<role>\S+)$
```

### **Audit gift: every RCON command lands in the log**

For any admin action invoked over RCON, Squad writes:

```
LogSquad: ADMIN COMMAND: <command summary> from RCON
```

Observed samples:

```
LogSquad: ADMIN COMMAND: Message broadcasted <TEST-SIGNAL-1234> from RCON
LogSquad: ADMIN COMMAND: Match ended from RCON
```

worker-log-ingest can cross-reference these lines against the panel's own audit log for tamper detection (panel claims it broadcasted X at time T → Squad log should contain matching `ADMIN COMMAND` within ±2 s).

## Rcon.cfg fields not in TZ §7

Fields worth noting for future phases:

- `ConnectionTimeout=300` — client RCON session auto-terminated after 5 min idle. worker-rcon's 90-s keepalive window is safely under this.
- `SecondsBeforeTimeoutCheck=120` — the TCP-keepalive probe interval; worker-rcon keepalive at 90 s is fine.
- `AuthenticationTimeout=5` — must AUTH within 5 s of TCP connect.
- `MaxConnections=5` — enough room for panel + one debug mcrcon + external ops tooling.

## Summary for implementation

1. `apps/workers/rcon/` ships custom TS Source-RCON client (hand-rolled, `net.createConnection`).
2. Protocol is vanilla Source RCON; Squad sends an empty RESPONSE_VALUE before AUTH_RESPONSE (safe to ignore — just wait for AUTH_RESPONSE with matching id).
3. Use empty-ping trick for multi-packet boundaries.
4. 30-s poll loop executes `ShowServerInfo` + `ListPlayers` (two small commands, ~200 bytes total).
5. Keepalive = 90 s < SecondsBeforeTimeoutCheck=120.
6. Exponential reconnect backoff 1s→60s on disconnect.
