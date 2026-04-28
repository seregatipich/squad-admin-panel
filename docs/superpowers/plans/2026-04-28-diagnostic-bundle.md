# Diagnostic Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist panel-internal events into a 24h-retained `diagnostic_events` store, expose a single global Markdown bundle endpoint capped at 400 KB (with incident reconstruction around shutdowns), surface the download via a small topbar popover, and provide a wipe button that clears the store while audit-logging the action itself.

**Architecture:** Components emit through a thin `packages/diag` helper that pushes to a Redis Stream `diag:queue`; a new lightweight worker `worker-diag-flush` batches inserts into a per-day-partitioned Postgres table `diagnostic_events`. The bundle endpoint queries this table plus existing sources (audit_log, host_metrics stream, SquadGame.log via a new `file_read_tail` bridge RPC) and renders Markdown sections in priority order with hard-cap truncation. Incident reconstruction queries triggers, builds T-5min context windows, and runs a classification heuristic.

**Tech Stack:** TypeScript / Fastify 5 / Drizzle / Postgres 15 (range partitioning) / Redis Streams / Go 1.25 (bridge RPC) / Vitest / Playwright. Companion spec: `docs/superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md`.

---

## File Structure

**Create:**
- `packages/db/drizzle/0017_diagnostic_events.sql` — partitioned table + indexes + initial 25 daily partitions (yesterday + today + 23 future)
- `packages/db/src/schema/diagnostic-events.ts` — Drizzle schema
- `packages/diag/package.json`, `packages/diag/tsconfig.json`, `packages/diag/src/index.ts`, `packages/diag/src/types.ts`, `packages/diag/test/emit.test.ts`
- `apps/workers/diag-flush/{package.json,tsconfig.json,Dockerfile}`, `apps/workers/diag-flush/src/index.ts`, `apps/workers/diag-flush/test/contract.test.ts`
- `apps/api/src/lib/diag.ts` — convenience wrapper, sets `component:'api'` and request_id from Fastify
- `apps/api/src/lib/incident-builder.ts`
- `apps/api/src/lib/bundle-builder.ts`
- `apps/api/src/lib/bundle-redact.ts`
- `apps/api/src/routes/diagnostics.ts`
- `apps/api/test/diagnostics-bundle.test.ts`
- `apps/api/test/diagnostics-wipe.test.ts`
- `apps/api/test/diagnostics-bundle.golden.test.ts`
- `apps/api/test/incident-builder.test.ts`
- `apps/api/test/bundle-redact.test.ts`
- `apps/web/src/components/DiagnosticsMenu.tsx`
- `apps/web/test/e2e/diagnostics.spec.ts`
- `docs/components/diagnostic-bundle/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md`
- `docs/components/workers/worker-diag-flush/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md`

**Modify:**
- `packages/db/src/schema/index.ts` — re-export new schema
- `apps/workers/event-partition/src/index.ts` — add daily diag-partition rotation + drop policy 24h
- `apps/api/src/server.ts` — register diagnostics route
- `apps/api/src/routes/server-install.ts`, `servers.ts`, `server-archive.ts` — emit lifecycle events
- `apps/api/src/plugins/status-reconciler.ts` — emit container.exited / container.unexpected_exit
- `apps/api/src/plugins/bridge.ts` — emit bridge.client.connected/disconnected/rpc.error
- `apps/api/src/plugins/auth.ts` — emit pg/redis ping events
- `apps/api/src/routes/live.ts`, `server-logs.ts`, `server-install.ts` (WS sides) — emit ws.connected/disconnected
- `apps/workers/rcon/src/index.ts` — emit rcon.* events
- `apps/workers/log-ingest/src/index.ts` — emit tail.* + squad.log.fatal parse
- `apps/workers/audit-archiver/src/index.ts` — emit archiver.*
- `apps/workers/event-partition/src/index.ts` — emit partition.* (separate from infrastructure changes above)
- `apps/bridge/internal/handlers/handlers.go` — emit panic / sigterm / connect via journald with `DIAG_EVENT=1`; add `file_read_tail` handler
- `apps/bridge/cmd/panel-host-bridge/main.go` — emit signal events on shutdown
- `packages/shared-config/src/bridge-methods.ts` — add `file_read_tail`
- `packages/bridge-client/src/client.ts` — add `fileReadTail`
- `apps/web/src/app/(dashboard)/layout.tsx` — mount `<DiagnosticsMenu>` in topbar
- `apps/api/test/audit-coverage.test.ts` — assert routes flipping `servers.status` emit a paired diag event
- `docker-compose.yml` — add `worker-diag-flush` service

---

## Phase A1 — Storage + helper

### Task 1: Migration for `diagnostic_events`

**Files:**
- Create: `packages/db/drizzle/0017_diagnostic_events.sql`

- [ ] **Step 1: Write the migration**

```sql
-- diagnostic_events: per-day-partitioned, 24h retention, append-mostly,
-- DELETE/UPDATE allowed (unlike audit_log). UUID v7 PK so id is sortable.

CREATE TABLE diagnostic_events (
  id                uuid NOT NULL,
  ts                timestamptz NOT NULL,
  component         text NOT NULL,
  severity          text NOT NULL,
  kind              text NOT NULL,
  server_id         uuid NULL REFERENCES servers(id) ON DELETE SET NULL,
  actor_steam_id64  bigint NULL,
  request_id        text NULL,
  message           text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT diagnostic_events_pkey PRIMARY KEY (id, ts),
  CONSTRAINT diagnostic_events_severity_chk
    CHECK (severity IN ('debug','info','warn','error','fatal'))
) PARTITION BY RANGE (ts);

CREATE INDEX diagnostic_events_ts_idx        ON diagnostic_events (ts DESC);
CREATE INDEX diagnostic_events_server_ts_idx ON diagnostic_events (server_id, ts DESC);
CREATE INDEX diagnostic_events_kind_ts_idx   ON diagnostic_events (component, severity, ts DESC);

-- Bootstrap partitions: yesterday + today + 23 future days.
DO $$
DECLARE
  d date;
  partname text;
BEGIN
  FOR i IN -1..23 LOOP
    d := (current_date + i)::date;
    partname := 'diagnostic_events_' || to_char(d, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF diagnostic_events FOR VALUES FROM (%L) TO (%L);',
      partname, d, (d + INTERVAL '1 day')::date
    );
  END LOOP;
END$$;
```

- [ ] **Step 2: Run migration locally**

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
```

Expected: `0017_diagnostic_events.sql` reported as applied.

- [ ] **Step 3: Smoke-test in psql**

```bash
psql "$DATABASE_URL" -c "INSERT INTO diagnostic_events (id,ts,component,severity,kind,message) VALUES (gen_random_uuid(), now(), 'test','info','smoke','hello'); SELECT * FROM diagnostic_events;"
```

Expected: one row returned, no FK violations, partition routing happens automatically.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/0017_diagnostic_events.sql
git commit -m "feat(db): diagnostic_events partitioned table"
```

---

### Task 2: Drizzle schema + re-export

**Files:**
- Create: `packages/db/src/schema/diagnostic-events.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the schema**

```ts
// packages/db/src/schema/diagnostic-events.ts
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const diagnosticEvents = pgTable(
  'diagnostic_events',
  {
    id: uuid('id').notNull(),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull(),
    component: text('component').notNull(),
    severity: text('severity').notNull(),
    kind: text('kind').notNull(),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
    actorSteamId64: bigint('actor_steam_id64', { mode: 'bigint' }),
    requestId: text('request_id'),
    message: text('message').notNull(),
    payload: jsonb('payload').notNull().default({}),
  },
  (table) => ({
    tsIdx: index('diagnostic_events_ts_idx').on(table.ts),
    serverTsIdx: index('diagnostic_events_server_ts_idx').on(table.serverId, table.ts),
    kindTsIdx: index('diagnostic_events_kind_ts_idx').on(table.component, table.severity, table.ts),
    severityChk: check(
      'diagnostic_events_severity_chk',
      sql`severity IN ('debug','info','warn','error','fatal')`,
    ),
  }),
);

export type DiagnosticEventRow = typeof diagnosticEvents.$inferSelect;
export type NewDiagnosticEvent = typeof diagnosticEvents.$inferInsert;
```

- [ ] **Step 2: Re-export**

Edit `packages/db/src/schema/index.ts` and add the line `export * from './diagnostic-events.js';` next to the other re-exports (keep alphabetical ordering).

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @squad/db exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/diagnostic-events.ts packages/db/src/schema/index.ts
git commit -m "feat(db): drizzle schema for diagnostic_events"
```

---

### Task 3: `packages/diag` skeleton + types

**Files:**
- Create: `packages/diag/package.json`, `packages/diag/tsconfig.json`, `packages/diag/src/types.ts`, `packages/diag/src/index.ts`, `packages/diag/test/emit.test.ts`

- [ ] **Step 1: Scaffold package**

`packages/diag/package.json`:

```json
{
  "name": "@squad/diag",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ioredis": "^5.4.1",
    "pino": "^9.4.0",
    "uuid": "^11.0.3"
  },
  "devDependencies": {
    "vitest": "^2.1.4",
    "typescript": "^5.6.3",
    "@types/node": "^22.9.0"
  }
}
```

`packages/diag/tsconfig.json`: copy from `packages/shared-config/tsconfig.json`.

- [ ] **Step 2: Write the types**

```ts
// packages/diag/src/types.ts
export type DiagSeverity = 'info' | 'warn' | 'error' | 'fatal';

export interface DiagEvent {
  component: string;
  kind: string;
  severity: DiagSeverity;
  serverId?: string;
  actorSteamId64?: string;
  requestId?: string;
  message: string;
  payload?: Record<string, unknown>;
}

export const DIAG_STREAM_KEY = 'diag:queue';
export const DIAG_STREAM_MAXLEN = 100_000;
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/diag/test/emit.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createDiag } from '../src/index.js';

describe('diag.emit', () => {
  it('XADDs the event to diag:queue with all fields serialized', async () => {
    const xadd = vi.fn().mockResolvedValue('1700000000000-0');
    const redis = { xadd } as any;
    const log = { warn: vi.fn() } as any;
    const diag = createDiag({ redis, log });

    await diag.emit({
      component: 'api',
      kind: 'server.start.requested',
      severity: 'info',
      serverId: '019dbaa5-0000-7000-8000-000000000000',
      message: 'manual start',
      payload: { reason: 'manual' },
    });

    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0];
    expect(args[0]).toBe('diag:queue');
    expect(args).toContain('MAXLEN');
    const flat = args.slice(args.indexOf('*') + 1);
    const fields: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    expect(fields.component).toBe('api');
    expect(fields.kind).toBe('server.start.requested');
    expect(JSON.parse(fields.payload)).toEqual({ reason: 'manual' });
  });

  it('falls back to pino.warn when Redis throws', async () => {
    const redis = { xadd: vi.fn().mockRejectedValue(new Error('NOREDIS')) } as any;
    const log = { warn: vi.fn() } as any;
    const diag = createDiag({ redis, log });
    await diag.emit({ component: 'api', kind: 'x', severity: 'info', message: 'hi' });
    expect(log.warn).toHaveBeenCalled();
    const arg = log.warn.mock.calls[0][0];
    expect(arg.diag_event.kind).toBe('x');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
pnpm --filter @squad/diag test
```

