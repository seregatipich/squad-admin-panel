# Epic 5: Squad Server Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining ~25% of Epic 5 — server create wizard, settings editor, force-stop, coordinated depot update, A2S query, crash detection, container metrics, license management, tags UI, per-server update, and performance monitoring.

**Architecture:** All P0 backend features build on existing bridge RPC, Drizzle ORM, and Fastify route patterns. New Redis keys store ephemeral state (A2S status, crash history, container metrics streams). Frontend uses existing Next.js 15 App Router + `'use client'` pages with `fetch()` polling. No new external dependencies — A2S uses Node `dgram`, charts use inline SVG/CSS.

**Tech Stack:** TypeScript (Fastify 5, Next.js 15, React 19), Zod, Drizzle ORM, Redis Streams, Go bridge (no changes needed), Vitest, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-05-05-epic5-server-management-design.md`

---

## File Structure

### New Files

```
packages/shared-types/src/server-settings.ts     — Zod schemas for settings update, A2S, crash, metrics
apps/api/src/routes/server-settings.ts            — PUT /servers/:id/settings + PATCH /servers/:id
apps/api/src/routes/server-force-stop.ts          — POST /servers/:id/force-stop
apps/api/src/routes/server-metrics.ts             — GET /servers/:id/metrics
apps/api/src/routes/server-update.ts              — POST /servers/:id/update + WS (P1)
apps/workers/rcon/src/a2s.ts                      — A2S_INFO UDP query implementation
apps/web/src/app/(dashboard)/servers/new/page.tsx  — Create wizard
apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx — Settings editor
apps/web/src/app/(dashboard)/servers/[id]/monitoring/page.tsx — Metrics charts
apps/web/src/components/ForceStopDialog.tsx        — Force-stop confirmation
apps/web/src/components/DepotUpdateModal.tsx       — Coordinated update modal
apps/web/src/components/CrashBadge.tsx             — Crash/crash-loop indicator
apps/web/src/components/A2SIndicator.tsx           — Steam visibility globe
apps/web/src/components/MetricsChart.tsx           — SVG time-series chart
apps/web/src/components/TagInput.tsx               — Tag input with chips (P1)

apps/api/test/server-settings.test.ts             — Settings endpoint tests
apps/api/test/server-force-stop.test.ts           — Force-stop endpoint tests
apps/api/test/server-metrics.test.ts              — Metrics endpoint tests
apps/api/test/crash-detection.test.ts             — Crash detection tests
apps/api/test/depot-coordinated.test.ts           — Coordinated depot update tests
apps/workers/rcon/test/a2s.test.ts                — A2S parser unit tests
```

### Modified Files

```
packages/shared-types/src/api.ts                  — Export new schemas
apps/api/src/server.ts                            — Register new route modules
apps/api/src/routes/servers.ts                    — Add a2s_status, crash fields to GET responses
apps/api/src/routes/depot.ts                      — Enhanced POST /update with serverIds
apps/api/src/plugins/status-reconciler.ts         — Crash detection + crash loop logic
apps/api/src/plugins/live-bus.ts                  — Add crash event types
apps/workers/rcon/src/supervisor.ts               — A2S polling alongside RCON
apps/workers/metrics-sampler/src/sampler.ts       — Per-server container_stats collection
apps/web/src/app/(dashboard)/dashboard/page.tsx   — A2S indicator, crash badge on server cards
apps/web/src/app/(dashboard)/servers/[id]/page.tsx — Force-stop dropdown, new tab links, crash section
apps/web/src/app/(dashboard)/servers/page.tsx     — Link to /servers/new
```

---

## Task 1: Shared Types for New Features

**Files:**
- Create: `packages/shared-types/src/server-settings.ts`
- Modify: `packages/shared-types/src/api.ts`

- [ ] **Step 1: Create Zod schemas for settings update**

```typescript
// packages/shared-types/src/server-settings.ts
import { z } from 'zod';

export const serverSettingsUpdate = z
  .object({
    game_port: z.number().int().min(1024).max(65_535).optional(),
    query_port: z.number().int().min(1024).max(65_535).optional(),
    beacon_port: z.number().int().min(1024).max(65_535).optional(),
    rcon_port: z.number().int().min(1024).max(65_535).optional(),
    max_players: z.number().int().min(1).max(100).optional(),
    tickrate: z.number().int().min(10).max(60).optional(),
    multihome: z.string().nullable().optional(),
    extra_args: z.string().optional(),
    cpu_affinity: z.string().nullable().optional(),
    cpu_weight: z.number().int().min(1).max(10_000).nullable().optional(),
    niceness: z.number().int().min(-20).max(19).nullable().optional(),
    memory_high_mb: z.number().int().min(2048).nullable().optional(),
    memory_max_mb: z.number().int().min(2048).nullable().optional(),
    io_weight: z.number().int().min(10).max(1000).nullable().optional(),
  })
  .strict()
  .refine(
    (d) => {
      const ports = [d.game_port, d.query_port, d.beacon_port, d.rcon_port].filter(
        (p) => p !== undefined,
      );
      return new Set(ports).size === ports.length;
    },
    { message: 'Ports must be unique' },
  );
export type ServerSettingsUpdate = z.infer<typeof serverSettingsUpdate>;

export const serverPatch = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    license_id: z.string().max(200).nullable().optional(),
    license_key: z.string().max(500).nullable().optional(),
  })
  .strict();
export type ServerPatch = z.infer<typeof serverPatch>;

export const a2sStatus = z
  .object({
    visible: z.boolean(),
    server_name: z.string().optional(),
    map: z.string().optional(),
    players: z.number().int().optional(),
    max_players: z.number().int().optional(),
    latency_ms: z.number().optional(),
    reason: z.string().optional(),
    queried_at: z.string().datetime(),
  })
  .strict();
export type A2SStatus = z.infer<typeof a2sStatus>;

export const crashEntry = z.object({
  timestamp: z.string().datetime(),
  exit_code: z.number().int(),
  oom_killed: z.boolean(),
  restart_count: z.number().int(),
});
export type CrashEntry = z.infer<typeof crashEntry>;

export const metricsPoint = z.object({
  timestamp: z.string(),
  cpu_percent: z.number(),
  mem_bytes: z.number(),
  mem_percent: z.number(),
  pids: z.number().int(),
  tickrate: z.number().optional(),
});
export type MetricsPoint = z.infer<typeof metricsPoint>;
```

- [ ] **Step 2: Re-export from api.ts**

Add to end of `packages/shared-types/src/api.ts`:

```typescript
export {
  serverSettingsUpdate,
  type ServerSettingsUpdate,
  serverPatch,
  type ServerPatch,
  a2sStatus,
  type A2SStatus,
  crashEntry,
  type CrashEntry,
  metricsPoint,
  type MetricsPoint,
} from './server-settings.js';
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/shared-types`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared-types/src/server-settings.ts packages/shared-types/src/api.ts
git commit -m "feat(shared-types): add Zod schemas for settings, A2S, crash, metrics"
```

---

## Task 2: Server Settings API Endpoints

**Files:**
- Create: `apps/api/src/routes/server-settings.ts`
- Create: `apps/api/test/server-settings.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the failing test for PUT /servers/:id/settings**

```typescript
// apps/api/test/server-settings.test.ts
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { servers, serverSettings, serverCredentials } from '@squad/db/schema';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER = 76561198000000001n;

async function seedServer(h: IntegrationHarness, status = 'stopped') {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: 'Test Server',
    slug: `test-${id.slice(0, 8)}`,
    status,
    runtime: 'container',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.from('test'),
    keyVersion: 1,
  });
  return id;
}

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('PUT /api/v1/servers/:id/settings', () => {
  it('updates max_players and tickrate on a stopped server', async () => {
    const id = await seedServer(h, 'stopped');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/settings`,
      headers: { cookie },
      payload: { max_players: 80, tickrate: 30 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.max_players).toBe(80);
    expect(body.tickrate).toBe(30);
  });

  it('rejects port change on a running server', async () => {
    const id = await seedServer(h, 'running');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/settings`,
      headers: { cookie },
      payload: { game_port: 7788 },
    });

    expect(res.statusCode).toBe(409);
  });

  it('rejects duplicate ports across servers', async () => {
    const id1 = await seedServer(h, 'stopped');
    const id2 = await seedServer(h, 'stopped');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id1}/settings`,
      headers: { cookie },
      payload: { game_port: 27165 },
    });

    expect(res.statusCode).toBe(409);
  });

  it('allows resource limits on a running server', async () => {
    const id = await seedServer(h, 'running');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/settings`,
      headers: { cookie },
      payload: { memory_high_mb: 4096 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().memory_high_mb).toBe(4096);
  });
});

