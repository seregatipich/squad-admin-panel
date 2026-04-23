# §0A.8 — A2S query and Steam Server Browser discovery

## Finding: **Squad v10.x query port does NOT respond to Source Query Protocol (A2S)**

The server correctly binds a UDP socket on `QueryPort=27165` and receives packets directed at it, but it never sends a response. Both `python-a2s` and raw A2S_INFO queries time out. Captured via `tcpdump`:

```
11:51:24.819886 IP 127.0.0.1.50320 > 127.0.0.1.27165: UDP, length 25
# (no reply)
```

The packet was received (kernel reports "1 packet captured, 0 packets dropped"). Squad simply doesn't process or respond to the Source Query Protocol.

### Implication for panel

The TZ §11.1 ("Discovery & health") and §17.7 ("Сервер появляется в Steam Server Browser → Community Servers") hint at A2S as the liveness check. **In v10.x, A2S is a dead API.** Squad relies on EOS (Epic Online Services) Session publishing plus Steam's own backend for Community Server Browser inclusion. The panel should:

1. **Primary health source**: RCON `ShowServerInfo` + `ListPlayers` (already 30 s polled by `worker-rcon`).
2. **Secondary health source**: `systemctl is-active squad-server-<uuid>` via bridge, `process_info` for RSS / CPU.
3. **Do not use A2S** for periodic polling. Don't bother parsing A2S response formats.
4. **External discovery test** in §17.7 remains a manual "is it visible in Community Server Browser from a real Steam client?" — this requires an internet-reachable host with ShouldAdvertise=true and a valid EOS session (Squad handles registration automatically).

This simplifies §17.7 acceptance: no need to query from an external A2S client; verification is a manual browser-side check (screenshot). Panel's internal state comes from RCON.

## Steam Server Browser visibility — manual test

The experiment VM does not have outbound reachability to Steam's public NAT traversal (STUN) infrastructure from Steam's side. The server is running inside an isolated VM and is not internet-exposed. The Steam Server Browser presence check from §17.7 must be done on the final deploy host with a public IP and `ShouldAdvertise=true`. Notes:

- `Server.cfg ShouldAdvertise=true` is set by default.
- `IsLANMatch=false` by default.
- Squad advertises via EOS first, then Steam — the server should appear in Community Servers within 1–3 minutes of start on a public host.
- Panel records `bridge.connected` and `server.ready` events; external visibility is not something panel can directly observe.

## Recommendation for TZ update

- Remove A2S from the Phase 0 implementation plan (§11.1 "Discovery & health").
- Rename §17.7 check "Сервер появляется в Steam Server Browser" as an explicit manual verification item requiring a public IP at deploy time; not a CI gate.
- `python-a2s` dependency: not needed in P0; saves one pip install and an extra library.