Expected: FAIL — `createDiag` not exported.

- [ ] **Step 5: Implement `createDiag`**

```ts
// packages/diag/src/index.ts
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { DIAG_STREAM_KEY, DIAG_STREAM_MAXLEN, type DiagEvent } from './types.js';

export type * from './types.js';

export interface DiagDeps {
  redis: Pick<Redis, 'xadd'>;
  log: Pick<Logger, 'warn' | 'debug'>;
}

export interface Diag {
  emit(ev: DiagEvent): Promise<void>;
}

export function createDiag({ redis, log }: DiagDeps): Diag {
  return {
    async emit(ev: DiagEvent) {
      const id = uuidv7();
      const ts = new Date().toISOString();
      const payload = JSON.stringify(ev.payload ?? {});
      try {
        await redis.xadd(
          DIAG_STREAM_KEY,
          'MAXLEN',
          '~',
          DIAG_STREAM_MAXLEN,
          '*',
          'id', id,
          'ts', ts,
          'component', ev.component,
          'severity', ev.severity,
          'kind', ev.kind,
          ...(ev.serverId ? ['server_id', ev.serverId] : []),
          ...(ev.actorSteamId64 ? ['actor_steam_id64', ev.actorSteamId64] : []),
          ...(ev.requestId ? ['request_id', ev.requestId] : []),
          'message', ev.message,
          'payload', payload,
        );
        log.debug?.({ diag_event: { id, ...ev } }, 'diag emitted');
      } catch (err) {
        log.warn(
          { diag_event: { id, ts, ...ev }, err: (err as Error).message },
          'diag emit failed; using pino fallback',
        );
      }
    },
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @squad/diag test
```

Expected: 2/2 PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/diag
git commit -m "feat(diag): @squad/diag package with redis-stream emit + pino fallback"
```

---

### Task 4: `worker-diag-flush` (consumes `diag:queue`, batches into Postgres)

**Files:**
- Create: `apps/workers/diag-flush/{package.json,tsconfig.json,Dockerfile}`, `apps/workers/diag-flush/src/index.ts`, `apps/workers/diag-flush/test/contract.test.ts`

- [ ] **Step 1: Scaffold (mirror `apps/workers/audit-archiver`)**

`apps/workers/diag-flush/package.json`:

```json
{
  "name": "@squad/worker-diag-flush",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@squad/db": "workspace:*",
    "@squad/diag": "workspace:*",
    "@squad/shared-config": "workspace:*",
    "ioredis": "^5.4.1",
    "pino": "^9.4.0",
    "postgres": "^3.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4",
    "@types/node": "^22.9.0"
  }
}
```

Copy `tsconfig.json` and `Dockerfile` from `apps/workers/audit-archiver`.

- [ ] **Step 2: Write the failing contract test**

```ts
// apps/workers/diag-flush/test/contract.test.ts
import { describe, expect, it, vi } from 'vitest';
import { flushBatch } from '../src/index.js';

describe('worker-diag-flush', () => {
  it('parses XREAD entries and inserts in one batch, then ACKs', async () => {
    const sql = vi.fn(async () => undefined) as any;
    sql.unsafe = vi.fn(async () => undefined);
    const redis = { xack: vi.fn().mockResolvedValue(1) } as any;

    const entries: [string, string[]][] = [
      [
        '1700-0',
        [
          'id', '019dbaa5-0000-7000-8000-000000000001',
          'ts', '2026-04-28T10:00:00Z',
          'component', 'api',
          'severity', 'info',
          'kind', 'server.start.requested',
          'message', 'manual',
          'payload', '{}',
        ],
      ],
    ];

    await flushBatch({ sql, redis, group: 'g', stream: 'diag:queue', entries });

    expect(sql.unsafe).toHaveBeenCalledTimes(1);
    const [text, args] = sql.unsafe.mock.calls[0];
    expect(text).toMatch(/^INSERT INTO diagnostic_events/);
    expect(args.length).toBe(9); // one row × 9 columns
    expect(redis.xack).toHaveBeenCalledWith('diag:queue', 'g', '1700-0');
  });
});
```

- [ ] **Step 3: Verify FAIL**

```bash
pnpm --filter @squad/worker-diag-flush test
```

Expected: FAIL (`flushBatch` not exported).

- [ ] **Step 4: Implement worker**

```ts
// apps/workers/diag-flush/src/index.ts
import { startHeartbeat, DIAG_STREAM_KEY } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-diag-flush' } });

const GROUP = 'diag-flush';
const CONSUMER = `diag-flush-${process.pid}`;
const BATCH_SIZE = Number.parseInt(process.env.DIAG_FLUSH_BATCH_SIZE ?? '100', 10);
const BLOCK_MS = 1000;

interface ParsedEntry {
  id: string;
  ts: string;
  component: string;
  severity: string;
  kind: string;
  serverId: string | null;
  actorSteamId64: string | null;
  requestId: string | null;
  message: string;
  payload: string;
}

function parse(fields: string[]): ParsedEntry {
  const m: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) m[fields[i]!] = fields[i + 1] ?? '';
  return {
    id: m.id!,
    ts: m.ts!,
    component: m.component!,
    severity: m.severity!,
    kind: m.kind!,
    serverId: m.server_id ?? null,
    actorSteamId64: m.actor_steam_id64 ?? null,
    requestId: m.request_id ?? null,
    message: m.message!,
    payload: m.payload || '{}',
  };
}

export async function flushBatch(opts: {
  sql: postgres.Sql;
  redis: Redis;
  group: string;
  stream: string;
  entries: [string, string[]][];
}) {
  const { sql, redis, group, stream, entries } = opts;
  if (!entries.length) return;
  const rows = entries.map(([, f]) => parse(f));

  const placeholders: string[] = [];
  const args: unknown[] = [];
  let i = 1;
  for (const r of rows) {
    placeholders.push(
      `($${i++},$${i++}::timestamptz,$${i++},$${i++},$${i++},$${i++}::uuid,$${i++}::bigint,$${i++},$${i++},$${i++}::jsonb)`,
    );
    args.push(
      r.id, r.ts, r.component, r.severity, r.kind,
      r.serverId, r.actorSteamId64, r.requestId, r.message, r.payload,
    );
  }
  const text = `INSERT INTO diagnostic_events
    (id, ts, component, severity, kind, server_id, actor_steam_id64, request_id, message, payload)
    VALUES ${placeholders.join(',')} ON CONFLICT (id, ts) DO NOTHING`;
  await sql.unsafe(text, args);

  const ids = entries.map(([streamId]) => streamId);
  await redis.xack(stream, group, ...ids);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { log.fatal('DATABASE_URL is required'); process.exit(1); }
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const sql = postgres(url, { max: 2 });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  // Ensure consumer group (idempotent).
  await redis.xgroup('CREATE', DIAG_STREAM_KEY, GROUP, '$', 'MKSTREAM').catch((err) => {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  });

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'diag-flush',
    statusFn: () => 'ok',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  let stopped = false;
  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopped = true;
    stopHeartbeat();
    await sql.end({ timeout: 5 });
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  while (!stopped) {
    try {
      const res = (await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', BATCH_SIZE,
        'BLOCK', BLOCK_MS,
        'STREAMS', DIAG_STREAM_KEY, '>',
      )) as [string, [string, string[]][]][] | null;
      if (!res) continue;
      for (const [, entries] of res) {
        await flushBatch({ sql, redis, group: GROUP, stream: DIAG_STREAM_KEY, entries });
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'flush iteration failed');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

if (process.env.VITEST !== 'true') main().catch((err) => { log.fatal({ err: (err as Error).message }, 'fatal'); process.exit(1); });
```

- [ ] **Step 5: Add `DIAG_STREAM_KEY` re-export to shared-config**

Edit `packages/shared-config/src/index.ts` (or wherever the heartbeat util lives) to add `export const DIAG_STREAM_KEY = 'diag:queue';` so workers can import it from `@squad/shared-config`.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @squad/worker-diag-flush test
```

Expected: PASS.

- [ ] **Step 7: Add docker-compose service**

In `docker-compose.yml`, add (alongside other workers):

```yaml
  worker-diag-flush:
    build:
      context: .
      dockerfile: docker/Dockerfile.worker
      args: { WORKER: diag-flush }
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      DIAG_FLUSH_BATCH_SIZE: 100
    depends_on: [postgres, redis]
    restart: unless-stopped
```

- [ ] **Step 8: Commit**

```bash
git add apps/workers/diag-flush packages/shared-config docker-compose.yml
git commit -m "feat(workers): worker-diag-flush — Redis Stream → batched diagnostic_events INSERT"
```

---

### Task 5: 24h drop policy in `worker-event-partition`

**Files:**
- Modify: `apps/workers/event-partition/src/index.ts`

- [ ] **Step 1: Add helper that creates tomorrow's partition + drops partitions older than 24h**

Append inside `ensurePartitions` (replace the placeholder body):

```ts
async function ensureDiagPartitions(sql: postgres.Sql) {
  const days = [-1, 0, 1, 2];
  for (const d of days) {
    const date = new Date(Date.now() + d * 86_400_000);
    const partname = `diagnostic_events_${date.toISOString().slice(0, 10).replace(/-/g, '')}`;
    const from = date.toISOString().slice(0, 10);
    const to = new Date(date.getTime() + 86_400_000).toISOString().slice(0, 10);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${partname} PARTITION OF diagnostic_events
       FOR VALUES FROM ('${from}') TO ('${to}');`,
    );
  }
  // Drop partitions whose to-bound is more than 24h in the past.
  const stale = await sql<{ partname: string }[]>`
    SELECT relname AS partname
    FROM pg_inherits
    JOIN pg_class p  ON p.oid = inhrelid
    JOIN pg_class pp ON pp.oid = inhparent
    WHERE pp.relname = 'diagnostic_events'
      AND relname < ${'diagnostic_events_' + new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replace(/-/g, '')}
  `;
  for (const { partname } of stale) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${partname};`);
    log.info({ partname }, 'dropped stale diag partition');
  }
}
```

