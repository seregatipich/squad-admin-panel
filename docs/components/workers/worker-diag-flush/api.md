# worker-diag-flush — API

The worker exposes no HTTP, no RPC, no CLI commands. Its public surface is two exported functions used by the unit tests, plus the side-effects on Redis and Postgres.

## Exported functions

### `flushBatch(opts)`

Defined in [`apps/workers/diag-flush/src/index.ts`](../../../../apps/workers/diag-flush/src/index.ts).

```ts
export interface FlushBatchOpts {
  sql: postgres.Sql;
  redis: Pick<Redis, 'xack'>;
  group: string;
  stream: string;
  entries: [string, string[]][];
}

export function flushBatch(opts: FlushBatchOpts): Promise<void>;
```

Purpose: take the array of `[streamId, flatFieldList]` tuples returned by `XREADGROUP`, insert all valid rows in a single batched INSERT, then `XACK` every entry id (valid AND malformed).

Parameters:

| Name | Type | Constraints |
|---|---|---|
| `sql` | `postgres.Sql` | A live `postgres()` client. The function calls `sql.unsafe(text, args)`. |
| `redis` | `{ xack(stream, group, ...ids): Promise<number> }` | Any object supporting `xack`. `ioredis.Redis` satisfies it. |
| `group` | `string` | Consumer-group name to `XACK` against. The runtime always passes `'diag-flush'`. |
| `stream` | `string` | Redis Stream key. The runtime always passes `DIAG_STREAM_KEY = 'diag:queue'`. |
| `entries` | `[string, string[]][]` | Array of `[streamId, fields]`. `fields` is a flat `[k, v, k, v, ...]` list as `XREADGROUP` returns. |

Return: `Promise<void>`. Resolves after the INSERT (if any rows were valid) AND the `XACK` complete. Rejects only if `sql.unsafe` or `redis.xack` reject.

Side effects:

- Issues at most one `INSERT INTO diagnostic_events (...) VALUES (...) ON CONFLICT (id, ts) DO NOTHING` per call. If `entries` contains zero parseable rows the INSERT is skipped.
- Issues exactly one `XACK stream group id1 [id2 ...]` per call (covers all entry ids in the input, including malformed ones).
- Logs one `warn` per malformed entry: `"malformed diag entry; ACKing without insert"`.

Errors:

- Postgres errors (constraint violation, connection lost) propagate. The runtime loop catches them, logs `error`, sleeps 1 s and retries the next iteration. Note that since the entry ids were not yet `XACK`ed, the next `XREADGROUP` will redeliver them — `ON CONFLICT (id, ts) DO NOTHING` makes the redrive idempotent.
- Redis errors on `XACK` propagate. Same retry-by-redelivery behaviour.

Example:

```ts
import { flushBatch } from '@squad/worker-diag-flush';

await flushBatch({
  sql,
  redis,
  group: 'diag-flush',
  stream: 'diag:queue',
  entries: [
    ['1700000000000-0', ['id', '019dbaa5-...', 'ts', '2026-04-28T10:00:00Z',
      'component', 'api', 'severity', 'info', 'kind', 'server.start.requested',
      'message', 'manual', 'payload', '{}']],
  ],
});
```

### `parseEntry(fields)`

```ts
export function parseEntry(fields: string[]): ParsedEntry | null;
```

Purpose: convert a single flat `[key, value, key, value, ...]` field list into a typed row, returning `null` if any required field is missing or empty.

Required fields (else `null`): `id`, `ts`, `component`, `severity`, `kind`, `message`. Optional fields: `server_id`, `actor_steam_id64`, `request_id`, `payload` (defaults to `'{}'` if missing).

Used internally by `flushBatch`; exported because every required field, mapping rule, and default is captured in this function alone — unit tests can assert the parsing contract without driving the full batch.

## CLI

None. The worker is launched by `node --enable-source-maps dist/index.js` (the standard worker `CMD`).

## Diagnostic events (`diag:queue` Redis Stream)

Although the worker's primary role is consumer, it also emits two lifecycle events to the same `diag:queue` it drains. These are intentionally minimal — per-iteration `run_ok`/`run_failed` would saturate the stream because the loop runs continuously. All kinds carry `component: 'worker-diag-flush'`.

| Kind | Severity | Trigger | Payload fields |
|---|---|---|---|
| `diag_flush.started` | `info` | After `xgroup CREATE` and `startHeartbeat`, before the consumer loop begins. | `pid: number` |
| `diag_flush.stopped` | `info` | Inside the SIGTERM/SIGINT handler before in-flight batches are awaited and `process.exit(0)` is called. | `sig: 'SIGTERM' \| 'SIGINT'` |

`emitStarted(diag)` and `emitStopped(diag, sig)` are exported from `src/index.ts` so the lifecycle helpers can be unit-tested without standing up the full consumer loop.

## Configuration surface

See [configuration.md](./configuration.md) for env vars.

## Health surface

The worker publishes one heartbeat key:

| Key | Value | TTL |
|---|---|---|
| `worker:heartbeat:diag-flush` | JSON `{name, ts, pid, hostname, version, started_at, status: 'ok'}` | 30 s |

The API aggregates it at `GET /api/v1/health/workers`.
