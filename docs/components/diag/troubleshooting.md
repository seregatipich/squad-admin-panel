# `diag` — troubleshooting

The package is intentionally thin, so most "diagnostic events are missing" investigations end up in the consumer or in Redis itself, not in `@squad/diag`. The matrix below covers the symptoms an operator might attribute to the producer and the steps to confirm or rule it out.

## Symptom: bundle endpoint shows no events for the window

### Possible cause A — `worker-diag-flush` is not running

This is the most common cause. The producer keeps adding to `diag:queue` correctly, but nothing reads it into Postgres. Check:

```bash
docker compose ps worker-diag-flush
docker compose logs worker-diag-flush --since 5m
redis-cli XLEN diag:queue
```

`XLEN` climbing without bound (toward `100_000`) means the consumer is not consuming. Restart it. **Diagnosis lives in `worker-diag-flush`'s troubleshooting doc, not here.**

### Possible cause B — pino fallback was used (Redis was down)

Search api/worker logs for the fallback warn line:

```bash
docker compose logs api worker-rcon worker-log-ingest --since 1h | grep 'diag emit failed'
```

If you find entries, the producer was healthy but Redis was unreachable. Check Redis health (`docker compose ps redis`, `redis-cli PING`). The lost events are in the pino logs as warn lines with the full `diag_event` body — they can be hand-flushed if needed.

### Possible cause C — the producer never called `emit`

Most events are emitted from instrumentation points that have to be wired up explicitly (Task 5 onward). If a brand-new component is not yet instrumented, the bundle for that component will be empty. Check the design spec §3.3 for the registered events and which component owns each.

## Symptom: `pnpm --filter @squad/diag test` fails

### Possible cause A — workspace not installed

```bash
pnpm install
pnpm --filter @squad/diag test
```

### Possible cause B — uuid version mismatch

The package uses `uuid`'s `v7` named export. If the workspace is downgraded to a version that does not export `v7` (uuid < 9.0.0 with the named-export API), import will fail with `SyntaxError: The requested module 'uuid' does not provide an export named 'v7'`. Pin to `^14.0.0` (the workspace-wide pin); see `apps/api/package.json` for the canonical pin.

### Possible cause C — vitest version drift

The repo uses vitest `^3.2.7`. If `pnpm-lock.yaml` resolves an older vitest (e.g. via a stale lock), `vi.fn().mockResolvedValue` may fail. Run `pnpm install` to sync the lockfile.

## Symptom: `emit()` rejects with an error

This is **a bug** — `emit()` is contractually `Promise<void>` that never rejects. If you see a rejection in production:

1. Capture the stack trace and the rejected reason.
2. Check whether the consumer is passing a `redis` object whose `xadd` synchronously throws (e.g. a misconfigured mock in tests) — `emit` only catches async rejections.
3. File a regression test in `packages/diag/test/emit.test.ts` that reproduces, and patch `emit` to wrap the entire body in `try`/`catch` if needed.

## Symptom: stream entries have empty `server_id` / `actor_steam_id64` / `request_id`

The producer omits these fields entirely when the input is `undefined`, so an empty string in the stream means the **producer is passing `''` instead of `undefined`**. Audit the call site — TypeScript will catch this if `DiagEvent` is honoured (`?:` not `: string`).

## Symptom: `DIAG_STREAM_KEY` mismatch between producer and consumer

Both the producer (`@squad/diag`) and `@squad/shared-config` re-export the same constant from a single source (`packages/diag/src/types.ts` and `packages/shared-config/src/diag.ts` — the latter is duplicated string-wise but the test in `apps/api/test/audit-coverage.test.ts` style would catch any drift if added). If you renamed the stream and only changed one site, restore consistency.

## Useful commands

```bash
# How big is the queue right now?
redis-cli XLEN diag:queue

# Peek at the last 10 entries (newest first)
redis-cli XREVRANGE diag:queue + - COUNT 10

# How far behind is the consumer?
redis-cli XINFO STREAM diag:queue

# How many entries does the consumer group have pending?
redis-cli XPENDING diag:queue worker-diag-flush:flush

# Force-trim the stream (DESTRUCTIVE — only when wiping)
redis-cli XTRIM diag:queue MAXLEN 0
```

## Useful log lines

| Where | Pattern | Meaning |
|---|---|---|
| Any consumer of `@squad/diag` | `diag emitted` (debug) | `XADD` succeeded. |
| Any consumer of `@squad/diag` | `diag emit failed; using pino fallback` (warn) | `XADD` rejected; the full `diag_event` body is on the same line. |

## Relevant metrics

The package itself emits no metrics; it is the consumer's job to surface flush lag, batch size, and `XPENDING` depth. See `worker-diag-flush`'s `troubleshooting.md` (planned) for that.