describe('PATCH /api/v1/servers/:id', () => {
  it('updates display_name and tags', async () => {
    const id = await seedServer(h);
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
      payload: { display_name: 'Renamed', tags: ['competitive', 'eu'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().display_name).toBe('Renamed');
    expect(res.json().tags).toEqual(['competitive', 'eu']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @squad/api exec vitest run test/server-settings.test.ts`
Expected: FAIL — route not registered

- [ ] **Step 3: Implement the settings route**

```typescript
// apps/api/src/routes/server-settings.ts
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { servers, serverSettings } from '@squad/db/schema';
import { serverSettingsUpdate, serverPatch } from '@squad/shared-types';

const idParams = z.object({ id: z.string().uuid() });

const PORT_FIELDS = ['game_port', 'query_port', 'beacon_port', 'rcon_port'] as const;
const RESOURCE_FIELDS = [
  'cpu_affinity',
  'cpu_weight',
  'niceness',
  'memory_high_mb',
  'memory_max_mb',
  'io_weight',
] as const;

const serverSettingsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.put(
    '/api/v1/servers/:id/settings',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.update_settings', resource: 'server' },
      },
      schema: { params: idParams, body: serverSettingsUpdate },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const body = req.body;
      const hasPortChange = PORT_FIELDS.some((f) => body[f] !== undefined);

      if (hasPortChange && !['stopped', 'ready'].includes(row.status)) {
        reply.code(409);
        return { error: 'server_must_be_stopped', message: 'Stop the server to change ports' };
      }

      if (hasPortChange) {
        const currentSettings = await app.db.query.serverSettings.findFirst({
          where: eq(serverSettings.serverId, req.params.id),
        });
        if (!currentSettings) {
          reply.code(404);
          return { error: 'settings_not_found' };
        }

        const proposed = {
          gamePort: body.game_port ?? currentSettings.gamePort,
          queryPort: body.query_port ?? currentSettings.queryPort,
          beaconPort: body.beacon_port ?? currentSettings.beaconPort,
          rconPort: body.rcon_port ?? currentSettings.rconPort,
        };

        const portValues = Object.values(proposed);
        if (new Set(portValues).size !== portValues.length) {
          reply.code(409);
          return { error: 'ports_must_be_unique' };
        }

        const conflict = await app.db.query.serverSettings.findFirst({
          where: and(
            ne(serverSettings.serverId, req.params.id),
            or(
              eq(serverSettings.gamePort, proposed.gamePort),
              eq(serverSettings.queryPort, proposed.queryPort),
              eq(serverSettings.beaconPort, proposed.beaconPort),
              eq(serverSettings.rconPort, proposed.rconPort),
            ),
          ),
        });
        if (conflict) {
          reply.code(409);
          return { error: 'port_conflict', conflicting_server_id: conflict.serverId };
        }

        const oldPorts = {
          gamePort: currentSettings.gamePort,
          queryPort: currentSettings.queryPort,
          beaconPort: currentSettings.beaconPort,
          rconPort: currentSettings.rconPort,
        };

        for (const [key, oldPort] of Object.entries(oldPorts)) {
          const newPort = proposed[key as keyof typeof proposed];
          if (oldPort !== newPort) {
            const proto = key === 'rconPort' ? 'tcp' : 'udp';
            await app.bridge.ufwRule({ action: 'delete', proto, port: oldPort }).catch(() => {});
            await app.bridge.ufwRule({ action: 'add', proto, port: newPort });
          }
        }
      }

      const setClause: Record<string, unknown> = {};
      if (body.game_port !== undefined) setClause.gamePort = body.game_port;
      if (body.query_port !== undefined) setClause.queryPort = body.query_port;
      if (body.beacon_port !== undefined) setClause.beaconPort = body.beacon_port;
      if (body.rcon_port !== undefined) setClause.rconPort = body.rcon_port;
      if (body.max_players !== undefined) setClause.maxPlayers = body.max_players;
      if (body.tickrate !== undefined) setClause.tickrate = body.tickrate;
      if (body.multihome !== undefined) setClause.multihome = body.multihome;
      if (body.extra_args !== undefined) setClause.extraArgs = body.extra_args;
      if (body.cpu_affinity !== undefined) setClause.cpuAffinity = body.cpu_affinity;
      if (body.cpu_weight !== undefined) setClause.cpuWeight = body.cpu_weight;
      if (body.niceness !== undefined) setClause.niceness = body.niceness;
      if (body.memory_high_mb !== undefined) setClause.memoryHighMb = body.memory_high_mb;
      if (body.memory_max_mb !== undefined) setClause.memoryMaxMb = body.memory_max_mb;
      if (body.io_weight !== undefined) setClause.ioWeight = body.io_weight;

      if (Object.keys(setClause).length > 0) {
        await app.db
          .update(serverSettings)
          .set(setClause)
          .where(eq(serverSettings.serverId, req.params.id));
      }

      const updated = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, req.params.id),
      });

      return {
        server_id: req.params.id,
        game_port: updated!.gamePort,
        query_port: updated!.queryPort,
        beacon_port: updated!.beaconPort,
        rcon_port: updated!.rconPort,
        max_players: updated!.maxPlayers,
        tickrate: updated!.tickrate,
        multihome: updated!.multihome,
        extra_args: updated!.extraArgs,
        cpu_affinity: updated!.cpuAffinity,
        cpu_weight: updated!.cpuWeight,
        niceness: updated!.niceness,
        memory_high_mb: updated!.memoryHighMb,
        memory_max_mb: updated!.memoryMaxMb,
        io_weight: updated!.ioWeight,
      };
    },
  );

  fast.patch(
    '/api/v1/servers/:id',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.patch', resource: 'server' },
      },
      schema: { params: idParams, body: serverPatch },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const body = req.body;
      const setClause: Record<string, unknown> = { updatedAt: new Date() };
      if (body.display_name !== undefined) setClause.displayName = body.display_name;
      if (body.description !== undefined) setClause.description = body.description;
      if (body.tags !== undefined) setClause.tags = body.tags;

      await app.db.update(servers).set(setClause).where(eq(servers.id, req.params.id));

      const updated = await app.db.query.servers.findFirst({
        where: eq(servers.id, req.params.id),
      });

      return {
        id: updated!.id,
        display_name: updated!.displayName,
        slug: updated!.slug,
        description: updated!.description,
        status: updated!.status,
        tags: updated!.tags,
        updated_at: updated!.updatedAt.toISOString(),
      };
    },
  );
};

export default serverSettingsRoutes;
```

- [ ] **Step 4: Register routes in server.ts**

In `apps/api/src/server.ts`, add alongside existing route registrations:

```typescript
import serverSettingsRoutes from './routes/server-settings.js';
// ...in the register block:
app.register(serverSettingsRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @squad/api exec vitest run test/server-settings.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 6: Run full typecheck**

Run: `pnpm turbo run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/server-settings.ts apps/api/src/server.ts apps/api/test/server-settings.test.ts
git commit -m "feat(api): add PUT /servers/:id/settings and PATCH /servers/:id endpoints"
```

---

## Task 3: Force-Stop API Endpoint

**Files:**
- Create: `apps/api/src/routes/server-force-stop.ts`
- Create: `apps/api/test/server-force-stop.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/server-force-stop.test.ts
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { servers, serverSettings, serverCredentials } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER = 76561198000000001n;

async function seedRunning(h: IntegrationHarness) {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: 'Running Server',
    slug: `run-${id.slice(0, 8)}`,
    status: 'running',
    runtime: 'container',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.from('test'),
    keyVersion: 1,
  });
  return id;
}

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('POST /api/v1/servers/:id/force-stop', () => {
  it('force-stops a running server via container_rm', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);
    const rmSpy = vi.spyOn(h.bridge, 'containerRm');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/force-stop`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('stopped');
    expect(rmSpy).toHaveBeenCalledWith({ name: `squad-${id}`, force: true });

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, id) });
    expect(row?.status).toBe('stopped');
  });

  it('returns 404 for non-existent server', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${uuidv7()}/force-stop`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 for already stopped server', async () => {
    const id = uuidv7();
    await h.db.insert(servers).values({
      id,
      displayName: 'Stopped',
      slug: `s-${id.slice(0, 8)}`,
      status: 'stopped',
      runtime: 'container',
    });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/force-stop`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @squad/api exec vitest run test/server-force-stop.test.ts`
Expected: FAIL — route not registered

- [ ] **Step 3: Implement the force-stop route**

```typescript
// apps/api/src/routes/server-force-stop.ts
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { servers } from '@squad/db/schema';

const idParams = z.object({ id: z.string().uuid() });

function containerName(id: string) {
  return `squad-${id}`;
}

const STOPPABLE = new Set(['running', 'starting', 'stopping']);

const serverForceStopRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/force-stop',
    {
      config: {
        permissions: ['server:force_stop'],
        audit: { action: 'server.force_stop', resource: 'server' },
      },
      schema: { params: idParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (!STOPPABLE.has(row.status)) {
        reply.code(409);
        return { error: 'not_stoppable', status: row.status };
      }

      await app.bridge.containerRm({ name: containerName(row.id), force: true });

      await app.db
        .update(servers)
        .set({ status: 'stopped', updatedAt: new Date() })
        .where(eq(servers.id, row.id));

      app.liveBus?.publish({
        type: 'server.status',
        ts: new Date().toISOString(),
        data: { server_id: row.id, status: 'stopped', source: 'force_stop' },
      });

      return { status: 'stopped', server_id: row.id };
    },
  );
};

export default serverForceStopRoutes;
```

- [ ] **Step 4: Register in server.ts**

Add to `apps/api/src/server.ts`:

```typescript
import serverForceStopRoutes from './routes/server-force-stop.js';
app.register(serverForceStopRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @squad/api exec vitest run test/server-force-stop.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/server-force-stop.ts apps/api/test/server-force-stop.test.ts apps/api/src/server.ts
git commit -m "feat(api): add POST /servers/:id/force-stop endpoint"
```

---

## Task 4: A2S Query Module

**Files:**
- Create: `apps/workers/rcon/src/a2s.ts`
- Create: `apps/workers/rcon/test/a2s.test.ts`

- [ ] **Step 1: Write the failing test for A2S parser**

```typescript
// apps/workers/rcon/test/a2s.test.ts
import { describe, expect, it } from 'vitest';
import { parseA2SInfoResponse, buildA2SInfoRequest } from '../src/a2s.js';

describe('buildA2SInfoRequest', () => {
  it('builds the correct A2S_INFO request packet', () => {
    const buf = buildA2SInfoRequest();
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xff);
    expect(buf[2]).toBe(0xff);
    expect(buf[3]).toBe(0xff);
    expect(buf[4]).toBe(0x54); // 'T' header
    const payload = buf.subarray(5, buf.length - 1).toString('ascii');
    expect(payload).toBe('Source Engine Query');
    expect(buf[buf.length - 1]).toBe(0x00); // null terminator
  });
});