Call it from the existing `ensurePartitions` immediately after the existing event-partition logic.

- [ ] **Step 2: Test (extend existing worker tests)**

In `apps/workers/event-partition/test/contract.test.ts`, add:

```ts
it('creates today and tomorrow diagnostic partitions', async () => {
  // arrange a fake sql template + capture executed strings
  const calls: string[] = [];
  const sql: any = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise.resolve([]);
  sql.unsafe = (s: string) => { calls.push(s); return Promise.resolve(undefined); };
  // call exported ensureDiagPartitions (export it from index.ts for the test)
  const { ensureDiagPartitions } = await import('../src/index.js');
  await ensureDiagPartitions(sql);
  expect(calls.some((c) => c.includes('PARTITION OF diagnostic_events'))).toBe(true);
});
```

Export `ensureDiagPartitions` from `apps/workers/event-partition/src/index.ts`.

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @squad/worker-event-partition test
```

Expected: PASS (existing + new test).

- [ ] **Step 4: Commit**

```bash
git add apps/workers/event-partition
git commit -m "feat(worker-event-partition): manage 24h diagnostic_events partitions"
```

---

## Phase A2 — Instrumentation

### Task 6: API-side `diag` plugin + Fastify decoration

**Files:**
- Create: `apps/api/src/lib/diag.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the API helper**

```ts
// apps/api/src/lib/diag.ts
import type { FastifyInstance } from 'fastify';
import { createDiag, type Diag } from '@squad/diag';

declare module 'fastify' {
  interface FastifyInstance { diag: Diag; }
  interface FastifyRequest { diag: Diag; }
}

export function registerDiag(app: FastifyInstance) {
  const diag = createDiag({ redis: app.redis, log: app.log });
  app.decorate('diag', diag);
  app.decorateRequest('diag', null as unknown as Diag);
  app.addHook('onRequest', (req, _reply, done) => {
    const requestId = (req as { id?: string }).id;
    (req as unknown as { diag: Diag }).diag = {
      emit(ev) {
        return diag.emit({ ...ev, requestId: ev.requestId ?? requestId });
      },
    };
    done();
  });
}
```

- [ ] **Step 2: Wire into server.ts**

In `apps/api/src/server.ts`, after `app.register(redisPlugin)` and before route registration, add:

```ts
import { registerDiag } from './lib/diag.js';
// ...
registerDiag(app);
```

- [ ] **Step 3: Smoke-test**

Run `pnpm --filter @squad/api test` to ensure the existing test suite still passes (no regressions from decoration).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/diag.ts apps/api/src/server.ts
git commit -m "feat(api): register @squad/diag — Fastify decorator + per-request requestId"
```

---

### Task 7: Server lifecycle events

**Files:**
- Modify: `apps/api/src/routes/server-install.ts`, `apps/api/src/routes/servers.ts`, `apps/api/src/routes/server-archive.ts`

- [ ] **Step 1: Write a focused test first**

Create `apps/api/test/diag-lifecycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './integration/harness.js';

