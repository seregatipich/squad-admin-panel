# `diag` — flows

The package has two flows: the happy path (Redis reachable) and the fallback (Redis throws). Everything else (consumer batching, partition rotation, bundle assembly, wipe) belongs to neighbouring components and is referenced but not detailed here.

## Main flow — Redis healthy

Per call to `diag.emit(ev)`:

1. Producer constructs a `DiagEvent` and calls `await diag.emit(ev)`.
2. `emit` generates `id = uuidv7()` and `ts = new Date().toISOString()`.
3. `emit` JSON-stringifies `ev.payload ?? {}` into the `payload` field.
4. `emit` issues a single `XADD diag:queue MAXLEN ~ 100000 * <field/value pairs>` against the injected `redis` client. Optional fields (`server_id`, `actor_steam_id64`, `request_id`) are spread into the argument list only when defined; otherwise they are omitted entirely.
5. Redis acknowledges with the new entry id (e.g. `1700000000000-0`).
6. `emit` calls `log.debug?.({ diag_event: { id, ...ev } }, 'diag emitted')`. Most consumers run pino at `info`, so this is silent in production.
7. `emit` resolves `void`. The producer's call site continues.

```text
producer ──emit(ev)──▶ @squad/diag ──XADD──▶ Redis Stream `diag:queue`
                            │
                            └─▶ pino.debug (when enabled)
```

The downstream consumer (`worker-diag-flush`, separate package) reads with `XREADGROUP`, batches into Postgres, and `XACK`s. That flow is out of scope here.

## Fallback flow — Redis throws

When `redis.xadd` rejects (Redis container down, network partition, AUTH error, etc.):

1. Steps 1–3 of the main flow execute identically.
2. The `XADD` call rejects. `emit` catches the error.
3. `emit` calls `log.warn({ diag_event: { id, ts, ...ev }, err: err.message }, 'diag emit failed; using pino fallback')`.
4. `emit` resolves `void`. The producer's call site continues — it does NOT see the error.

The pino warn line includes the full event body so an operator inspecting `docker logs api --since 5m | grep 'diag emit failed'` can manually reconstruct anything missed by the consumer.

```text
producer ──emit(ev)──▶ @squad/diag ──XADD─x─▶ Redis (rejected)
                            │
                            └─▶ pino.warn { diag_event, err }
```

### Why the fallback never re-throws

The producer's request critical path must not be coupled to Redis liveness. A flapping Redis must not flap server install/start/stop. The cost of a missed bundle entry is acceptable; the cost of a 500 on `POST /servers/:id/start` because Redis hiccupped is not.

### Why the fallback uses `warn` and not `error`

`error` is reserved for "the request failed and the user must know"; the diagnostic miss is an internal degradation, not a user-visible failure. `warn` is what the operator dashboards already alert on.

## Initialization flow

`createDiag({ redis, log })` is a pure factory:

1. Returns an object with one method.
2. No side effects, no network, no allocations of long-lived resources.
3. Safe to call once per process at startup, OR per request — both are equivalent.

The recommended pattern (planned for `apps/api`, Task 5) is once-per-process at server boot, decorating `app.diag` so all routes share one instance.

## Concurrency

`emit` is safe to call from many concurrent paths simultaneously. `ioredis`'s `xadd` is fully async and does not require external locking. `uuidv7` includes a per-process monotonic counter so concurrent calls in the same millisecond produce strictly ordered ids.

## Error flows that do NOT exist

- There is no retry on `XADD` failure — the fallback to pino is the only recovery. Retrying would add latency on the producer side and is the consumer's job (Redis is eventually consistent for stream reads on reconnect anyway).
- There is no validation of `DiagEvent` shape at runtime — TypeScript catches misuse at compile time. Producers that pass garbage at runtime get garbage in Redis; the consumer skips malformed rows.
- There is no buffering or batching on the producer side. One `emit` call equals one `XADD`. Batching is the consumer's job.

## Interactions with other components

| Component | Direction | Interaction |
|---|---|---|
| `redis` (infra) | out | `XADD diag:queue …` |
| pino (`Logger`) | out | `warn` on Redis failure, `debug` on success |
| [`worker-diag-flush`](../workers/README.md) (planned, Task 4) | none direct | reads `diag:queue` via `XREADGROUP`; the producer never sees it |
| [`@squad/shared-config`](../shared-config/README.md) | out (re-exports) | `DIAG_STREAM_KEY`, `DIAG_STREAM_MAXLEN` are mirrored there for consumers that do not want a dep on `@squad/diag` |
| [`@squad/api`](../api/README.md) (planned, Task 5) | in | will decorate Fastify with a per-request `Diag` instance |
| every `@squad/worker-*` (planned, later tasks) | in | will instrument startup, RCON connect/disconnect, parser errors, etc. |
