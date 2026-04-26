# worker-log-ingest — Troubleshooting

## No events appearing in `events:server:{id}`

**Diagnostic steps:**

1. Confirm the worker is alive: `redis-cli GET worker:heartbeat:log-ingest`.
2. Confirm the server status is `running` or `starting`: `SELECT id, status FROM servers WHERE id = '<uuid>'`.
3. Check `tails=N` in the heartbeat `status` field — if N=0 the reconcile loop is not attaching any tails.
4. Check bridge connectivity: `docker compose logs worker-log-ingest --since 5m | grep 'tail'`.

## `tail dropped → restart` repeating in logs

**Likely causes:**

1. The Squad container has stopped or been removed — the bridge `containerLogsFollow` stream ends when the container exits.
2. The bridge socket is unavailable. Run `sg panel -c 'bash scripts/verify-bridge.sh'` on the host.
3. The bridge process restarted and the worker's `BridgeClient` reconnected cleanly — a single restart log followed by resumed tails is normal.

## A Squad log line produces no event but should

**Steps:**

1. Verify the line matches the expected prefix format: `[YYYY.MM.DD-HH.MM.SS:mmm][tick]Category: [Verbosity: ]message`.
2. Check `isBenignNoise` — the line may be matched by a noise filter in `patterns.ts`.
3. Check the category and pattern match in `ingest.ts:handleMessage`. If the Squad version introduced a new log format, add a pattern to `patterns.ts` and a test to `patterns.test.ts`.

## `player.connected` event missing despite player joining

**Likely cause:** The `LogRedpointEOS` line arrived more than 2500 ms after `LogNet: Join succeeded`. This can happen under heavy server load.

**Diagnostic:**

```bash
# Check log timestamps around a join
docker compose logs worker-log-ingest --since 5m | grep -E 'Join succeeded|EOS Connection'
```

If the window is consistently too tight, increase `joinCorrelationWindowMs` in `LogIngestor` construction (currently hardcoded to 2500 ms in `index.ts`).

## Worker not attaching tails for a new server

**Cause:** The reconcile loop runs every 15 s. A newly added server will be picked up on the next reconcile cycle after its status becomes `running` or `starting`.

## Useful commands

```bash
# Worker heartbeat (check tails=N)
redis-cli GET worker:heartbeat:log-ingest

# Recent events from a server
redis-cli XREVRANGE events:server:<uuid> + - COUNT 20

# Dedup keys for a specific event (verify dedup is working)
redis-cli KEYS "dedup:log-ingest:v1:*"

# Worker logs
docker compose logs worker-log-ingest -f --since 2m
```