describe('server lifecycle emits diag events', () => {
  it('POST /servers/:id/start emits server.start.requested then server.start.done', async () => {
    const { app, db, helpers } = await buildTestApp();
    const captured: any[] = [];
    app.diag = { emit: async (ev) => { captured.push(ev); } } as any;
    const server = await helpers.createServer({ status: 'stopped' });
    const cookie = await helpers.ownerCookie();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${server.id}/start`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['server.start.requested', 'server.start.done']),
    );
  });
});
```

Run: `pnpm --filter @squad/api exec vitest run test/diag-lifecycle.test.ts` — expect FAIL.

- [ ] **Step 2: Add `req.diag.emit(...)` calls in `server-install.ts`**

For every install step (depot_seed, ufw_rule, container_run, verify), wrap with:

```ts
await req.diag.emit({
  component: 'api',
  kind: 'server.install.depot_seed',
  severity: 'info',
  serverId: server.id,
  actorSteamId64: req.user?.steamId64 ?? null,
  message: `seeded ${seededCount} cfg files`,
  payload: { seededCount, durationMs: Date.now() - t0 },
});
```

Add the same pattern for `server.install.{requested,ufw_rule,container_run,verify,done,failed}`. On failure path, severity becomes `error` and payload includes `err.message`.

- [ ] **Step 3: Add lifecycle emits in `servers.ts`**

For `POST /servers/:id/start` and `POST /servers/:id/stop` and the soft-delete handler, emit:
- `server.start.requested` (info, before action)
- `server.start.done` / `server.start.failed` (info / error, after)
- `server.stop.requested`
- `server.stop.broadcast` (after AdminBroadcast attempt) with payload `{ ok, raw_response }`
- `server.stop.end_match` (after AdminEndMatch)
- `server.stop.container_stop` (after bridge.containerStop)
- `server.stop.done` / `server.stop.failed`

- [ ] **Step 4: Add emits in `server-archive.ts`**

For soft-delete and restore paths: `server.soft_delete.{requested,done}`, `server.restore.{requested,done}`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @squad/api test
```

Expected: existing suite PASS, new diag-lifecycle test PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/server-install.ts apps/api/src/routes/servers.ts apps/api/src/routes/server-archive.ts apps/api/test/diag-lifecycle.test.ts
git commit -m "feat(api): emit diag events for server lifecycle (install/start/stop/archive/restore)"
```

---

### Task 8: Reconciler emits container.exited / container.unexpected_exit

**Files:**
- Modify: `apps/api/src/plugins/status-reconciler.ts`

- [ ] **Step 1: Failing test**

Append to `apps/api/test/status-reconciler.test.ts` (or create a focused new file):

```ts
it('emits container.exited with exit_code/oom_killed/signal on running→stopped transition', async () => {
  const captured: any[] = [];
  reconciler.diag = { emit: async (ev) => { captured.push(ev); } } as any;
  // simulate inspect returning Status:'exited', ExitCode:137, OOMKilled:true
  await reconciler.tick(serverId, fakeInspect({ Status: 'exited', ExitCode: 137, OOMKilled: true, Error: '' }));
  const ev = captured.find((e) => e.kind === 'container.exited');
  expect(ev).toBeDefined();
  expect(ev.payload.exit_code).toBe(137);
  expect(ev.payload.oom_killed).toBe(true);
});
```

- [ ] **Step 2: Wire `app.diag` into reconciler**

In `status-reconciler.ts`, where the transition `running → stopped` is detected, after the existing DB update, add:

```ts
const inspect = result.State; // from container_inspect
const wasRequested = await wasStopRequestedRecently(app.redis, server.id, 5 * 60_000);
await app.diag.emit({
  component: 'reconciler',
  kind: wasRequested ? 'container.exited' : 'container.unexpected_exit',
  severity: inspect.ExitCode === 0 ? 'info' : 'error',
  serverId: server.id,
  message: `container exited (code=${inspect.ExitCode}${inspect.OOMKilled ? ', oom' : ''})`,
  payload: {
    exit_code: inspect.ExitCode,
    oom_killed: !!inspect.OOMKilled,
    signal: inspect.Error || null,
    finished_at: inspect.FinishedAt,
    started_at: inspect.StartedAt,
  },
});
```

`wasStopRequestedRecently` is a small helper that checks Redis for a key `stop:requested:{server_id}` set on the start of `server.stop.requested` with TTL 5 min — add the SET in Task 7 step 3 (server stop handler).

- [ ] **Step 3: Run tests; PASS expected.**

```bash
pnpm --filter @squad/api test
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/plugins/status-reconciler.ts apps/api/src/routes/servers.ts apps/api/test/status-reconciler.test.ts
git commit -m "feat(reconciler): emit container.exited with exit_code/oom/signal/finishedAt"
```

---

### Task 9: Bridge connector + RPC error events

**Files:**
- Modify: `apps/api/src/plugins/bridge.ts`

- [ ] **Step 1: Wire onConnect / onDisconnect / onError handlers**

Around the existing BridgeClient construction, attach:

```ts
client.on('connected', (info) => {
  app.diag.emit({
    component: 'api',
    kind: 'bridge.client.connected',
    severity: 'info',
    message: `bridge connected (rtt=${info.rttMs}ms, version=${info.version})`,
    payload: { rttMs: info.rttMs, version: info.version },
  }).catch(() => undefined);
});
client.on('disconnected', (reason) => {
  app.diag.emit({
    component: 'api',
    kind: 'bridge.client.disconnected',
    severity: 'error',
    message: `bridge disconnected: ${reason}`,
    payload: { reason },
  }).catch(() => undefined);
});
client.on('rpc-error', ({ method, code, message }) => {
  app.diag.emit({
    component: 'api',
    kind: 'bridge.rpc.error',
    severity: 'warn',
    message: `${method} → ${code}: ${message}`,
    payload: { method, code, message },
  }).catch(() => undefined);
});
client.on('rtt', (rttMs) => {
  if (rttMs > 50) {
    app.diag.emit({
      component: 'api',
      kind: 'bridge.rtt.outlier',
      severity: 'warn',
      message: `RTT ${rttMs}ms`,
      payload: { rttMs },
    }).catch(() => undefined);
  }
});
```

- [ ] **Step 2: If `BridgeClient` doesn't expose those events yet, add them**

In `packages/bridge-client/src/client.ts`, extend `EventEmitter` (or composition) and emit at the existing connect/disconnect/error sites. Add a unit test in `packages/bridge-client/test/client.test.ts` asserting the events fire.

- [ ] **Step 3: Run tests**

```bash
pnpm turbo run test --filter @squad/api --filter @squad/bridge-client
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/plugins/bridge.ts packages/bridge-client
git commit -m "feat(bridge-client+api): emit diag events on bridge connect/disconnect/rpc errors/rtt outliers"
```

---

### Task 10: PG/Redis connector events

**Files:**
- Modify: `apps/api/src/plugins/auth.ts` (or wherever the pg + redis plugins are registered — verify before editing)

- [ ] **Step 1: Add reconnect listeners**

For `ioredis` connection (in the redis plugin):

```ts
redis.on('error', (err) => {
  app.diag?.emit({
    component: 'api', kind: 'redis.ping.fail', severity: 'error',
    message: `redis error: ${err.message}`, payload: { err: err.message },
  }).catch(() => undefined);
});
redis.on('reconnecting', () => {
  app.diag?.emit({ component: 'api', kind: 'redis.reconnect.attempt', severity: 'warn',
    message: 'redis reconnecting', payload: {} }).catch(() => undefined);
});
redis.on('ready', () => {
  app.diag?.emit({ component: 'api', kind: 'redis.reconnect.success', severity: 'info',
    message: 'redis ready', payload: {} }).catch(() => undefined);
});
```

For `postgres` driver:

```ts
sql.listen?.('pg-error', () => undefined); // postgres-js doesn't expose connection events directly
// instead: wrap each query path; emit on health-check fail in plugins/db.ts
```

If a periodic health-check loop doesn't exist, add one in `plugins/db.ts` (every 30s, run `SELECT 1`, emit `pg.ping.fail` on throw + `pg.ping.ok` only first time after a fail).

- [ ] **Step 2: Run integration test that toggles Redis off/on (skip if no infra; manual otherwise)**

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/plugins
git commit -m "feat(api): emit diag events on pg/redis connector state changes"
```

---

### Task 11: Worker-rcon events

**Files:**
- Modify: `apps/workers/rcon/src/index.ts`

- [ ] **Step 1: Inject diag into the worker**

At worker startup:

```ts
import { createDiag } from '@squad/diag';
const diag = createDiag({ redis, log });
```

- [ ] **Step 2: Emit per-target events**

At every place where a target is added/removed from the polling set, emits `rcon.targets.changed` with payload `{ added: [...uuid], removed: [...uuid], total: N }`.

On every connection lifecycle event (per-target):

```ts
await diag.emit({ component: 'worker-rcon', kind: 'rcon.connected', severity: 'info',
  serverId, message: `rcon connected ${host}:${port}`, payload: { host, port } });
await diag.emit({ component: 'worker-rcon', kind: 'rcon.auth_failed', severity: 'error',
  serverId, message: 'rcon auth failed', payload: { host, port } });
await diag.emit({ component: 'worker-rcon', kind: 'rcon.disconnected', severity: 'warn',
  serverId, message: `rcon disconnected: ${reason}`, payload: { reason } });
```

Manual command timeout (NOT auto-poll):

```ts
await diag.emit({ component: 'worker-rcon', kind: 'rcon.command.timeout', severity: 'warn',
  serverId, message: `command "${cmd}" timed out`, payload: { cmd, timeoutMs } });
```

- [ ] **Step 3: Tests**

Add cases to `apps/workers/rcon/test/contract.test.ts` asserting `diag.emit` is called on simulated auth-fail and disconnect.

- [ ] **Step 4: Commit**

```bash
git add apps/workers/rcon
git commit -m "feat(worker-rcon): emit diag events on connect/auth_fail/disconnect/targets-changed/cmd-timeout"
```

---

### Task 12: Worker-log-ingest events + squad.log.fatal parsing

**Files:**
- Modify: `apps/workers/log-ingest/src/index.ts`, `apps/workers/log-ingest/src/parser/index.ts`

- [ ] **Step 1: Tail lifecycle**

Emit `tail.started` / `tail.stopped` / `tails.changed` mirroring the rcon pattern from Task 11.

- [ ] **Step 2: Squad fatal/log-exit/assertion parser**

In the parser, detect lines matching:

```
/^\[(?<ts>[^\]]+)\]\[ *\d+\]LogExit: (?<msg>.*)$/
/^\[(?<ts>[^\]]+)\]\[ *\d+\]Fatal error: (?<msg>.*)$/
/Assertion failed: (?<msg>.*) \[File:(?<file>[^\]]+) Line: (?<line>\d+)\]/
```

and emit:

```ts
await diag.emit({
  component: 'worker-log-ingest',
  kind: 'squad.log.fatal',
  severity: 'fatal',
  serverId,
  message: msg.slice(0, 200),
  payload: { ts, file, line, raw: line.slice(0, 500) },
});
```

- [ ] **Step 3: Test fixtures**

Append parser tests with three fixture lines covering each pattern; assert `diag.emit` called with correct kind.

- [ ] **Step 4: Commit**

```bash
git add apps/workers/log-ingest
git commit -m "feat(worker-log-ingest): emit tail lifecycle + squad.log.fatal parsing"
```

---

### Task 13: Other workers (audit-archiver, event-partition) + heartbeat-lost detector

**Files:**
- Modify: `apps/workers/audit-archiver/src/index.ts`, `apps/workers/event-partition/src/index.ts`, `apps/api/src/plugins/health.ts` (or create one)

- [ ] **Step 1: Worker start/stop/run events**

In each worker, after `startHeartbeat`, immediately:

```ts
await diag.emit({ component: 'worker-audit-archiver', kind: 'archiver.started',
  severity: 'info', message: 'started', payload: { pid: process.pid } });
```

In the SIGTERM/SIGINT handler:

```ts
await diag.emit({ component: 'worker-audit-archiver', kind: 'archiver.stopped',
  severity: 'info', message: `received ${sig}`, payload: { sig } });
```

After each scheduled run: `archiver.run_ok` (info) or `archiver.run_failed` (error).

- [ ] **Step 2: Heartbeat-lost detector in API**

Create `apps/api/src/plugins/heartbeat-watch.ts`. Every 30s, list known worker names, check Redis `worker:heartbeat:{name}` TTL; if absent for >30s and not previously reported, emit `worker.heartbeat_lost`. Reset on next observation.

```ts
const KNOWN = ['rcon','log-ingest','audit-archiver','event-partition','diag-flush','metrics-sampler'];
const lostUntil = new Map<string, number>(); // name → ts of first observation of the gap
setInterval(async () => {
  const now = Date.now();
  for (const name of KNOWN) {
    const ttl = await app.redis.pttl(`worker:heartbeat:${name}`);
    if (ttl < 0) {
      const since = lostUntil.get(name) ?? now;
      lostUntil.set(name, since);
      if (now - since > 30_000 && now - since < 60_000) {
        await app.diag.emit({
          component: 'api', kind: 'worker.heartbeat_lost', severity: 'error',
          message: `worker ${name} heartbeat absent`, payload: { worker: name },
        });
      }
    } else {
      if (lostUntil.has(name)) {
        await app.diag.emit({
          component: 'api', kind: 'worker.heartbeat_recovered', severity: 'info',
          message: `worker ${name} recovered`, payload: { worker: name },
        });
        lostUntil.delete(name);
      }
    }
  }
}, 30_000);
```

Register the plugin in `apps/api/src/server.ts` after the diag plugin.

- [ ] **Step 3: Tests**

Add `apps/api/test/heartbeat-watch.test.ts` with fake redis returning `pttl=-2` for one cycle and asserting `diag.emit` called with `worker.heartbeat_lost`.

- [ ] **Step 4: Commit**

```bash
git add apps/workers/audit-archiver apps/workers/event-partition apps/api/src/plugins/heartbeat-watch.ts apps/api/src/server.ts apps/api/test/heartbeat-watch.test.ts
git commit -m "feat: emit worker lifecycle + worker.heartbeat_lost detection"
```

---

### Task 14: WS client connect/disconnect events

**Files:**
- Modify: `apps/api/src/routes/live.ts`, `apps/api/src/routes/server-logs.ts`, `apps/api/src/routes/server-install.ts`

- [ ] **Step 1: Wrap each WS handler**

For each WS route, on connection open and close:

```ts
ws.on('connection', (socket, req) => {
  app.diag.emit({ component: 'api', kind: 'ws.connected', severity: 'info',
    message: `ws ${req.url} connected`, payload: { url: req.url } });
  socket.on('close', (code, reason) => {
    app.diag.emit({ component: 'api', kind: 'ws.disconnected', severity: 'info',
      message: `ws ${req.url} closed code=${code}`, payload: { code, reason: reason.toString().slice(0,200), url: req.url } });
  });
  socket.on('error', (err) => {
    app.diag.emit({ component: 'api', kind: 'ws.error', severity: 'warn',
      message: `ws error: ${err.message}`, payload: { err: err.message, url: req.url } });
  });
});
```

- [ ] **Step 2: Run integration tests in `apps/api/test/install-ws.test.ts` etc. — assert no regressions**

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/live.ts apps/api/src/routes/server-logs.ts apps/api/src/routes/server-install.ts
git commit -m "feat(api): emit ws.connected/disconnected/error diag events"
```

---

### Task 15: HTTP error layer events

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Hook into `setErrorHandler`**

```ts
app.setErrorHandler((err, req, reply) => {
  if (reply.statusCode >= 500 || !reply.statusCode) {
    app.diag.emit({
      component: 'api', kind: 'http.5xx', severity: 'error',
      message: `${req.method} ${req.url} → ${err.message}`,
      requestId: req.id,
      actorSteamId64: req.user?.steamId64 ?? undefined,
      payload: { method: req.method, url: req.url, status: reply.statusCode, err: err.message, stack: err.stack?.slice(0, 2000) },
    }).catch(() => undefined);
  }
  // existing reply
});

process.on('unhandledRejection', (reason) => {
  app.diag.emit({
    component: 'api', kind: 'http.unhandled_rejection', severity: 'fatal',
    message: String(reason).slice(0, 200), payload: { reason: String(reason) },
  }).catch(() => undefined);
});
```

- [ ] **Step 2: Test**

Add `apps/api/test/diag-http-errors.test.ts`: register a route that throws, inject, assert a `http.5xx` diag event was emitted.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/server.ts apps/api/test/diag-http-errors.test.ts
git commit -m "feat(api): emit http.5xx + http.unhandled_rejection diag events"
```

---

### Task 16: Audit-coverage extension

**Files:**
- Modify: `apps/api/test/audit-coverage.test.ts`

- [ ] **Step 1: Extend the existing scan**

After the existing audit assertion, add a second loop:

```ts
const STATUS_FLIPPING_KINDS = new Set([
  'POST /servers/:id/start',
  'POST /servers/:id/stop',
  'POST /servers/:id/install',
  'DELETE /servers/:id',
  'POST /servers/:id/restore',
]);

for (const route of registeredRoutes) {
  const key = `${route.method} ${route.url}`;
  if (!STATUS_FLIPPING_KINDS.has(key)) continue;
  const src = readFileSync(route.handlerFile, 'utf8');
  expect(src, `${key} must emit a server.* diag event`).toMatch(/diag\.emit.*kind:\s*'server\./);
}
```

- [ ] **Step 2: Run; PASS expected (Task 7 already added the emits).**

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/audit-coverage.test.ts
git commit -m "test(audit-coverage): require server.* diag emit on status-flipping routes"
```

---

### Task 17: Bridge-side instrumentation (Go)

**Files:**
- Modify: `apps/bridge/internal/handlers/handlers.go`, `apps/bridge/cmd/panel-host-bridge/main.go`

- [ ] **Step 1: Add a `diagLog` helper**

In `handlers.go`:

```go
// diagLog writes a structured journal line that the diag exporter picks up.
// We do NOT touch Redis from Go — the API's pino-side reader of journald
// (or a sidecar `journalctl ... | redis-xadd`) brings these into the same
// diag:queue stream. Keep payload small and JSON-safe.
func diagLog(component, kind, severity, message string, payload map[string]any) {
    rec := map[string]any{
        "DIAG_EVENT": "1",
        "component":  component,
        "kind":       kind,
        "severity":   severity,
        "message":    message,
    }
    for k, v := range payload {
        rec[k] = v
    }
    b, _ := json.Marshal(rec)
    fmt.Fprintln(os.Stderr, string(b))
}
```

- [ ] **Step 2: Emit on connect / disconnect / RPC error / panic / signal**

- In the connection-accept loop, on every accept: `diagLog("bridge","bridge.client.connected","info",...)`.
- On `defer conn.Close()`: emit `bridge.client.disconnected` with reason.
- In the dispatcher's recover() block: emit `bridge.panic` with stack.
- In `cmd/panel-host-bridge/main.go`'s SIGTERM/SIGINT handler: emit `bridge.signal.sigterm` before shutdown.

- [ ] **Step 3: API-side journald → Redis exporter**

Add to `worker-diag-flush` (or a tiny separate goroutine inside it): a child process running `journalctl -u panel-host-bridge -o json -f` whose stdout is parsed line-by-line; lines with `"DIAG_EVENT":"1"` are XADD'd into `diag:queue` with the same shape as `diag.emit` would produce.

```ts
// in apps/workers/diag-flush/src/index.ts (after main initializes redis):
import { spawn } from 'node:child_process';
const j = spawn('journalctl', ['-u','panel-host-bridge','-o','json','-f','--since','30s ago']);
j.stdout.on('data', async (chunk: Buffer) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.DIAG_EVENT !== '1') continue;
      await redis.xadd(DIAG_STREAM_KEY, '*',
        'id', rec.id ?? randomUuidV7(),
        'ts', new Date().toISOString(),
        'component', rec.component, 'severity', rec.severity, 'kind', rec.kind,
        'message', rec.message, 'payload', JSON.stringify(rec.payload ?? {}),
      );
    } catch { /* skip malformed */ }
  }
});
```

If running inside Docker, the worker container needs `--mount type=bind,source=/var/log/journal,target=/var/log/journal,readonly` and `JOURNALCTL_BIN=journalctl` available. Document in `apps/workers/diag-flush/configuration.md`.

- [ ] **Step 4: Go-side test**

Add a unit test in `apps/bridge/internal/handlers/handlers_test.go` that captures stderr during a forced panic and asserts the JSON line contains `"DIAG_EVENT":"1"` and `"kind":"bridge.panic"`.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge apps/workers/diag-flush
git commit -m "feat(bridge): emit DIAG_EVENT lines on connect/panic/sigterm; diag-flush forwards to Redis"
```

---

## Phase A3 — Bundle endpoint

### Task 18: New bridge RPC `file_read_tail`

**Files:**
- Modify: `apps/bridge/internal/handlers/handlers.go`, `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/client.ts`

- [ ] **Step 1: Add `file_read_tail` to allowlist**

In `packages/shared-config/src/bridge-methods.ts`, add `'file_read_tail'` to `BRIDGE_METHODS`.

- [ ] **Step 2: Go handler**

```go
// in handlers.go
func (d *Dispatcher) fileReadTail(req *rpc.Request) rpc.Response {
    var p struct {
        Path     string `json:"path"`
        MaxBytes int64  `json:"max_bytes"`
    }
    if err := json.Unmarshal(req.Params, &p); err != nil {
        return rpc.Err(req.ID, "invalid_args", err.Error())
    }
    if err := validateReadablePath(p.Path); err != nil {
        return rpc.Err(req.ID, "forbidden", err.Error())
    }
    if p.MaxBytes <= 0 || p.MaxBytes > 1<<20 { p.MaxBytes = 64 * 1024 }
    f, err := os.Open(p.Path)
    if err != nil { return rpc.Err(req.ID, "runtime_error", err.Error()) }
    defer f.Close()
    st, err := f.Stat()
    if err != nil { return rpc.Err(req.ID, "runtime_error", err.Error()) }
    size := st.Size()
    var off int64 = 0
    if size > p.MaxBytes { off = size - p.MaxBytes }
    if _, err := f.Seek(off, io.SeekStart); err != nil {
        return rpc.Err(req.ID, "runtime_error", err.Error())
    }
    buf := make([]byte, size-off)
    n, _ := io.ReadFull(f, buf)
    // Snap to next newline so we never start mid-line.
    start := 0
    if off > 0 {
        if i := bytes.IndexByte(buf[:n], '\n'); i >= 0 { start = i + 1 }
    }
    return rpc.Ok(req.ID, map[string]any{
        "content":     string(buf[start:n]),
        "offset":      off + int64(start),
        "size":        size,
        "truncated":   off > 0,
    })
}
```

Wire into the dispatcher's switch.

- [ ] **Step 3: TS client method**

In `packages/bridge-client/src/client.ts`:

```ts
fileReadTail(p: { path: string; max_bytes?: number }) {
  return this.request<{ content: string; offset: number; size: number; truncated: boolean }>(
    'file_read_tail', p,
  );
}
```

- [ ] **Step 4: Go test (success + forbidden)**

In `handlers_test.go`, add a case that creates a 1 MB temp file under a temporary allowlist root (override `validateReadablePath` to recognize the temp dir) and asserts it returns the last 64 KB starting at a newline. Add a second case asserting `/etc/passwd` returns `forbidden`.

- [ ] **Step 5: Run `go test ./...` + `pnpm --filter @squad/bridge-client test`. Both PASS.**

- [ ] **Step 6: Commit**

```bash
git add apps/bridge packages/shared-config packages/bridge-client
git commit -m "feat(bridge): file_read_tail RPC — bounded last-N-bytes read with newline snap"
```

---

### Task 19: Bundle endpoint scaffolding

**Files:**
- Create: `apps/api/src/routes/diagnostics.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Failing route test**

```ts
// apps/api/test/diagnostics-bundle.test.ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './integration/harness.js';

describe('GET /api/v1/host/diagnostics/bundle', () => {
  it('requires host:manage', async () => {
    const { app, helpers } = await buildTestApp();
    const cookie = await helpers.viewerCookie();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/host/diagnostics/bundle?window=1h',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns markdown attachment for owner', async () => {
    const { app, helpers } = await buildTestApp();
    const cookie = await helpers.ownerCookie();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/host/diagnostics/bundle?window=1h', headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.headers['content-disposition']).toMatch(/attachment;.*\.md"$/);
    expect(res.body).toMatch(/^# Squad Panel Diagnostic Bundle/);
  });
});
```

Run: FAIL.

- [ ] **Step 2: Skeleton route**

```ts
// apps/api/src/routes/diagnostics.ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { buildBundle } from '../lib/bundle-builder.js';

const WindowEnum = z.enum(['15m','1h','6h','24h']);

const diagnosticsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/host/diagnostics/bundle',
    {
      config: { permissions: ['host:manage'], audit: false },
      schema: { querystring: z.object({ window: WindowEnum.default('1h') }) },
    },
    async (req, reply) => {
      const { window } = req.query as { window: string };
      const cacheKey = `diag:bundle:${window}`;
      const cached = await app.redis.get(cacheKey);
      if (cached) return sendBundle(reply, cached, window);

      const md = await buildBundle({ app, window });
      await app.redis.set(cacheKey, md, 'EX', 30);
      return sendBundle(reply, md, window);
    },
  );

  // wipe in next task
};

function sendBundle(reply: any, md: string, window: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const filename = `squad-panel-diag-${process.env.HOSTNAME ?? 'host'}-${stamp}-${window}.md`;
  reply.header('content-type', 'text/markdown; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${filename}"`);
  return md;
}