describe('parseA2SInfoResponse', () => {
  it('parses a valid A2S_INFO Source response', () => {
    const header = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]);
    const protocol = Buffer.from([0x11]);
    const name = Buffer.from('Test Server\0', 'ascii');
    const map = Buffer.from('Sumari_AAS_v1\0', 'ascii');
    const gameDir = Buffer.from('squad\0', 'ascii');
    const gameDesc = Buffer.from('Squad\0', 'ascii');
    const appId = Buffer.alloc(2);
    appId.writeUInt16LE(403240);
    const players = Buffer.from([50]);
    const maxPlayers = Buffer.from([100]);
    const bots = Buffer.from([0]);
    const serverType = Buffer.from([0x64]); // 'd' = dedicated
    const environment = Buffer.from([0x6c]); // 'l' = linux
    const visibility = Buffer.from([0x00]); // public
    const vac = Buffer.from([0x01]); // VAC on

    const packet = Buffer.concat([
      header,
      protocol,
      name,
      map,
      gameDir,
      gameDesc,
      appId,
      players,
      maxPlayers,
      bots,
      serverType,
      environment,
      visibility,
      vac,
    ]);

    const result = parseA2SInfoResponse(packet);
    expect(result).not.toBeNull();
    expect(result!.serverName).toBe('Test Server');
    expect(result!.map).toBe('Sumari_AAS_v1');
    expect(result!.players).toBe(50);
    expect(result!.maxPlayers).toBe(100);
    expect(result!.visible).toBe(true);
  });

  it('returns null for invalid packet', () => {
    const bad = Buffer.from([0x00, 0x01, 0x02]);
    expect(parseA2SInfoResponse(bad)).toBeNull();
  });

  it('handles challenge response header (0x41)', () => {
    const challenge = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x01, 0x02, 0x03, 0x04]);
    const result = parseA2SInfoResponse(challenge);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @squad/worker-rcon exec vitest run test/a2s.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement A2S module**

```typescript
// apps/workers/rcon/src/a2s.ts
import dgram from 'node:dgram';

export interface A2SInfoResult {
  serverName: string;
  map: string;
  players: number;
  maxPlayers: number;
  visible: boolean;
}

export function buildA2SInfoRequest(): Buffer {
  const header = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]);
  const payload = Buffer.from('Source Engine Query\0', 'ascii');
  return Buffer.concat([header, payload]);
}

function readNullTermString(buf: Buffer, offset: number): { value: string; next: number } {
  const end = buf.indexOf(0x00, offset);
  if (end === -1) return { value: '', next: buf.length };
  return { value: buf.subarray(offset, end).toString('ascii'), next: end + 1 };
}

export function parseA2SInfoResponse(buf: Buffer): A2SInfoResult | null {
  if (buf.length < 6) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xff || buf[2] !== 0xff || buf[3] !== 0xff) return null;
  if (buf[4] !== 0x49) return null; // 'I' = A2S_INFO response

  let offset = 6; // skip header (4) + type (1) + protocol (1)
  const name = readNullTermString(buf, offset);
  offset = name.next;
  const map = readNullTermString(buf, offset);
  offset = map.next;
  const gameDir = readNullTermString(buf, offset);
  offset = gameDir.next;
  const gameDesc = readNullTermString(buf, offset);
  offset = gameDesc.next;

  if (offset + 7 > buf.length) return null;

  offset += 2; // skip appId (uint16)
  const players = buf[offset++]!;
  const maxPlayers = buf[offset++]!;
  offset++; // skip bots
  offset++; // skip serverType
  offset++; // skip environment
  const visibility = buf[offset]!;

  return {
    serverName: name.value,
    map: map.value,
    players,
    maxPlayers,
    visible: visibility === 0x00,
  };
}

export function buildA2SChallengeRequest(challenge: Buffer): Buffer {
  const header = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]);
  const payload = Buffer.from('Source Engine Query\0', 'ascii');
  return Buffer.concat([header, payload, challenge]);
}

export async function queryA2S(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<A2SInfoResult | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, timeoutMs);

    socket.on('message', (msg) => {
      if (msg.length >= 5 && msg[4] === 0x41) {
        // Challenge response — resend with challenge bytes
        const challengeBytes = msg.subarray(5, 9);
        const retry = buildA2SChallengeRequest(challengeBytes);
        socket.send(retry, 0, retry.length, port, host);
        return;
      }

      clearTimeout(timer);
      socket.close();
      resolve(parseA2SInfoResponse(msg));
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.close();
      resolve(null);
    });

    const request = buildA2SInfoRequest();
    socket.send(request, 0, request.length, port, host);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @squad/worker-rcon exec vitest run test/a2s.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/workers/rcon/src/a2s.ts apps/workers/rcon/test/a2s.test.ts
git commit -m "feat(worker-rcon): add A2S_INFO UDP query module"
```

---

## Task 5: A2S Integration in RCON Worker + API

**Files:**
- Modify: `apps/workers/rcon/src/supervisor.ts`
- Modify: `apps/api/src/routes/servers.ts`

- [ ] **Step 1: Add A2S polling to PerServerSupervisor**

In `apps/workers/rcon/src/supervisor.ts`, inside the `schedulePoll()` method, after the existing RCON poll block (after `writeStatus('connected', {...})`), add the A2S query:

```typescript
// At top of file, add import:
import { queryA2S } from './a2s.js';

// Inside schedulePoll(), after the RCON try/catch block, add:
try {
  const a2sResult = await queryA2S(this.target.host, this.target.queryPort, 2000);
  const a2sKey = `a2s:status:${this.target.serverId}`;
  if (a2sResult) {
    const a2sValue = JSON.stringify({
      visible: a2sResult.visible,
      server_name: a2sResult.serverName,
      map: a2sResult.map,
      players: a2sResult.players,
      max_players: a2sResult.maxPlayers,
      latency_ms: Date.now() - start,
      queried_at: new Date().toISOString(),
    });
    await this.opts.redis.set(a2sKey, a2sValue, 'EX', 90);
    this.consecutiveA2SFails = 0;
  } else {
    this.consecutiveA2SFails = (this.consecutiveA2SFails ?? 0) + 1;
    if (this.consecutiveA2SFails >= 3) {
      const a2sValue = JSON.stringify({
        visible: false,
        reason: 'timeout',
        queried_at: new Date().toISOString(),
      });
      await this.opts.redis.set(a2sKey, a2sValue, 'EX', 90);
    }
  }
} catch {
  // A2S is best-effort; don't disrupt RCON polling
}
```

Add `private consecutiveA2SFails = 0;` to the `PerServerSupervisor` class fields.

The `target.queryPort` needs to be available. The existing `Target` interface in `supervisor.ts` has `host`, `port` (RCON port), `password`, and `serverId`. Add `queryPort: number` to the interface. In the main worker entry point (`apps/workers/rcon/src/index.ts`), the DB query that builds targets already joins `serverSettings` — add `serverSettings.queryPort` to the select and pass it through when constructing Target objects.

- [ ] **Step 2: Add a2s_status to server API responses**

In `apps/api/src/routes/servers.ts`, in the GET `/api/v1/servers` handler, after reading `rcon:status:{id}`, also read `a2s:status:{id}`:

```typescript
// After the rcon_status read:
const a2sRaw = await app.redis.get(`a2s:status:${row.id}`);
const a2s_status = a2sRaw ? JSON.parse(a2sRaw) : null;
```

Add `a2s_status` to the returned object for both the list and detail endpoints.

In the detail endpoint (`GET /api/v1/servers/:id`), add the same read:

```typescript
const a2sRaw = await app.redis.get(`a2s:status:${row.id}`);
// Include in response:
a2s_status: a2sRaw ? JSON.parse(a2sRaw) : null,
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @squad/api test && pnpm --filter @squad/worker-rcon test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/workers/rcon/src/supervisor.ts apps/api/src/routes/servers.ts
git commit -m "feat: integrate A2S polling in RCON worker and expose in API responses"
```

---

## Task 6: Crash Detection in Status Reconciler

**Files:**
- Modify: `apps/api/src/plugins/status-reconciler.ts`
- Modify: `apps/api/src/routes/servers.ts`
- Create: `apps/api/test/crash-detection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/crash-detection.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  detectCrash,
  detectCrashLoop,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
} from '../src/plugins/status-reconciler.js';

describe('detectCrash', () => {
  it('detects a crash when restart_count increments', () => {
    const state = new Map<string, number>();
    const inspectResult = {
      restart_count: 1,
      oom_killed: false,
      exit_code: 137,
      finished_at: '2026-05-05T10:00:00Z',
    };
    const result = detectCrash('server-1', inspectResult, state);
    expect(result).toBeNull(); // first observation sets baseline

    const inspectResult2 = { ...inspectResult, restart_count: 2 };
    const result2 = detectCrash('server-1', inspectResult2, state);
    expect(result2).not.toBeNull();
    expect(result2!.restart_count).toBe(2);
  });

  it('returns null when restart_count is unchanged', () => {
    const state = new Map<string, number>();
    const inspect = { restart_count: 3, oom_killed: false, exit_code: 0, finished_at: '' };
    detectCrash('s1', inspect, state);
    const result = detectCrash('s1', inspect, state);
    expect(result).toBeNull();
  });
});

describe('detectCrashLoop', () => {
  it('detects crash loop when 3+ crashes within window', () => {
    const now = Date.now();
    const crashes = [
      { timestamp: now - 60_000 },
      { timestamp: now - 30_000 },
      { timestamp: now },
    ];
    expect(detectCrashLoop(crashes, CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD)).toBe(true);
  });

  it('does not trigger for spread-out crashes', () => {
    const now = Date.now();
    const crashes = [
      { timestamp: now - 600_000 },
      { timestamp: now - 400_000 },
      { timestamp: now },
    ];
    expect(detectCrashLoop(crashes, CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @squad/api exec vitest run test/crash-detection.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add crash detection to the reconciler**

In `apps/api/src/plugins/status-reconciler.ts`, add these exported functions and integrate them into the reconcile loop:

```typescript
// Add near the top constants:
export const CRASH_LOOP_THRESHOLD = 3;
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000;

// Add exported utility functions:
export interface CrashInfo {
  restart_count: number;
  oom_killed: boolean;
  exit_code: number;
  finished_at: string;
}

export function detectCrash(
  serverId: string,
  inspect: { restart_count: number; oom_killed?: boolean; exit_code: number; finished_at: string },
  knownRestartCounts: Map<string, number>,
): CrashInfo | null {
  const prev = knownRestartCounts.get(serverId);
  knownRestartCounts.set(serverId, inspect.restart_count);
  if (prev === undefined) return null;
  if (inspect.restart_count <= prev) return null;
  return {
    restart_count: inspect.restart_count,
    oom_killed: inspect.oom_killed ?? false,
    exit_code: inspect.exit_code,
    finished_at: inspect.finished_at,
  };
}