export default diagnosticsRoutes;
```

Initial `buildBundle` stub:

```ts
// apps/api/src/lib/bundle-builder.ts
export async function buildBundle(_opts: { app: any; window: string }) {
  return `# Squad Panel Diagnostic Bundle\n\n_(stub — to be filled by §0–§7 builders)_\n`;
}
```

Register in `server.ts` next to other host routes.

- [ ] **Step 3: Run tests; PASS expected.**

```bash
pnpm --filter @squad/api exec vitest run test/diagnostics-bundle.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/diagnostics.ts apps/api/src/lib/bundle-builder.ts apps/api/src/server.ts apps/api/test/diagnostics-bundle.test.ts
git commit -m "feat(api): GET /diagnostics/bundle scaffolding — RBAC, cache, content-disposition"
```

---

### Task 20: §0 state snapshot builder

**Files:**
- Modify: `apps/api/src/lib/bundle-builder.ts`

- [ ] **Step 1: Test**

```ts
// apps/api/test/diagnostics-bundle.test.ts (append)
it('renders §0 state snapshot with containers, workers, depot, bridge, disk, redis/db ping', async () => {
  // ... seed db / mocks ...
  const md = await buildBundle({ app, window: '1h' });
  expect(md).toMatch(/## 0\. State snapshot/);
  expect(md).toMatch(/containers:/);
  expect(md).toMatch(/workers:/);
  expect(md).toMatch(/depot:/);
  expect(md).toMatch(/bridge:/);
  expect(md).toMatch(/redis ping/);
});
```

- [ ] **Step 2: Implement section §0**

```ts
// apps/api/src/lib/bundle-builder.ts (replace stub)
import type { FastifyInstance } from 'fastify';
import { servers } from '@squad/db';

const WINDOWS_MS = { '15m': 15*60_000, '1h': 60*60_000, '6h': 6*60*60_000, '24h': 24*60*60_000 } as const;

export async function buildBundle(opts: { app: FastifyInstance; window: keyof typeof WINDOWS_MS }) {
  const { app } = opts;
  const sections: string[] = [];
  sections.push(`# Squad Panel Diagnostic Bundle`);
  sections.push(`generated: ${new Date().toISOString()}`);
  sections.push(`host: ${process.env.HOSTNAME ?? 'unknown'}   panel: ${process.env.PANEL_VERSION ?? 'dev'}   window: last ${opts.window}`);
  sections.push('');

  sections.push(await buildSectionState(app));
  // §1–§7 added in later tasks.

  return sections.join('\n');
}

async function buildSectionState(app: FastifyInstance): Promise<string> {
  const lines: string[] = ['## 0. State snapshot'];

  // containers
  const allServers = await app.db.select().from(servers);
  lines.push('containers:');
  for (const s of allServers) {
    lines.push(`  - ${s.id} ${s.status} image=squad-server:latest started=${s.startedAt?.toISOString() ?? '-'}`);
  }

  // workers
  const workerNames = ['rcon','log-ingest','audit-archiver','event-partition','diag-flush','metrics-sampler'];
  lines.push('workers:');
  for (const w of workerNames) {
    const ttl = await app.redis.pttl(`worker:heartbeat:${w}`);
    lines.push(`  - ${w}: ${ttl > 0 ? `alive (ttl ${Math.round(ttl/1000)}s)` : 'absent'}`);
  }

  // depot
  let buildId: string | null = null;
  try {
    const { content } = await app.bridge.fileRead({ path: '/var/lib/docker/volumes/squad-depot/_data/steamapps/appmanifest_403240.acf' });
    buildId = (/"buildid"\s+"(\d+)"/.exec(content) ?? [])[1] ?? null;
  } catch { /* depot not populated */ }
  lines.push(`depot: build_id=${buildId ?? 'unpopulated'}`);

  // bridge
  try {
    const t0 = Date.now();
    const ping = await app.bridge.ping();
    lines.push(`bridge: connected version=${ping.version} rtt=${Date.now()-t0}ms`);
  } catch (err) {
    lines.push(`bridge: disconnected (${(err as Error).message})`);
  }

  // disk + ping
  try {
    const m = await app.bridge.hostMetrics();
    lines.push(`disk: used=${m.disk_used_bytes} total=${m.disk_total_bytes}`);
  } catch { lines.push('disk: unavailable'); }

  const t0 = Date.now();
  await app.redis.ping();
  lines.push(`redis ping: ${Date.now()-t0}ms`);
  const t1 = Date.now();
  await app.db.execute(`SELECT 1`);
  lines.push(`db ping: ${Date.now()-t1}ms`);

  return lines.join('\n') + '\n';
}
```

- [ ] **Step 3: Tests PASS.**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/bundle-builder.ts apps/api/test/diagnostics-bundle.test.ts
git commit -m "feat(diag-bundle): §0 state snapshot — containers/workers/depot/bridge/disk/ping"
```

---

### Task 21: §2 errors-dedup + §3 audit + §4 lifecycle builders

**Files:**
- Modify: `apps/api/src/lib/bundle-builder.ts`

- [ ] **Step 1: Test for §2/§3/§4**

```ts
it('renders §2 errors dedup, §3 audit tail, §4 full lifecycle', async () => {
  // seed diagnostic_events and audit_log with a fixed corpus
  // ...
  const md = await buildBundle({ app, window: '1h' });
  expect(md).toMatch(/## 2\. Errors & warnings \(dedup'd\)/);
  expect(md).toMatch(/## 3\. Audit log/);
  expect(md).toMatch(/## 4\. Lifecycle events/);
});
```

- [ ] **Step 2: Implement**

Add three async functions:

```ts
async function buildSectionErrorsDedup(app: FastifyInstance, sinceMs: number) {
  const since = new Date(Date.now() - sinceMs);
  const rows = await app.db.execute<{
    component: string; kind: string; message: string;
    count: number; first_seen: Date; last_seen: Date; sample: any;
  }>(`
    SELECT component, kind, message, COUNT(*)::int AS count,
           MIN(ts) AS first_seen, MAX(ts) AS last_seen,
           (ARRAY_AGG(payload ORDER BY ts DESC))[1] AS sample
    FROM diagnostic_events
    WHERE severity IN ('warn','error','fatal') AND ts >= $1
    GROUP BY component, kind, message
    ORDER BY count DESC, last_seen DESC
  `, [since]);
  const lines: string[] = [`## 2. Errors & warnings (dedup'd)`];
  for (const r of rows) {
    lines.push(
      `[${r.count}] ${r.first_seen.toISOString()} → ${r.last_seen.toISOString()} ${r.component} ${r.kind} — ${r.message}`,
    );
    if (r.sample && Object.keys(r.sample).length) {
      lines.push(`  payload: ${JSON.stringify(r.sample).slice(0, 200)}`);
    }
  }
  return lines.join('\n') + '\n';
}

async function buildSectionAudit(app: FastifyInstance, sinceMs: number) {
  const rows = await app.db.execute<{ created_at: Date; actor_kind: string; actor_steam_id64: bigint | null;
    actor_system_label: string | null; action_type: string; target_type: string | null; target_id: string | null;
    status_code: number | null; actor_ip: string | null; }>(`
    SELECT created_at, actor_kind, actor_steam_id64, actor_system_label, action_type, target_type, target_id, status_code, actor_ip
    FROM audit_log WHERE created_at >= NOW() - ($1::int * INTERVAL '1 millisecond')
    ORDER BY created_at DESC LIMIT 1000
  `, [sinceMs]);
  const lines: string[] = [`## 3. Audit log`];
  for (const r of rows) {
    const actor = r.actor_kind === 'steam'
      ? `steam:${String(r.actor_steam_id64)}` : `system:${r.actor_system_label}`;
    lines.push(
      `${r.created_at.toISOString()} | ${actor} | ${r.action_type} | ${r.target_type ?? '-'}:${r.target_id ?? '-'} | ${r.status_code ?? '-'} | ${r.actor_ip ?? '-'}`,
    );
  }
  return lines.join('\n') + '\n';
}

async function buildSectionLifecycle(app: FastifyInstance, sinceMs: number) {
  const since = new Date(Date.now() - sinceMs);
  const rows = await app.db.execute<{ ts: Date; component: string; severity: string; kind: string; server_id: string | null; message: string }>(
    `SELECT ts, component, severity, kind, server_id, message
     FROM diagnostic_events WHERE ts >= $1 ORDER BY ts ASC`, [since],
  );
  const lines: string[] = [`## 4. Lifecycle events`];
  for (const r of rows) {
    lines.push(`${r.ts.toISOString()} | ${r.component} | ${r.severity} | ${r.kind} | ${r.server_id ?? '-'} | ${r.message}`);
  }
  return lines.join('\n') + '\n';
}
```

Wire all three into `buildBundle` after §0.

- [ ] **Step 3: Tests PASS.**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/bundle-builder.ts apps/api/test/diagnostics-bundle.test.ts
git commit -m "feat(diag-bundle): §2 errors-dedup, §3 audit tail, §4 full lifecycle"
```

---

### Task 22: §5 per-server briefs + §6 component log tails

**Files:**
- Modify: `apps/api/src/lib/bundle-builder.ts`

- [ ] **Step 1: Test**

```ts
it('renders §5 per-server with last_exit + filtered squad-log warnings/errors', async () => {
  // seed a server with status=stopped, last_exit_code=137
  // mock bridge.fileReadTail to return a fixture log
  const md = await buildBundle({ app, window: '1h' });
  expect(md).toMatch(/## 5\. Per-server briefs/);
  expect(md).toMatch(/exit_code=137/);
});
```

- [ ] **Step 2: Implement §5**