export function detectCrashLoop(
  crashes: Array<{ timestamp: number }>,
  windowMs: number,
  threshold: number,
): boolean {
  const now = Date.now();
  const recent = crashes.filter((c) => now - c.timestamp < windowMs);
  return recent.length >= threshold;
}
```

Then in the `reconcileServer` function, after the existing status mapping logic, add crash detection:

```typescript
// Inside reconcileServer, after the inspect call succeeds:
const crashInfo = detectCrash(row.id, res, knownRestartCounts);
if (crashInfo) {
  const wasRequested = await deps.redis.get(`stop:requested:${row.id}`);
  if (!wasRequested) {
    // Unexpected restart = crash
    log.warn({ serverId: row.id, ...crashInfo }, 'reconciler: crash detected');

    const crashEntry = JSON.stringify({
      ...crashInfo,
      timestamp: new Date().toISOString(),
    });
    await deps.redis.zadd(`crashes:${row.id}`, String(Date.now()), crashEntry);
    await deps.redis.zremrangebyscore(`crashes:${row.id}`, '-inf', String(Date.now() - 86_400_000));

    deps.liveBus?.publish({
      type: 'server.status',
      ts: new Date().toISOString(),
      data: { server_id: row.id, status: row.status, source: 'crash_detected' },
    });

    // Check for crash loop
    const crashScores = await deps.redis.zrangebyscore(
      `crashes:${row.id}`,
      String(Date.now() - CRASH_LOOP_WINDOW_MS),
      '+inf',
    );
    if (crashScores.length >= CRASH_LOOP_THRESHOLD) {
      log.error({ serverId: row.id, count: crashScores.length }, 'reconciler: crash loop detected');
      await db.update(servers).set({ status: 'failed', updatedAt: new Date() }).where(eq(servers.id, row.id));
      deps.liveBus?.publish({
        type: 'server.status',
        ts: new Date().toISOString(),
        data: { server_id: row.id, status: 'failed', source: 'crash_loop' },
      });
    }
  }
}
```

Add `const knownRestartCounts = new Map<string, number>();` at the plugin scope level (alongside other state like `bridgeFailures`).

- [ ] **Step 4: Add crash_history and crash_loop to API responses**

In `apps/api/src/routes/servers.ts`, in the detail endpoint:

```typescript
// Read crash history from Redis sorted set
const crashRaw = await app.redis.zrevrange(`crashes:${row.id}`, 0, 9);
const crash_history = crashRaw.map((c: string) => JSON.parse(c));
const crash_loop = row.status === 'failed';
// Add to response:
// crash_history,
// crash_loop,
```

In the list endpoint, add `crash_loop: row.status === 'failed'` per server.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @squad/api exec vitest run test/crash-detection.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm --filter @squad/api test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/plugins/status-reconciler.ts apps/api/src/routes/servers.ts apps/api/test/crash-detection.test.ts
git commit -m "feat(api): add crash detection and crash loop protection to status reconciler"
```

---

## Task 7: Container Metrics Collection + API

**Files:**
- Modify: `apps/workers/metrics-sampler/src/sampler.ts`
- Create: `apps/api/src/routes/server-metrics.ts`
- Create: `apps/api/test/server-metrics.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the failing test for the metrics endpoint**

```typescript
// apps/api/test/server-metrics.test.ts
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { servers, serverSettings, serverCredentials } from '@squad/db/schema';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER = 76561198000000001n;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /api/v1/servers/:id/metrics', () => {
  it('returns empty array when no metrics exist', async () => {
    const id = uuidv7();
    await h.db.insert(servers).values({
      id,
      displayName: 'Test',
      slug: `t-${id.slice(0, 8)}`,
      status: 'running',
      runtime: 'container',
    });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/metrics`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().points).toEqual([]);
  });

  it('returns stored metrics within time range', async () => {
    const id = uuidv7();
    await h.db.insert(servers).values({
      id,
      displayName: 'Test',
      slug: `t-${id.slice(0, 8)}`,
      status: 'running',
      runtime: 'container',
    });

    const streamKey = `container:metrics:${id}`;
    await h.redis.xadd(
      streamKey,
      '*',
      'v',
      JSON.stringify({
        cpu_percent: 45.2,
        mem_bytes: 2_000_000_000,
        mem_percent: 62.5,
        pids: 42,
        timestamp: new Date().toISOString(),
      }),
    );

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}/metrics`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.points.length).toBe(1);
    expect(body.points[0].cpu_percent).toBe(45.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @squad/api exec vitest run test/server-metrics.test.ts`
Expected: FAIL — route not registered

- [ ] **Step 3: Implement the metrics endpoint**

```typescript
// apps/api/src/routes/server-metrics.ts
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { servers } from '@squad/db/schema';

const idParams = z.object({ id: z.string().uuid() });
const metricsQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

const MAX_POINTS = 1000;

const serverMetricsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers/:id/metrics',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: idParams, querystring: metricsQuery },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const since = req.query.since ?? new Date(Date.now() - 3_600_000).toISOString();
      const until = req.query.until ?? new Date().toISOString();

      const sinceMs = new Date(since).getTime();
      const untilMs = new Date(until).getTime();

      const streamKey = `container:metrics:${row.id}`;
      const raw = (await app.redis.xrange(
        streamKey,
        String(sinceMs),
        String(untilMs),
        'COUNT',
        String(MAX_POINTS * 2),
      )) as Array<[string, string[]]>;

      const points: Array<Record<string, unknown>> = [];
      const step = raw.length > MAX_POINTS ? Math.ceil(raw.length / MAX_POINTS) : 1;

      for (let i = 0; i < raw.length; i += step) {
        const [id, kv] = raw[i]!;
        const vIdx = kv.indexOf('v');
        if (vIdx < 0) continue;
        const parsed = JSON.parse(kv[vIdx + 1]!);
        points.push(parsed);
      }

      return { server_id: row.id, since, until, points };
    },
  );
};

export default serverMetricsRoutes;
```

- [ ] **Step 4: Register in server.ts**

```typescript
import serverMetricsRoutes from './routes/server-metrics.js';
app.register(serverMetricsRoutes);
```

- [ ] **Step 5: Add container stats to metrics sampler**

In `apps/workers/metrics-sampler/src/sampler.ts`, extend the tick function to also collect per-server stats:

```typescript
// Add to RunSamplerOpts:
// db: Pick<DatabaseClient, 'select'>;  — or pass a function that returns running server IDs

// In the tick function, after host metrics, add:
async function collectContainerMetrics(
  bridge: Pick<BridgeClient, 'containerStats'>,
  redis: Pick<Redis, 'xadd'>,
  serverIds: string[],
  log: Logger,
): Promise<void> {
  for (const serverId of serverIds) {
    try {
      const stats = await bridge.containerStats({ name: `squad-${serverId}` });
      if (!stats.found) continue;
      await redis.xadd(
        `container:metrics:${serverId}`,
        'MAXLEN',
        '~',
        '2880',
        '*',
        'v',
        JSON.stringify({
          cpu_percent: stats.cpu_percent,
          mem_bytes: stats.mem_used_bytes,
          mem_percent: stats.mem_percent,
          pids: stats.pids,
          timestamp: stats.sampled_at,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug({ err: msg, serverId }, 'container metrics sample failed');
    }
  }
}
```

The sampler needs a way to know which servers are running. Two approaches:
- Read from Redis (e.g., `rcon:status:*` keys) — avoids DB dependency
- Accept a callback that returns running server IDs

Recommended: scan Redis for `rcon:status:*` keys whose value contains `"state":"connected"`. This keeps the metrics sampler decoupled from the database.

```typescript
async function getRunningServerIds(redis: Pick<Redis, 'keys' | 'get'>): Promise<string[]> {
  const keys = await redis.keys('rcon:status:*');
  const ids: string[] = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.state === 'connected' || parsed.state === 'connecting') {
        ids.push(key.replace('rcon:status:', ''));
      }
    } catch {
      // skip malformed
    }
  }
  return ids;
}
```

Add this to the sampler's tick loop, called every 30s (same interval as host metrics, or a separate timer if the host metrics interval is different).

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @squad/api exec vitest run test/server-metrics.test.ts`
Expected: PASS

- [ ] **Step 7: Run full suite**

Run: `pnpm --filter @squad/api test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/server-metrics.ts apps/api/test/server-metrics.test.ts apps/api/src/server.ts apps/workers/metrics-sampler/src/sampler.ts
git commit -m "feat: add container metrics time-series collection and GET /servers/:id/metrics endpoint"
```

---

## Task 8: Coordinated Depot Update