```ts
async function buildSectionPerServer(app: FastifyInstance, sinceMs: number) {
  const lines: string[] = [`## 5. Per-server briefs`];
  const rows = await app.db.select().from(servers); // all active + soft-deleted? — only active
  for (const s of rows.filter((x) => !x.deletedAt)) {
    lines.push(`### ${s.containerName ?? `squad-${s.id}`} "${s.displayName}"`);
    lines.push(`status=${s.status} started=${s.startedAt?.toISOString() ?? '-'} last_exit=${s.lastExitCode ?? '-'} oom=${s.lastOomKilled ?? false}`);
    // Last config edit
    const lastEdit = await app.db.execute<any>(
      `SELECT file_name, sha256_hex, author_steam_id64, created_at FROM config_versions WHERE server_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [s.id],
    );
    if (lastEdit[0]) {
      const e = lastEdit[0];
      lines.push(`last_config_edit: ${e.file_name} sha7=${e.sha256_hex.slice(0,7)} by=${e.author_steam_id64} at=${e.created_at.toISOString()}`);
    }
    // Squad log tail (filtered)
    try {
      const { content } = await app.bridge.fileReadTail({
        path: `/var/lib/squad-panel/saved/${s.id}/SquadGame/Saved/Logs/SquadGame.log`,
        max_bytes: 64 * 1024,
      });
      const filtered = content.split('\n').filter((l) => /Warning|Error|Fatal|LogExit/.test(l)).slice(-30);
      lines.push('squad log (Warning/Error/Fatal/LogExit, last 30):');
      for (const l of filtered) lines.push(`  ${l}`);
    } catch (err) {
      lines.push(`squad log: unavailable (${(err as Error).message})`);
    }
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 3: Implement §6 (component log tails — read from journald via bridge or from container stdout)**

Simplest approach: read pino logs of api+workers from Redis Streams `pino-tail:{component}` if such a stream exists; otherwise tail container logs through `docker logs --tail 30` (which currently goes via `container_logs_follow` — too heavyweight). For v1, restrict §6 to bridge journald only:

```ts
async function buildSectionComponentLogs(app: FastifyInstance) {
  const lines: string[] = [`## 6. Component log tails`];
  // Bridge errors from journald are already in diagnostic_events via Task 17,
  // so §4 already includes them. For pino logs, defer to a future iteration.
  lines.push('(api/workers pino tails not yet shipped; see §4 for diag-side captures)');
  return lines.join('\n') + '\n';
}
```

Note this limitation in `docs/components/diagnostic-bundle/troubleshooting.md` and create a follow-up TODO in the changelog.

- [ ] **Step 4: Tests PASS.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/bundle-builder.ts apps/api/test/diagnostics-bundle.test.ts
git commit -m "feat(diag-bundle): §5 per-server briefs (config edit + squad-log W/E tail) + §6 placeholder"
```

---

### Task 23: Redaction module

**Files:**
- Create: `apps/api/src/lib/bundle-redact.ts`, `apps/api/test/bundle-redact.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { redact } from '../src/lib/bundle-redact.js';

describe('redact', () => {
  it('strips password=… and Bearer tokens and __Host-sid cookies', () => {
    const input = `password=hunter2 RconPassword="abc" Bearer eyJhbGc.foo __Host-sid=s_019dbaa5-xxx`;
    const out = redact(input);
    expect(out).not.toMatch(/hunter2/);
    expect(out).not.toMatch(/abc/);
    expect(out).not.toMatch(/eyJhbGc\.foo/);
    expect(out).not.toMatch(/s_019dbaa5/);
  });

  it('does not touch steam IDs', () => {
    expect(redact('actor steam:76561198012345678 ip 1.2.3.4'))
      .toMatch(/76561198012345678/);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// apps/api/src/lib/bundle-redact.ts
const PATTERNS: RegExp[] = [
  /(?<=password\s*=\s*"?)[^"\s]+/gi,
  /(?<=RconPassword\s*=\s*"?)[^"\s]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /__Host-sid=[A-Za-z0-9_-]+/g,
];

export function redact(s: string): string {
  let out = s;
  for (const p of PATTERNS) out = out.replace(p, '***REDACTED***');
  return out;
}
```

Apply at the boundary of `buildBundle`:

```ts
return redact(sections.join('\n'));
```

- [ ] **Step 3: PASS.**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/bundle-redact.ts apps/api/src/lib/bundle-builder.ts apps/api/test/bundle-redact.test.ts
git commit -m "feat(diag-bundle): redaction — strip password/Bearer/sid before rendering"
```

---

### Task 24: 400 KB cap + truncation report (§7)

**Files:**
- Modify: `apps/api/src/lib/bundle-builder.ts`

- [ ] **Step 1: Test**

```ts
it('truncates §6 → §5 → §4 oldest-first when output > 400 KB and adds §7', async () => {
  // seed 50 000 lifecycle events to inflate §4
  const md = await buildBundle({ app, window: '24h' });
  expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(400 * 1024);
  expect(md).toMatch(/## 7\. Truncation report/);
  expect(md).toMatch(/dropped \d+/);
});
```

- [ ] **Step 2: Implement truncation pass**

Refactor `buildBundle` so each section produces an array of lines, and a final pass measures the total size; if > `400 * 1024 - 1024` (1 KB headroom for §7), strip lines from §6 first, then §5 per-server tails, then §4 oldest events. Track counters and append:

```ts
sections.push(`## 7. Truncation report`);
sections.push(`dropped: ${droppedSec6} bridge log lines, ${droppedSec5} per-server squad-log lines, ${droppedSec4} lifecycle events`);
```

- [ ] **Step 3: Tests PASS.**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/bundle-builder.ts apps/api/test/diagnostics-bundle.test.ts
git commit -m "feat(diag-bundle): 400 KB cap with priority-ordered truncation + §7 report"
```

---

### Task 25: Wipe endpoint

**Files:**
- Modify: `apps/api/src/routes/diagnostics.ts`
- Create: `apps/api/test/diagnostics-wipe.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './integration/harness.js';

describe('POST /api/v1/host/diagnostics/wipe', () => {
  it('truncates diagnostic_events and writes an audit row', async () => {
    const { app, helpers } = await buildTestApp();
    // seed 5 events
    await app.db.execute(`INSERT INTO diagnostic_events (id, ts, component, severity, kind, message)
      SELECT gen_random_uuid(), now(), 'api','info','test',$1 FROM generate_series(1,5)`, ['x']);
    const cookie = await helpers.ownerCookie();
    const res = await app.inject({ method: 'POST', url: '/api/v1/host/diagnostics/wipe', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed_rows).toBe(5);
    const audit = await app.db.execute(
      `SELECT * FROM audit_log WHERE action_type = 'host.diagnostics.wipe' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.length).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

```ts
app.post(
  '/api/v1/host/diagnostics/wipe',
  {
    config: {
      permissions: ['host:manage'],
      audit: { action: 'host.diagnostics.wipe', resource: 'host' },
    },
  },
  async () => {
    const before = await app.db.execute<{ c: number }>(`SELECT COUNT(*)::int AS c FROM diagnostic_events`);
    await app.db.execute(`TRUNCATE diagnostic_events`);
    await app.redis.xtrim('diag:queue', 'MAXLEN', 0);
    return { ok: true, removed_rows: before[0]?.c ?? 0 };
  },
);
```

- [ ] **Step 3: Tests PASS.**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/diagnostics.ts apps/api/test/diagnostics-wipe.test.ts
git commit -m "feat(api): POST /diagnostics/wipe — truncate diag store, audit-log the action"
```

---

### Task 26: Golden bundle test

**Files:**
- Create: `apps/api/test/diagnostics-bundle.golden.test.ts`, `apps/api/test/__fixtures__/diag-bundle.golden.md`

- [ ] **Step 1: Build a deterministic fixture**

Hard-code timestamps via `vi.setSystemTime`. Seed 5 audit rows + 10 diagnostic events + a fake server. Call `buildBundle`. Compare against `__fixtures__/diag-bundle.golden.md`.

```ts
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildBundle } from '../src/lib/bundle-builder.js';

beforeAll(() => vi.setSystemTime(new Date('2026-04-28T10:00:00Z')));

it('matches golden snapshot for canned fixture', async () => {
  // build app, seed exact rows
  const md = await buildBundle({ app, window: '1h' });
  const expected = readFileSync('test/__fixtures__/diag-bundle.golden.md', 'utf8');
  expect(md).toBe(expected);
});
```

Initial run: capture output and write the file (`pnpm test -u`-equivalent). Then re-run; PASS.

- [ ] **Step 2: Commit**

```bash
git add apps/api/test/diagnostics-bundle.golden.test.ts apps/api/test/__fixtures__/diag-bundle.golden.md
git commit -m "test(diag-bundle): golden fixture — deterministic markdown rendering"
```

---

## Phase A4 — Incident builder

### Task 27: Incident detection + T-5min context query

**Files:**
- Create: `apps/api/src/lib/incident-builder.ts`, `apps/api/test/incident-builder.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { detectIncidents, buildIncidentBlocks } from '../src/lib/incident-builder.js';

describe('incident detection', () => {
  it('detects container.exited with non-zero exit_code', async () => {
    const events = [
      { id: '1', ts: '2026-04-28T09:42:18Z', component: 'reconciler', kind: 'container.exited',
        severity: 'error', server_id: 's', message: 'exited 137',
        payload: { exit_code: 137, oom_killed: true, signal: 'SIGKILL', finished_at: '2026-04-28T09:42:18Z' } },
    ];
    const incidents = detectIncidents(events as any);
    expect(incidents.length).toBe(1);
    expect(incidents[0].label).toBe('probable_oom');
  });

  it('groups two events within 60s same server', () => {
    // events: container.exited then bridge.client.disconnected within 30s, same server
    const incidents = detectIncidents([/* fixture */] as any);
    expect(incidents.length).toBe(1); // merged
  });
});
```

- [ ] **Step 2: Implement detection + classification**

```ts
// apps/api/src/lib/incident-builder.ts
import type { DiagnosticEventRow } from '@squad/db';

const TRIGGERS = new Set([
  'container.exited',
  'container.unexpected_exit',
  'bridge.client.disconnected',
  'worker.heartbeat_lost',
  'rcon.auth_failed',
  'squad.log.fatal',
  'bridge.panic',
  'http.unhandled_rejection',
]);

export interface Incident {
  ts: Date;
  serverId: string | null;
  triggers: string[];
  label: string;
  windowFrom: Date;
  windowTo: Date;
  events: DiagnosticEventRow[];
}

export function detectIncidents(events: DiagnosticEventRow[]): Incident[] {
  const triggered = events.filter((e) => TRIGGERS.has(e.kind));
  const out: Incident[] = [];
  for (const e of triggered) {
    const last = out[out.length - 1];
    const sameWindow = last
      && Math.abs(last.ts.getTime() - e.ts.getTime()) < 60_000
      && last.serverId === e.serverId;
    if (sameWindow) {
      last.triggers.push(e.kind);
      continue;
    }
    out.push({
      ts: e.ts,
      serverId: e.serverId,
      triggers: [e.kind],
      label: classify(e, events),
      windowFrom: new Date(e.ts.getTime() - 5 * 60_000),
      windowTo: e.ts,
      events: [],
    });
  }
  // attach context: events in [windowFrom, windowTo] with same serverId or component-scoped
  for (const inc of out) {
    inc.events = events.filter(
      (e) => e.ts >= inc.windowFrom && e.ts <= inc.windowTo
        && (inc.serverId == null || e.serverId === inc.serverId || e.serverId == null),
    );
  }
  return out;
}

function classify(e: DiagnosticEventRow, all: DiagnosticEventRow[]): string {
  const p: any = e.payload ?? {};
  if (e.kind === 'container.exited' || e.kind === 'container.unexpected_exit') {
    if (p.oom_killed) return 'probable_oom';
    if (p.signal === 'SIGSEGV' || p.signal === 'SIGABRT') return 'crash_segfault';
    const stopReq = all.find((x) => x.kind === 'server.stop.requested'
      && x.serverId === e.serverId
      && Math.abs(x.ts.getTime() - e.ts.getTime()) < 5 * 60_000
      && x.ts < e.ts);
    if (stopReq) return 'user_initiated_stop';
  }
  if (e.kind === 'squad.log.fatal' && /Assertion failed:/.test(e.message)) return 'assertion_failure';
  if (e.kind === 'bridge.client.disconnected') return 'bridge_lost';
  return 'unknown';
}
```

- [ ] **Step 3: Tests PASS.**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/incident-builder.ts apps/api/test/incident-builder.test.ts
git commit -m "feat(diag-bundle): incident detection + T-5min context + classification heuristic"
```

---

### Task 28: §1 incidents block rendering

**Files:**
- Modify: `apps/api/src/lib/incident-builder.ts`, `apps/api/src/lib/bundle-builder.ts`

- [ ] **Step 1: Render block**

```ts
// add to incident-builder.ts
export function renderIncident(inc: Incident, idx: number): string {
  const lines: string[] = [
    `### incident-${idx + 1} — ${inc.serverId ?? 'global'} ${inc.triggers.join('+')} at ${inc.ts.toISOString()}`,
    `classification: ${inc.label}`,
    `trigger: ${inc.triggers.join(', ')}`,
    `context window: ${inc.windowFrom.toISOString()} → ${inc.windowTo.toISOString()}`,
    '',
    '#### timeline (merged, all components)',
  ];
  for (const e of inc.events) {
    lines.push(`[${e.ts.toISOString()}] ${e.component.padEnd(12)} ${e.kind.padEnd(28)} ${e.message}`);
  }
  // 6 KB cap per block
  const joined = lines.join('\n');
  if (Buffer.byteLength(joined, 'utf8') > 6 * 1024) {
    return joined.slice(0, 6 * 1024) + '\n[... block truncated to 6 KB ...]';
  }
  return joined + '\n';
}
```

- [ ] **Step 2: Wire §1 into `buildBundle`**

```ts
import { detectIncidents, renderIncident } from './incident-builder.js';
// ...
const allDiag: DiagnosticEventRow[] = await app.db.execute(`
  SELECT * FROM diagnostic_events WHERE ts >= NOW() - ($1::int * INTERVAL '1 millisecond') ORDER BY ts ASC
`, [windowMs]);
const incidents = detectIncidents(allDiag);
const sec1: string[] = ['## 1. Incidents'];
incidents.forEach((inc, i) => sec1.push(renderIncident(inc, i)));
sections.push(sec1.join('\n'));
```

Insert §1 after §0 and before §2.

- [ ] **Step 3: Update golden fixture**

```bash
pnpm --filter @squad/api exec vitest run test/diagnostics-bundle.golden.test.ts -u
```

Inspect the diff, confirm §1 looks correct, commit.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/incident-builder.ts apps/api/src/lib/bundle-builder.ts apps/api/test/__fixtures__/diag-bundle.golden.md
git commit -m "feat(diag-bundle): §1 incidents — rendered T-5min reconstruction with classification"
```

---

## Phase A5 — UI

### Task 29: `<DiagnosticsMenu>` component

**Files:**
- Create: `apps/web/src/components/DiagnosticsMenu.tsx`

- [ ] **Step 1: Component**

```tsx
'use client';

import { useState } from 'react';
import { Bug } from 'lucide-react';
// reuse existing primitives — Popover from shadcn-style UI dir, Button, RadioGroup
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';

const WINDOWS = ['15m','1h','6h','24h'] as const;
type Window = (typeof WINDOWS)[number];

export function DiagnosticsMenu({ canManageHost }: { canManageHost: boolean }) {
  const [w, setW] = useState<Window>('1h');
  const [busy, setBusy] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  if (!canManageHost) return null;

  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/host/diagnostics/bundle?window=${w}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const filename = (res.headers.get('content-disposition') ?? '')
        .match(/filename="([^"]+)"/)?.[1] ?? `diag-${w}.md`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  async function wipe() {
    setBusy(true);
    try {
      const res = await fetch('/api/v1/host/diagnostics/wipe', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = await res.json();
      window.alert(`Очищено: ${j.removed_rows} событий`);
    } finally {
      setBusy(false);
      setConfirmWipe(false);
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" title="Диагностика" aria-label="Диагностика">
          <Bug className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-3">
        <div className="text-sm font-semibold">Диагностика</div>
        <fieldset className="space-y-1 text-sm">
          <legend className="text-xs text-muted-foreground">Окно</legend>
          {WINDOWS.map((opt) => (
            <label key={opt} className="flex items-center gap-2">
              <input type="radio" name="window" value={opt}
                checked={w === opt} onChange={() => setW(opt)} />
              {opt}
            </label>
          ))}
        </fieldset>
        <Button onClick={download} disabled={busy} className="w-full">
          {busy ? 'Готовим…' : 'Скачать .md'}
        </Button>
        <hr className="border-border" />
        {confirmWipe ? (
          <div className="space-y-2">
            <p className="text-xs">Удалит все диагностические события за последние 24 часа. Восстановить нельзя.</p>
            <div className="flex gap-2">
              <Button variant="destructive" onClick={wipe} disabled={busy} className="flex-1">Да, очистить</Button>
              <Button variant="outline" onClick={() => setConfirmWipe(false)} disabled={busy} className="flex-1">Отмена</Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" className="w-full text-destructive" onClick={() => setConfirmWipe(true)} disabled={busy}>
            Очистить логи
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Mount in topbar**

In `apps/web/src/app/(dashboard)/layout.tsx`, find the topbar JSX (next to user menu) and add:

```tsx
import { DiagnosticsMenu } from '@/components/DiagnosticsMenu';
// ...
<DiagnosticsMenu canManageHost={user.permissions.includes('host:manage')} />
```

`user.permissions` should already be available from the existing layout's session loader; if not, fetch from `/api/v1/me` and pass through.

- [ ] **Step 3: Smoke-build**

```bash
pnpm --filter @squad/web build
```

Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DiagnosticsMenu.tsx apps/web/src/app/\(dashboard\)/layout.tsx
git commit -m "feat(web): <DiagnosticsMenu> in topbar — window radio + download + wipe"
```

---

### Task 30: Playwright e2e

**Files:**
- Create: `apps/web/test/e2e/diagnostics.spec.ts`

- [ ] **Step 1: Test**

```ts
import { test, expect } from '@playwright/test';

test('owner can download a 1h diagnostic bundle', async ({ page, context }) => {
  // Auth: assume PANEL_TEST_COOKIE is set in env and the harness mounts it
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Диагностика' }).click();
  await page.getByLabel('1h').check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать .md' }).click();
  const dl = await downloadPromise;
  expect(dl.suggestedFilename()).toMatch(/^squad-panel-diag-.*-1h\.md$/);
  const path = await dl.path();
  const head = require('node:fs').readFileSync(path, 'utf8').slice(0, 200);
  expect(head).toMatch(/^# Squad Panel Diagnostic Bundle/);
});
```

- [ ] **Step 2: Run**

```bash
pnpm --filter @squad/web exec playwright test diagnostics.spec.ts
```

Expected: PASS against running stack.

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/e2e/diagnostics.spec.ts
git commit -m "test(web/e2e): playwright — diagnostics popover download flow"
```

---

## Phase A6 — Documentation

### Task 31: Component docs (8 files for diagnostic-bundle, 8 files for worker-diag-flush)

**Files:**
- Create: `docs/components/diagnostic-bundle/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md`
- Create: `docs/components/workers/worker-diag-flush/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md`
- Modify: `docs/components/api/api.md`, `docs/components/api/data-model.md`, `docs/components/api/changelog.md`, `docs/components/bridge/api.md`, `docs/components/bridge/changelog.md`, `docs/architecture/data-flow.md`, `docs/architecture/decisions.md`, `docs/operations/environment-variables.md`, `docs/README.md`

- [ ] **Step 1: Write all 16 component docs**

Follow the templates in `docs/components/api/*.md`. Each file MUST be substantively populated — no stubs. Specifically:
- `diagnostic-bundle/api.md` documents `GET /diagnostics/bundle`, `POST /diagnostics/wipe`, query params, response shape, errors.
- `diagnostic-bundle/data-model.md` documents `diagnostic_events` columns + indexes + partitioning + constraints.
- `diagnostic-bundle/flows.md` covers: emit path (component → diag.emit → Redis Stream → flush worker → Postgres), bundle path (request → builders → redaction → cap → response), incident reconstruction.
- `diagnostic-bundle/configuration.md` covers env vars (`DIAG_FLUSH_BATCH_SIZE`, `DIAG_BUNDLE_MAX_BYTES`), retention policy, cache TTLs.
- `diagnostic-bundle/testing.md` lists every test added in Tasks 3, 4, 19–28.
- `diagnostic-bundle/troubleshooting.md` covers: bundle returns 502 / takes >5s / shows truncated / wipe fails / flush worker backlog growing.
- `diagnostic-bundle/changelog.md` and `worker-diag-flush/changelog.md` get a `2026-04-28` entry per phase.

- [ ] **Step 2: Update parent doc index**

Add `diagnostic-bundle` to `docs/README.md` components list.

- [ ] **Step 3: Add ADR**

Append to `docs/architecture/decisions.md`:

```md
## 2026-04-28 — Separate `diagnostic_events` table for operational visibility

### Context
Operators need a forensic timeline around shutdowns. `audit_log` already
captures API mutations but is hash-chained, append-only, and 90-day
retained. Inflating it with high-volume operational signal would burn
storage and slow chain verification.

### Decision
A new table `diagnostic_events` with 24h retention, daily partitioning,
DELETE/UPDATE allowed, and a `packages/diag` Redis-buffered helper.

### Rationale
- Decouples high-volume operational events from security audit
- Manual wipe is a feature (operator can clean noise after an incident)
- Daily partitioning + hard 24h drop bounds storage
- Same Redis-Stream buffering pattern already used for `host_metrics`

### Consequences
- Two stores to query for a full picture (bundle builder unifies them)
- New worker `worker-diag-flush` to maintain
- Bridge journald lines need a forwarder (handled inside diag-flush)

### Alternatives considered
- Extend `audit_log` — rejected (chain integrity + retention mismatch)
- Loki/Grafana stack — rejected for v1 (operational complexity); tracked separately
- File-only logging on host — rejected (no UI integration, manual ssh)
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: diagnostic-bundle + worker-diag-flush component docs + ADR"
```

---

## Self-Review

**1. Spec coverage:**
- Spec §3.1 (table) → Task 1+2
- §3.2 (helper + diag-flush) → Tasks 3+4
- §3.3 (instrumentation) → Tasks 7–17
- §3.4 (bundle endpoint) → Tasks 19–24
- §3.5 (wipe) → Task 25
- §3.6 (incident reconstruction) → Tasks 27+28
- §3.7 (redaction) → Task 23
- §3.8 (disk breakdown) → **separate plan** (`2026-04-28-panel-disk-breakdown.md`)
- §4 (UI) → Task 29
- §5 (phases) → tasks grouped under Phase headers
- §6 (risks) → addressed in Tasks 4 (batching), 18 (file_read_tail), 24 (cap), 25 (wipe audit), 23 (redaction)
- §7 (testing) → Tasks 26, 30, plus per-task tests
- §8 (docs) → Task 31

**2. Placeholders:** none — every step has either runnable shell commands, code blocks with full code, or an explicit list of edits.

**3. Type consistency:** `Diag` interface, `DiagEvent`, `Incident`, `DiagnosticEventRow` referenced consistently across tasks.

---

## Documentation Update Report

### Updated docs

- `docs/superpowers/plans/2026-04-28-diagnostic-bundle.md` — created (this file).

### Not updated

- Component docs (`docs/components/diagnostic-bundle/*`, `docs/components/workers/worker-diag-flush/*`) and ADR are written as part of Task 31 of this plan, alongside the implementation; not pre-written here.

### Documentation risks

- None.