**Files:**
- Modify: `apps/api/src/routes/depot.ts`
- Create: `apps/api/test/depot-coordinated.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/depot-coordinated.test.ts
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { servers, serverSettings, serverCredentials } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER = 76561198000000001n;

async function seedRunning(h: IntegrationHarness) {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Server ${id.slice(0, 4)}`,
    slug: `s-${id.slice(0, 8)}`,
    status: 'running',
    runtime: 'container',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787 + Math.floor(Math.random() * 1000),
    queryPort: 27165 + Math.floor(Math.random() * 1000),
    beaconPort: 15000 + Math.floor(Math.random() * 1000),
    rconPort: 21114 + Math.floor(Math.random() * 1000),
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.from('test'),
    keyVersion: 1,
  });
  return id;
}

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('POST /api/v1/depot/update with serverIds', () => {
  it('accepts serverIds and returns started status', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('started');
    expect(body.servers_to_stop).toEqual([id]);
  });

  it('works without serverIds (depot-only update)', async () => {
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('started');
  });

  it('rejects non-existent server IDs', async () => {
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [uuidv7()] },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/depot', () => {
  it('includes build_id from Redis', async () => {
    await h.redis.set('depot:build_id', '12345678');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().build_id).toBe('12345678');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @squad/api exec vitest run test/depot-coordinated.test.ts`
Expected: FAIL — validation rejects unknown `server_ids` field or missing build_id in response

- [ ] **Step 3: Enhance the depot route**

In `apps/api/src/routes/depot.ts`:

1. Add Zod schema for the enhanced POST body:

```typescript
const depotUpdateBody = z
  .object({
    server_ids: z.array(z.string().uuid()).optional().default([]),
  })
  .strict();
```

2. In the POST handler, add schema validation and orchestration logic:

```typescript
// Validate server_ids exist and are stoppable
const serverIds = body.server_ids;
if (serverIds.length > 0) {
  const found = await app.db
    .select({ id: servers.id, status: servers.status })
    .from(servers)
    .where(and(
      inArray(servers.id, serverIds),
      isNull(servers.deletedAt),
    ));
  
  if (found.length !== serverIds.length) {
    reply.code(400);
    return { error: 'invalid_server_ids', found: found.map(f => f.id) };
  }
}
```

3. In the background task, wrap the depot update with server orchestration:

```typescript
// Before depot_update:
if (serverIds.length > 0) {
  // Phase 1: Broadcast warning to each server
  for (const sid of serverIds) {
    try {
      const creds = await getCreds(app.db, sid);
      if (creds) {
        await rconSendOnce({
          host: resolveRconHost(creds.rconHost),
          port: creds.rconPort,
          password: decryptPassword(creds),
          command: 'AdminBroadcast Сервер будет остановлен для обновления через 60 секунд',
          connectTimeoutMs: 2000,
          commandTimeoutMs: 3000,
        }).catch(() => {});
      }
    } catch { /* continue */ }
  }
  
  // Phase 2: Wait 60 seconds (stream countdown)
  void app.redis.xadd('depot:progress', 'MAXLEN', '~', '5000', '*',
    'stream', 'stdout', 'text', 'Waiting 60s for players to disconnect...');
  await new Promise(r => setTimeout(r, 60_000));
  
  // Phase 3: Graceful stop all selected servers
  for (const sid of serverIds) {
    try {
      await app.bridge.containerStop({ name: `squad-${sid}`, timeout_sec: 60 });
      await app.db.update(servers).set({ status: 'stopped', updatedAt: new Date() })
        .where(eq(servers.id, sid));
      void app.redis.xadd('depot:progress', 'MAXLEN', '~', '5000', '*',
        'stream', 'stdout', 'text', `Server ${sid.slice(0,8)} stopped`);
    } catch (err) {
      void app.redis.xadd('depot:progress', 'MAXLEN', '~', '5000', '*',
        'stream', 'stderr', 'text', `Failed to stop ${sid.slice(0,8)}: ${(err as Error).message}`);
    }
  }
}

// ... existing depot_update call ...

// After depot_update succeeds, parse and store build ID:
// (Build ID parsing is already done in the GET handler via manifest file.
// Store it in Redis too for quick access.)
try {
  const { content } = await dedicated.fileRead({ path: DEPOT_MANIFEST });
  const bid = parseBuildId(content);
  if (bid) await app.redis.set('depot:build_id', bid);
} catch { /* non-critical */ }

// Phase 5: Restart stopped servers
if (serverIds.length > 0) {
  for (const sid of serverIds) {
    try {
      await app.bridge.containerStart({ name: `squad-${sid}` });
      await app.db.update(servers).set({ status: 'starting', updatedAt: new Date() })
        .where(eq(servers.id, sid));
      void app.redis.xadd('depot:progress', 'MAXLEN', '~', '5000', '*',
        'stream', 'stdout', 'text', `Server ${sid.slice(0,8)} restarting`);
    } catch {
      // Try container_run as fallback
      try {
        const settings = await app.db.query.serverSettings.findFirst({
          where: eq(serverSettings.serverId, sid),
        });
        if (settings) {
          await app.bridge.containerRun({
            server_id: sid,
            image: SERVER_IMAGE,
            game_port: settings.gamePort,
            query_port: settings.queryPort,
            beacon_port: settings.beaconPort,
            rcon_port: settings.rconPort,
            max_players: settings.maxPlayers,
            tickrate: settings.tickrate,
            multihome: settings.multihome,
            configs_host: `${PANEL_CONFIGS_ROOT}/${sid}/ServerConfig`,
            saved_host: `${PANEL_SAVED_ROOT}/${sid}`,
            depot_volume: DEPOT_VOLUME_NAME,
          });
          await app.db.update(servers).set({ status: 'starting', updatedAt: new Date() })
            .where(eq(servers.id, sid));
        }
      } catch (err2) {
        void app.redis.xadd('depot:progress', 'MAXLEN', '~', '5000', '*',
          'stream', 'stderr', 'text', `Failed to restart ${sid.slice(0,8)}: ${(err2 as Error).message}`);
      }
    }
  }
}
```

4. In the GET handler, read `depot:build_id` from Redis and include it in the response alongside the file-based `build_id`:

```typescript
const redisBuildId = await app.redis.get('depot:build_id');
// In return: build_id: redisBuildId ?? buildId,
```

5. Return `servers_to_stop` in the POST response:

```typescript
return { status: 'started', started_at: startedAt, servers_to_stop: serverIds };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @squad/api exec vitest run test/depot-coordinated.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/depot.ts apps/api/test/depot-coordinated.test.ts
git commit -m "feat(api): add coordinated depot update with server stop/restart orchestration"
```

---

## Task 9: Server Create Wizard (Web)

**Files:**
- Create: `apps/web/src/app/(dashboard)/servers/new/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/page.tsx` (add link)

- [ ] **Step 1: Create the wizard page**

```typescript
// apps/web/src/app/(dashboard)/servers/new/page.tsx
'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

interface FormData {
  display_name: string;
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
}

const DEFAULTS: FormData = {
  display_name: '',
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
};

export default function CreateServerPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<FormData>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = useCallback(
    <K extends keyof FormData>(key: K, value: FormData[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const valid = form.display_name.trim().length > 0;

  const slug = form.display_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/v1/servers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          display_name: form.display_name.trim(),
          slug,
          game_port: form.game_port,
          query_port: form.query_port,
          beacon_port: form.beacon_port,
          rcon_port: form.rcon_port,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string };

      await fetch(`/api/v1/servers/${id}/install`, {
        method: 'POST',
        credentials: 'include',
      });

      router.push(`/servers/${id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg py-10">
      <h1 className="mb-6 text-xl font-semibold text-neutral-100">Новый сервер</h1>

      {err && (
        <div className="mb-4 rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs uppercase tracking-widest text-neutral-400">
              Название сервера
            </span>
            <input
              autoFocus
              value={form.display_name}
              onChange={(e) => set('display_name', e.target.value)}
              placeholder="My Squad Server"
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
            {slug && (
              <span className="mt-1 block text-xs text-neutral-500">slug: {slug}</span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ['game_port', 'Game Port'] as const,
                ['query_port', 'Query Port'] as const,
                ['beacon_port', 'Beacon Port'] as const,
                ['rcon_port', 'RCON Port'] as const,
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-xs uppercase tracking-widest text-neutral-400">
                  {label}
                </span>
                <input
                  type="number"
                  value={form[key]}
                  onChange={(e) => set(key, Number(e.target.value))}
                  min={1024}
                  max={65535}
                  className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
                />
              </label>
            ))}
          </div>

          <button
            type="button"
            disabled={!valid}
            onClick={() => setStep(2)}
            className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Далее
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="rounded border border-neutral-800 bg-neutral-900 p-4 text-sm">
            <h2 className="mb-3 font-medium text-neutral-200">Подтверждение</h2>
            <dl className="grid grid-cols-2 gap-2 text-neutral-300">
              <dt className="text-neutral-500">Название</dt>
              <dd>{form.display_name}</dd>
              <dt className="text-neutral-500">Game Port</dt>
              <dd>{form.game_port}</dd>
              <dt className="text-neutral-500">Query Port</dt>
              <dd>{form.query_port}</dd>
              <dt className="text-neutral-500">Beacon Port</dt>
              <dd>{form.beacon_port}</dd>
              <dt className="text-neutral-500">RCON Port</dt>
              <dd>{form.rcon_port}</dd>
            </dl>
            <p className="mt-3 text-xs text-neutral-500">
              Конфигурация будет создана из стандартных файлов Squad. Настройки ресурсов можно
              изменить после создания.
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border border-neutral-800 bg-neutral-900 px-4 py-2 text-sm text-neutral-300 hover:border-neutral-700"
            >
              Назад
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              {busy ? 'Создание...' : 'Создать сервер'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add "Создать сервер" link to server list page**

In `apps/web/src/app/(dashboard)/servers/page.tsx`, add a link near the page header:

```typescript
import Link from 'next/link';

// In the JSX, near the title:
<Link
  href="/servers/new"
  className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white no-underline hover:bg-sky-600"
>
  + Создать сервер
</Link>
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/servers/new/page.tsx apps/web/src/app/\(dashboard\)/servers/page.tsx
git commit -m "feat(web): add server create wizard at /servers/new"
```

---

## Task 10: Settings Editor Page (Web)

**Files:**
- Create: `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/page.tsx` (add tab link)

- [ ] **Step 1: Create the settings page**

```typescript
// apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx
'use client';

import { use, useCallback, useEffect, useState } from 'react';

interface Settings {
  server_id: string;
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
  max_players: number;
  tickrate: number;
  multihome: string | null;
  extra_args: string;
  cpu_affinity: string | null;
  cpu_weight: number | null;
  niceness: number | null;
  memory_high_mb: number | null;
  memory_max_mb: number | null;
  io_weight: number | null;
}

interface ServerInfo {
  status: string;
  display_name: string;
  tags: string[];
}

export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const [draft, setDraft] = useState<Partial<Settings>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/servers/${id}`, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setServerInfo({ status: data.server.status, display_name: data.server.display_name, tags: data.server.tags ?? [] });
      setSettings(data.settings);
      setDraft({});
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isRunning = serverInfo && !['stopped', 'ready', 'pending'].includes(serverInfo.status);

  function setField<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function saveSettings() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Settings;
      setSettings(updated);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return <div className="p-6 text-neutral-500">Загрузка...</div>;
  }

  const val = <K extends keyof Settings>(key: K) =>
    draft[key] !== undefined ? draft[key] : settings[key];

  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="mx-auto max-w-2xl py-6">
      <h1 className="mb-6 text-xl font-semibold text-neutral-100">
        Настройки — {serverInfo?.display_name}
      </h1>

      {err && (
        <div className="mb-4 rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}
      {saved && (
        <div className="mb-4 rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-sm text-emerald-300">
          Сохранено
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Сеть
        </h2>
        {isRunning && (
          <p className="mb-2 text-xs text-amber-400">
            Остановите сервер для изменения портов
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ['game_port', 'Game Port'],
              ['query_port', 'Query Port'],
              ['beacon_port', 'Beacon Port'],
              ['rcon_port', 'RCON Port'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-neutral-500">{label}</span>
              <input
                type="number"
                value={val(key) as number}
                onChange={(e) => setField(key, Number(e.target.value))}
                disabled={!!isRunning}
                min={1024}
                max={65535}
                className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Игра
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-neutral-500">Max Players</span>
            <input
              type="number"
              value={val('max_players') as number}
              onChange={(e) => setField('max_players', Number(e.target.value))}
              min={1}
              max={100}
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-neutral-500">Tickrate</span>
            <input
              type="number"
              value={val('tickrate') as number}
              onChange={(e) => setField('tickrate', Number(e.target.value))}
              min={10}
              max={60}
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Ресурсы
        </h2>
        <p className="mb-2 text-xs text-neutral-500">
          Применяется при следующем запуске
        </p>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ['memory_high_mb', 'Memory High (MB)', 2048],
              ['memory_max_mb', 'Memory Max (MB)', 2048],
              ['cpu_weight', 'CPU Weight', 1],
              ['io_weight', 'IO Weight', 10],
              ['niceness', 'Nice', -20],
            ] as const
          ).map(([key, label, min]) => (
            <label key={key} className="block">
              <span className="text-xs text-neutral-500">{label}</span>
              <input
                type="number"
                value={(val(key) as number | null) ?? ''}
                onChange={(e) =>
                  setField(key, e.target.value === '' ? null : Number(e.target.value))
                }
                min={min}
                placeholder="Нет лимита"
                className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-xs text-neutral-500">CPU Affinity</span>
            <input
              value={(val('cpu_affinity') as string | null) ?? ''}
              onChange={(e) =>
                setField('cpu_affinity', e.target.value === '' ? null : e.target.value)
              }
              placeholder="Нет ограничения"
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </section>

      <button
        type="button"
        disabled={!dirty || busy}
        onClick={saveSettings}
        className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Сохранение...' : 'Сохранить'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add settings tab link to server detail page**

In `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`, add alongside existing config/events links:

```typescript
<Link href={`/servers/${server.id}/settings`}>Настройки →</Link>
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/servers/\[id\]/settings/page.tsx apps/web/src/app/\(dashboard\)/servers/\[id\]/page.tsx
git commit -m "feat(web): add server settings editor page at /servers/:id/settings"
```

---

## Task 11: Force-Stop UI Components

**Files:**
- Create: `apps/web/src/components/ForceStopDialog.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`

- [ ] **Step 1: Create the force-stop dialog component**

```typescript
// apps/web/src/components/ForceStopDialog.tsx
'use client';

import { useId, useState, useEffect } from 'react';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serverName: string;
  onConfirm: () => Promise<void>;
}

export function ForceStopDialog({ open, onOpenChange, serverName, onConfirm }: Props) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // caller handles error
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold text-neutral-100">
          Принудительная остановка
        </h2>
        <p className="mb-4 text-sm text-neutral-300">
          Сервер <strong>{serverName}</strong> будет немедленно остановлен без сохранения. Все
          игроки будут отключены.
        </p>
        <p className="mb-5 text-xs text-red-400">Это действие нельзя отменить.</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleConfirm}
            className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {busy ? 'Остановка...' : 'Остановить принудительно'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Integrate into server detail page**

In `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`, replace the existing single stop button with a split-button pattern. In the action buttons section:

```typescript
import { ForceStopDialog } from '@/components/ForceStopDialog';

// Add state:
const [forceStopOpen, setForceStopOpen] = useState(false);

// Replace or augment the stop button area:
// Primary stop button remains as-is
// Add a dropdown trigger next to it:
{data?.server.status === 'running' && (
  <div className="relative inline-flex">
    <button
      type="button"
      onClick={() => action('stop')}
      disabled={acting !== null}
      className="rounded-l bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
    >
      Остановить
    </button>
    <button
      type="button"
      onClick={() => setForceStopOpen(true)}
      className="rounded-r border-l border-amber-800 bg-amber-700 px-2 py-1.5 text-sm text-white hover:bg-amber-600"
      title="Принудительная остановка"
    >
      ▾
    </button>
  </div>
)}

<ForceStopDialog
  open={forceStopOpen}
  onOpenChange={setForceStopOpen}
  serverName={data?.server.display_name ?? ''}
  onConfirm={async () => {
    const r = await fetch(`/api/v1/servers/${id}/force-stop`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    void refresh();
  }}
/>
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ForceStopDialog.tsx apps/web/src/app/\(dashboard\)/servers/\[id\]/page.tsx
git commit -m "feat(web): add force-stop split button with confirmation dialog"
```

---

## Task 12: A2S Indicator + Crash Badge Components

**Files:**
- Create: `apps/web/src/components/A2SIndicator.tsx`
- Create: `apps/web/src/components/CrashBadge.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Create A2S indicator**

```typescript
// apps/web/src/components/A2SIndicator.tsx
'use client';

interface Props {
  a2sStatus: {
    visible: boolean;
    server_name?: string;
    latency_ms?: number;
    reason?: string;
  } | null;
  serverStatus: string;
}

export function A2SIndicator({ a2sStatus, serverStatus }: Props) {
  if (!['running', 'starting'].includes(serverStatus)) return null;
  if (!a2sStatus) return null;

  const visible = a2sStatus.visible;

  return (
    <span
      title={
        visible
          ? `Виден в Steam Browser (${a2sStatus.latency_ms ?? '?'}ms)`
          : `Не виден в Steam Browser${a2sStatus.reason ? `: ${a2sStatus.reason}` : ''}`
      }
      className={`inline-flex items-center gap-1 text-xs ${visible ? 'text-emerald-400' : 'text-red-400'}`}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M2 8 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M4 4 A6 3 0 0 1 12 4" fill="none" stroke="currentColor" strokeWidth="0.8" />
        <line x1="8" y1="1" x2="8" y2="15" stroke="currentColor" strokeWidth="1" />
        <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1" />
      </svg>
      {visible ? 'Steam' : '!Steam'}
    </span>
  );
}
```

- [ ] **Step 2: Create crash badge**

```typescript
// apps/web/src/components/CrashBadge.tsx
'use client';

interface Props {
  crashLoop: boolean;
  crashCount: number;
}

export function CrashBadge({ crashLoop, crashCount }: Props) {
  if (crashCount === 0 && !crashLoop) return null;

  if (crashLoop) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-900 px-1.5 py-0.5 text-xs font-medium text-red-200 animate-pulse">
        Цикл аварий
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-900 px-1.5 py-0.5 text-xs font-medium text-amber-200">
      {crashCount} {crashCount === 1 ? 'авария' : 'аварий'}
    </span>
  );
}
```

- [ ] **Step 3: Add to server detail page**

In `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`:

```typescript
import { A2SIndicator } from '@/components/A2SIndicator';
import { CrashBadge } from '@/components/CrashBadge';

// In the status area, after the existing status badge:
<A2SIndicator a2sStatus={data?.a2s_status} serverStatus={data?.server.status ?? ''} />
<CrashBadge
  crashLoop={data?.crash_loop ?? false}
  crashCount={data?.crash_history?.length ?? 0}
/>
```

Add a crash-loop banner in the detail page body:

```typescript
{data?.crash_loop && (
  <div className="mb-4 rounded border border-red-900 bg-red-950 p-3 text-sm text-red-300">
    Сервер в цикле аварий — автоперезапуск отключён. Проверьте логи и запустите вручную.
  </div>
)}
```

- [ ] **Step 4: Add to dashboard server cards**

In `apps/web/src/app/(dashboard)/dashboard/page.tsx`, inside the server table row rendering, add:

```typescript
import { A2SIndicator } from '@/components/A2SIndicator';
import { CrashBadge } from '@/components/CrashBadge';

// In the server row, after RCON status:
<A2SIndicator a2sStatus={s.a2s_status} serverStatus={s.status} />
<CrashBadge crashLoop={s.crash_loop} crashCount={0} />
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/web`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/A2SIndicator.tsx apps/web/src/components/CrashBadge.tsx apps/web/src/app/\(dashboard\)/servers/\[id\]/page.tsx apps/web/src/app/\(dashboard\)/dashboard/page.tsx
git commit -m "feat(web): add A2S visibility indicator and crash badge components"
```

---

## Task 13: Monitoring Page with Metrics Charts

**Files:**
- Create: `apps/web/src/components/MetricsChart.tsx`
- Create: `apps/web/src/app/(dashboard)/servers/[id]/monitoring/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/page.tsx` (add tab link)

- [ ] **Step 1: Create the SVG chart component**

```typescript
// apps/web/src/components/MetricsChart.tsx
'use client';

interface Point {
  timestamp: string;
  value: number;
}

interface Props {
  points: Point[];
  label: string;
  unit: string;
  color: string;
  maxY?: number;
  formatValue?: (v: number) => string;
}

const W = 600;
const H = 160;
const PAD = { top: 10, right: 10, bottom: 20, left: 50 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

function defaultFormat(v: number): string {
  if (v >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(1)} GB`;
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(0)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v.toFixed(1)}`;
}

export function MetricsChart({ points, label, unit, color, maxY, formatValue }: Props) {
  const fmt = formatValue ?? defaultFormat;

  if (points.length === 0) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <span className="text-xs uppercase tracking-widest text-neutral-400">{label}</span>
        <p className="mt-2 text-sm text-neutral-500">Нет данных</p>
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const yMax = maxY ?? Math.max(...values) * 1.1 || 1;
  const yMin = 0;

  const xScale = (i: number) => PAD.left + (i / (points.length - 1 || 1)) * INNER_W;
  const yScale = (v: number) => PAD.top + INNER_H - ((v - yMin) / (yMax - yMin)) * INNER_H;

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(p.value).toFixed(1)}`)
    .join(' ');

  const currentValue = values[values.length - 1] ?? 0;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-widest text-neutral-400">{label}</span>
        <span className="text-lg font-semibold" style={{ color }}>
          {fmt(currentValue)} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        <line
          x1={PAD.left}
          y1={PAD.top + INNER_H}
          x2={PAD.left + INNER_W}
          y2={PAD.top + INNER_H}
          stroke="#404040"
          strokeWidth="1"
        />
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = yScale(yMin + frac * (yMax - yMin));
          const val = yMin + frac * (yMax - yMin);
          return (
            <g key={frac}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + INNER_W}
                y2={y}
                stroke="#262626"
                strokeWidth="0.5"
              />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" fill="#737373" fontSize="9">
                {fmt(val)}
              </text>
            </g>
          );
        })}
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    </div>
  );
}
```

- [ ] **Step 2: Create the monitoring page**

```typescript
// apps/web/src/app/(dashboard)/servers/[id]/monitoring/page.tsx
'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { MetricsChart } from '@/components/MetricsChart';

interface MetricsPoint {
  timestamp: string;
  cpu_percent: number;
  mem_bytes: number;
  mem_percent: number;
  pids: number;
  tickrate?: number;
}

type Range = '1h' | '6h' | '24h';

const RANGE_MS: Record<Range, number> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
};

const POLL_MS = 30_000;

export default function MonitoringPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [points, setPoints] = useState<MetricsPoint[]>([]);
  const [range, setRange] = useState<Range>('1h');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const since = new Date(Date.now() - RANGE_MS[range]).toISOString();
      const r = await fetch(
        `/api/v1/servers/${id}/metrics?since=${encodeURIComponent(since)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { points: MetricsPoint[] };
      setPoints(data.points);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id, range]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-neutral-100">Мониторинг</h1>
        <div className="flex gap-1">
          {(['1h', '6h', '24h'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded px-2 py-1 text-xs ${
                range === r
                  ? 'bg-sky-700 text-white'
                  : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {r === '1h' ? '1ч' : r === '6h' ? '6ч' : '24ч'}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <div className="space-y-4">
        <MetricsChart
          points={points.map((p) => ({ timestamp: p.timestamp, value: p.cpu_percent }))}
          label="CPU"
          unit="%"
          color="#38bdf8"
          maxY={100}
          formatValue={(v) => `${v.toFixed(1)}`}
        />

        <MetricsChart
          points={points.map((p) => ({ timestamp: p.timestamp, value: p.mem_bytes }))}
          label="Память"
          unit=""
          color="#a78bfa"
        />

        {points.some((p) => p.tickrate !== undefined) && (
          <MetricsChart
            points={points
              .filter((p) => p.tickrate !== undefined)
              .map((p) => ({ timestamp: p.timestamp, value: p.tickrate! }))}
            label="Tickrate"
            unit=""
            color="#34d399"
            formatValue={(v) => `${v.toFixed(0)}`}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add monitoring tab link**

In `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`, add:

```typescript
<Link href={`/servers/${server.id}/monitoring`}>Мониторинг →</Link>
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/MetricsChart.tsx apps/web/src/app/\(dashboard\)/servers/\[id\]/monitoring/page.tsx apps/web/src/app/\(dashboard\)/servers/\[id\]/page.tsx
git commit -m "feat(web): add monitoring page with CPU and memory time-series charts"
```

---

## Task 14: Depot Update Modal (Web)

**Files:**
- Create: `apps/web/src/components/DepotUpdateModal.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/page.tsx` (or wherever depot UI lives)

- [ ] **Step 1: Create the depot update modal**

```typescript
// apps/web/src/components/DepotUpdateModal.tsx
'use client';

import { useEffect, useId, useState } from 'react';

interface ServerEntry {
  id: string;
  display_name: string;
  status: string;
  player_count: number;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  servers: ServerEntry[];
  onStart: (serverIds: string[]) => Promise<void>;
}

export function DepotUpdateModal({ open, onOpenChange, servers, onStart }: Props) {
  const titleId = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const runnableServers = servers.filter((s) => ['running', 'starting'].includes(s.status));

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleStart() {
    setBusy(true);
    try {
      await onStart(Array.from(selected));
      onOpenChange(false);
    } catch {
      // caller handles
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold text-neutral-100">
          Обновить Squad
        </h2>

        {runnableServers.length > 0 ? (
          <>
            <p className="mb-3 text-sm text-neutral-300">
              Эти серверы будут остановлены на время обновления (~10 мин):
            </p>
            <div className="mb-4 space-y-2">
              {runnableServers.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded border border-neutral-800 px-3 py-2 hover:border-neutral-700"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="accent-sky-600"
                  />
                  <span className="flex-1 text-sm text-neutral-200">{s.display_name}</span>
                  <span className="text-xs text-neutral-500">
                    {s.player_count} {s.player_count === 1 ? 'игрок' : 'игроков'}
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="mb-4 text-sm text-neutral-400">Нет запущенных серверов.</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleStart}
            className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {busy
              ? 'Запуск...'
              : selected.size > 0
                ? `Обновить (остановить ${selected.size})`
                : 'Обновить depot'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Integrate into dashboard**

In the dashboard page where depot status is shown, add a button and the modal:

```typescript
import { DepotUpdateModal } from '@/components/DepotUpdateModal';

// State:
const [depotModalOpen, setDepotModalOpen] = useState(false);

// Button:
<button
  type="button"
  onClick={() => setDepotModalOpen(true)}
  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:border-sky-700 hover:text-sky-300"
>
  Обновить Squad
</button>

// Modal:
<DepotUpdateModal
  open={depotModalOpen}
  onOpenChange={setDepotModalOpen}
  servers={(servers ?? []).map((s: any) => ({
    id: s.id,
    display_name: s.display_name,
    status: s.status,
    player_count: s.rcon_status?.player_count ?? 0,
  }))}
  onStart={async (serverIds) => {
    const r = await fetch('/api/v1/depot/update', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_ids: serverIds }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }}
/>
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DepotUpdateModal.tsx apps/web/src/app/\(dashboard\)/dashboard/page.tsx
git commit -m "feat(web): add coordinated depot update modal with server selection"
```

---

## Task 15: License Management (P1)

**Files:**
- Create: `packages/db/drizzle/0019_license_id.sql`
- Modify: `packages/db/src/schema/server-credentials.ts`
- Modify: `apps/api/src/routes/server-settings.ts` (PATCH handler)
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx`

- [ ] **Step 1: Create the migration**

```sql
-- packages/db/drizzle/0019_license_id.sql
ALTER TABLE server_credentials ADD COLUMN license_id text;
```

- [ ] **Step 2: Add column to Drizzle schema**

In `packages/db/src/schema/server-credentials.ts`, add:

```typescript
licenseId: text('license_id'),
```

- [ ] **Step 3: Handle license in PATCH /servers/:id handler**

In `apps/api/src/routes/server-settings.ts`, in the PATCH handler, after the servers update, handle license fields:

```typescript
if (body.license_id !== undefined || body.license_key !== undefined) {
  const credUpdate: Record<string, unknown> = {};
  if (body.license_id !== undefined) credUpdate.licenseId = body.license_id;
  if (body.license_key !== undefined) {
    credUpdate.licenseKeyEncrypted = body.license_key
      ? serialize(encryptString(app.encryptionKey, body.license_key))
      : null;
  }
  if (Object.keys(credUpdate).length > 0) {
    await app.db
      .update(serverCredentials)
      .set(credUpdate)
      .where(eq(serverCredentials.serverId, req.params.id));
  }
}
```

- [ ] **Step 4: Add license section to settings page**

In `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx`, add a "Лицензия" section:

```typescript
<section className="mb-6">
  <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
    Лицензия
  </h2>
  <p className="mb-2 text-xs text-neutral-500">Требуется перезапуск сервера</p>
  <div className="grid grid-cols-2 gap-3">
    <label className="block">
      <span className="text-xs text-neutral-500">License ID</span>
      <input
        value={licenseId}
        onChange={(e) => setLicenseId(e.target.value)}
        placeholder="Не указан"
        className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
      />
    </label>
    <label className="block">
      <span className="text-xs text-neutral-500">License Key</span>
      <input
        type="password"
        value={licenseKey}
        onChange={(e) => setLicenseKey(e.target.value)}
        placeholder="Не указан"
        className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
      />
    </label>
  </div>
  <div className="mt-2 flex gap-2">
    <button
      type="button"
      disabled={!licenseId || !licenseKey}
      onClick={saveLicense}
      className="rounded bg-sky-700 px-3 py-1.5 text-xs text-white hover:bg-sky-600 disabled:opacity-40"
    >
      Привязать
    </button>
    <button
      type="button"
      onClick={detachLicense}
      className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:border-red-700 hover:text-red-300"
    >
      Отвязать
    </button>
  </div>
</section>
```

Add state and handlers:

```typescript
const [licenseId, setLicenseId] = useState('');
const [licenseKey, setLicenseKey] = useState('');

async function saveLicense() {
  const r = await fetch(`/api/v1/servers/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ license_id: licenseId, license_key: licenseKey }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  setSaved(true);
  setTimeout(() => setSaved(false), 2000);
}

async function detachLicense() {
  const r = await fetch(`/api/v1/servers/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ license_id: null, license_key: null }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  setLicenseId('');
  setLicenseKey('');
  setSaved(true);
  setTimeout(() => setSaved(false), 2000);
}
```

- [ ] **Step 5: Run migration**

Run: `DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate`
Expected: Migration applied successfully

- [ ] **Step 6: Run typecheck and tests**

Run: `pnpm turbo run typecheck && pnpm --filter @squad/api test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/0019_license_id.sql packages/db/src/schema/server-credentials.ts apps/api/src/routes/server-settings.ts apps/web/src/app/\(dashboard\)/servers/\[id\]/settings/page.tsx
git commit -m "feat: add license management (P1) — DB migration, API, and settings UI"
```

---

## Task 16: Tags Management UI (P1)

**Files:**
- Create: `apps/web/src/components/TagInput.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/page.tsx`

- [ ] **Step 1: Create TagInput component**

```typescript
// apps/web/src/components/TagInput.tsx
'use client';

import { useState, useRef } from 'react';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  maxTags?: number;
}

export function TagInput({ tags, onChange, maxTags = 20 }: Props) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function addTag(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || tags.includes(trimmed) || tags.length >= maxTags) return;
    onChange([...tags, trimmed]);
    setInput('');
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="text-neutral-500 hover:text-red-400"
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTag(input);
          }
          if (e.key === 'Backspace' && input === '' && tags.length > 0) {
            removeTag(tags[tags.length - 1]!);
          }
        }}
        placeholder={tags.length === 0 ? 'Введите тег и нажмите Enter' : ''}
        className="min-w-[80px] flex-1 border-none bg-transparent text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
      />
    </div>
  );
}
```

- [ ] **Step 2: Add to settings page**

In `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx`, add a tags section after the header and before the Сеть section:

```typescript
import { TagInput } from '@/components/TagInput';

// Add state:
const [tags, setTags] = useState<string[]>([]);

// In load(), after setting serverInfo:
setTags(data.server.tags ?? []);

// Section JSX:
<section className="mb-6">
  <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
    Теги
  </h2>
  <TagInput tags={tags} onChange={async (newTags) => {
    setTags(newTags);
    await fetch(`/api/v1/servers/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: newTags }),
    });
  }} />
</section>
```

- [ ] **Step 3: Add tag chips and filter to server list**

In `apps/web/src/app/(dashboard)/servers/page.tsx`:

```typescript
// Add state for tag filter:
const [tagFilter, setTagFilter] = useState<string | null>(null);

// Collect all unique tags from servers:
const allTags = Array.from(new Set((servers ?? []).flatMap((s: any) => s.tags ?? [])));

// Filter dropdown:
{allTags.length > 0 && (
  <select
    value={tagFilter ?? ''}
    onChange={(e) => setTagFilter(e.target.value || null)}
    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-300"
  >
    <option value="">Все теги</option>
    {allTags.map((tag) => (
      <option key={tag} value={tag}>{tag}</option>
    ))}
  </select>
)}

// Apply filter to rendered list:
const filtered = (servers ?? []).filter((s: any) => {
  if (tagFilter && !(s.tags ?? []).includes(tagFilter)) return false;
  // ... existing search filter
  return true;
});

// Tag chips in table rows:
{(s.tags ?? []).map((tag: string) => (
  <span
    key={tag}
    className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
  >
    {tag}
  </span>
))}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm turbo run typecheck --filter=@squad/web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/TagInput.tsx apps/web/src/app/\(dashboard\)/servers/\[id\]/settings/page.tsx apps/web/src/app/\(dashboard\)/servers/page.tsx
git commit -m "feat(web): add tag management UI with chips, input, and filter (P1)"
```

---

## Task 17: Per-Server Game Update (P1)

**Files:**
- Create: `apps/api/src/routes/server-update.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`

- [ ] **Step 1: Create the update endpoint**

```typescript
// apps/api/src/routes/server-update.ts
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { servers } from '@squad/db/schema';

const idParams = z.object({ id: z.string().uuid() });

const serverUpdateRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/update',
    {
      config: {
        permissions: ['server:update'],
        audit: { action: 'server.game_update', resource: 'server' },
      },
      schema: { params: idParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (row.status !== 'stopped' && row.status !== 'ready') {
        reply.code(409);
        return { error: 'server_must_be_stopped' };
      }

      const existing = await app.redis.get('depot:updating');
      if (existing) {
        reply.code(409);
        return { error: 'depot_update_in_progress' };
      }

      const startedAt = new Date().toISOString();
      await app.redis.set('depot:updating', startedAt, 'EX', 3600);

      (async () => {
        const dedicated = app.makeBridgeClient();
        try {
          await dedicated.connect();
          await dedicated.depotUpdate((frame) => {
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            void app.redis.xadd(
              `server:update:${row.id}`,
              'MAXLEN',
              '~',
              '5000',
              '*',
              'stream',
              frame.stream,
              'text',
              text,
            );
          });
          await app.redis.set(
            'depot:last_update',
            JSON.stringify({ finished_at: new Date().toISOString(), status: 'ok' }),
          );
        } catch (err) {
          await app.redis.set(
            'depot:last_update',
            JSON.stringify({
              finished_at: new Date().toISOString(),
              status: 'failed',
              error: (err as Error).message,
            }),
          );
        } finally {
          await app.redis.del('depot:updating');
          await dedicated.close().catch(() => undefined);
        }
      })();

      return { status: 'started', server_id: row.id, started_at: startedAt };
    },
  );
};

export default serverUpdateRoutes;
```

- [ ] **Step 2: Register in server.ts**

```typescript
import serverUpdateRoutes from './routes/server-update.js';
app.register(serverUpdateRoutes);
```

- [ ] **Step 3: Add button to server detail page**

In `apps/web/src/app/(dashboard)/servers/[id]/page.tsx`, add an "Обновить игру" button visible only when stopped:

```typescript
{data?.server.status === 'stopped' && (
  <button
    type="button"
    onClick={async () => {
      setActing('update');
      try {
        const r = await fetch(`/api/v1/servers/${id}/update`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setActing(null);
      }
    }}
    disabled={acting !== null}
    className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-sky-700 hover:text-sky-300 disabled:opacity-40"
  >
    {acting === 'update' ? 'Обновление...' : 'Обновить игру'}
  </button>
)}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm turbo run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/server-update.ts apps/api/src/server.ts apps/web/src/app/\(dashboard\)/servers/\[id\]/page.tsx
git commit -m "feat: add per-server game update endpoint and UI button (P1)"
```

---

## Task 18: Performance Monitoring (P2)

**Files:**
- Modify: `apps/workers/rcon/src/supervisor.ts`
- Modify: `apps/workers/metrics-sampler/src/sampler.ts`

- [ ] **Step 1: Add tickrate to container metrics stream**

In `apps/workers/metrics-sampler/src/sampler.ts`, in the `collectContainerMetrics` function, after collecting stats, also read the RCON status for tickrate:

```typescript
// After stats collection for a server:
let tickrate: number | undefined;
try {
  const rconRaw = await redis.get(`rcon:status:${serverId}`);
  if (rconRaw) {
    const parsed = JSON.parse(rconRaw);
    if (typeof parsed.tickrate_rt === 'number') {
      tickrate = parsed.tickrate_rt;
    }
  }
} catch { /* non-critical */ }

// Include in xadd:
await redis.xadd(
  `container:metrics:${serverId}`,
  'MAXLEN', '~', '2880',
  '*',
  'v',
  JSON.stringify({
    cpu_percent: stats.cpu_percent,
    mem_bytes: stats.mem_used_bytes,
    mem_percent: stats.mem_percent,
    pids: stats.pids,
    tickrate,
    timestamp: stats.sampled_at,
  }),
);
```

- [ ] **Step 2: Add lag spike detection to RCON supervisor**

In `apps/workers/rcon/src/supervisor.ts`, after the RCON poll block where `tickrate_rt` is parsed, add lag detection:

```typescript
// Track consecutive low-tickrate polls:
private consecutiveLowTick = 0;

// In schedulePoll(), after parsing server info:
if (info?.tickrate !== undefined) {
  const configuredTickrate = this.target.tickrate ?? 50;
  const threshold = configuredTickrate * 0.8;
  if (info.tickrate < threshold) {
    this.consecutiveLowTick++;
    if (this.consecutiveLowTick >= 3) {
      await this.emitEvent('performance.degraded', {
        tickrate: info.tickrate,
        threshold,
        configured: configuredTickrate,
        consecutive_low: this.consecutiveLowTick,
      });
      this.opts.log.warn(
        { serverId: this.target.serverId, tickrate: info.tickrate, threshold },
        'performance degraded: tickrate below 80% target',
      );
    }
  } else {
    this.consecutiveLowTick = 0;
  }
}
```

The Target interface needs `tickrate` added. In the DB query that builds targets (in the worker's main loop), include `serverSettings.tickrate`.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @squad/worker-rcon test && pnpm --filter @squad/worker-metrics-sampler test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/workers/rcon/src/supervisor.ts apps/workers/metrics-sampler/src/sampler.ts
git commit -m "feat: add tickrate to metrics stream and lag spike detection (P2)"
```

---

## Task 19: Final Typecheck, Tests, and Rebuild

- [ ] **Step 1: Run full typecheck**

Run: `pnpm turbo run typecheck`
Expected: PASS across all packages

- [ ] **Step 2: Run full test suite**

Run: `pnpm turbo run test --force`
Expected: All tests PASS

- [ ] **Step 3: Lint**

Run: `pnpm biome check --write .`
Expected: Clean (auto-fixed if needed)

- [ ] **Step 4: Rebuild and restart affected containers**

Run: `docker compose up -d --build`
Expected: All services rebuild and start successfully

- [ ] **Step 5: Verify bridge (if bridge changes were made)**

Run: `sg panel -c 'bash scripts/verify-bridge.sh'`
Expected: All 17+ RPC methods pass

- [ ] **Step 6: Run sentrux scan**

Run: `/sentrux:scan` before and after to verify no regressions

- [ ] **Step 7: Update documentation**

Update these doc files based on what changed:
- `docs/components/api/api.md` — new endpoints
- `docs/components/api/flows.md` — new flows (force-stop, coordinated update, A2S, crash detection)
- `docs/components/api/data-model.md` — new Redis keys
- `docs/components/api/testing.md` — new test files
- `docs/components/api/changelog.md` — dated entries
- `docs/components/web/changelog.md` — new pages and components
- `docs/components/worker-rcon/api.md` — A2S integration
- `docs/components/worker-rcon/changelog.md`
- `docs/components/metrics-sampler/changelog.md`
- `docs/architecture/data-flow.md` — new Redis keys and data flows

- [ ] **Step 8: Final commit**

```bash
git add docs/
git commit -m "docs: update documentation for Epic 5 server management features"
```
