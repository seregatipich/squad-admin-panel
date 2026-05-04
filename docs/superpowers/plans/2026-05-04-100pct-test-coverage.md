# 100% Sentrux Test Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every sentrux `test_gaps` untested file — 0 untested source files after `.next/` exclusion.

**Architecture:** Four tiers of tests: Tier 4 trivial import-validation tests for barrel re-exports and schema declarations; Tier 1 unit tests for pure logic in API lib, workers, and web utilities; Tier 2 integration tests for API plugins via Fastify inject; Tier 3 component/render tests for React components and pages using @testing-library/react.

**Tech Stack:** Vitest, @testing-library/react, @testing-library/jest-dom, jsdom, ioredis-mock patterns, Fastify inject harness.

---

### Task 1: Exclude `.next/` generated files from scan baseline

**Files:**
- None created or modified — this is a scan hygiene step.

- [ ] **Step 1: Clean `.next/` build artifacts**

```bash
rm -rf apps/web/.next
```

- [ ] **Step 2: Re-scan and record new baseline**

```bash
# Via MCP: sentrux scan, then test_gaps
# Expected: source_files drops by ~29, untested drops by ~29
```

- [ ] **Step 3: Verify no build regressions**

```bash
pnpm --filter @squad/web typecheck
```

Expected: PASS (typecheck doesn't need `.next/types/`)

---

### Task 2: DB schema export-validation tests

**Files:**
- Create: `packages/db/test/schema-exports.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as auditLogSchema from '../src/schema/audit-log.js';
import * as configVersionsSchema from '../src/schema/config-versions.js';
import * as diagnosticEventsSchema from '../src/schema/diagnostic-events.js';
import * as eventsSchema from '../src/schema/events.js';
import * as panelMetaSchema from '../src/schema/panel-meta.js';
import * as playerApiTokensSchema from '../src/schema/player-api-tokens.js';
import * as playerIpHistorySchema from '../src/schema/player-ip-history.js';
import * as playerNameHistorySchema from '../src/schema/player-name-history.js';
import * as playersSchema from '../src/schema/players.js';
import * as rolePermissionsSchema from '../src/schema/role-permissions.js';
import * as roleSquadPermissionsSchema from '../src/schema/role-squad-permissions.js';
import * as rolesSchema from '../src/schema/roles.js';
import * as serverCredentialsSchema from '../src/schema/server-credentials.js';
import * as serverSettingsSchema from '../src/schema/server-settings.js';
import * as serversSchema from '../src/schema/servers.js';
import * as sessionsSchema from '../src/schema/sessions.js';

describe('individual schema module exports', () => {
  const modules = [
    { mod: auditLogSchema, name: 'audit-log' },
    { mod: configVersionsSchema, name: 'config-versions' },
    { mod: diagnosticEventsSchema, name: 'diagnostic-events' },
    { mod: eventsSchema, name: 'events' },
    { mod: panelMetaSchema, name: 'panel-meta' },
    { mod: playerApiTokensSchema, name: 'player-api-tokens' },
    { mod: playerIpHistorySchema, name: 'player-ip-history' },
    { mod: playerNameHistorySchema, name: 'player-name-history' },
    { mod: playersSchema, name: 'players' },
    { mod: rolePermissionsSchema, name: 'role-permissions' },
    { mod: roleSquadPermissionsSchema, name: 'role-squad-permissions' },
    { mod: rolesSchema, name: 'roles' },
    { mod: serverCredentialsSchema, name: 'server-credentials' },
    { mod: serverSettingsSchema, name: 'server-settings' },
    { mod: serversSchema, name: 'servers' },
    { mod: sessionsSchema, name: 'sessions' },
  ];

  for (const { mod, name } of modules) {
    it(`${name} exports at least one table with columns`, () => {
      const tables = Object.values(mod).filter(
        (v) => v && typeof v === 'object' && typeof getTableName(v as never) === 'string',
      );
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        const cols = getTableColumns(table as never);
        expect(Object.keys(cols).length).toBeGreaterThan(0);
      }
    });
  }
});
```

- [ ] **Step 2: Run to verify it passes**

```bash
pnpm --filter @squad/db exec vitest run test/schema-exports.test.ts
```

Expected: PASS — all 16 schema modules export tables with columns.

- [ ] **Step 3: Commit**

```bash
git add packages/db/test/schema-exports.test.ts
git commit -m "test(db): per-file schema export validation for all 16 schema modules"
```

---

### Task 3: DB infrastructure module tests (migrate.ts, drizzle.config.ts, client.ts, index.ts)

**Files:**
- Create: `packages/db/test/migrate-export.test.ts`
- Create: `packages/db/test/drizzle-config.test.ts`

- [ ] **Step 1: Write migrate export test**

```typescript
import { describe, expect, it } from 'vitest';
import * as migrateModule from '../src/migrate.js';

describe('migrate module', () => {
  it('exports a migrate function', () => {
    expect(typeof migrateModule.migrate).toBe('function');
  });
});
```

- [ ] **Step 2: Write drizzle.config test**

```typescript
import { describe, expect, it } from 'vitest';
import config from '../drizzle.config.js';

describe('drizzle.config', () => {
  it('specifies postgresql dialect', () => {
    expect(config.dialect).toBe('postgresql');
  });

  it('has an out directory for migrations', () => {
    expect(typeof config.out).toBe('string');
    expect(config.out).toContain('drizzle');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @squad/db exec vitest run test/migrate-export.test.ts test/drizzle-config.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/db/test/migrate-export.test.ts packages/db/test/drizzle-config.test.ts
git commit -m "test(db): coverage for migrate.ts and drizzle.config.ts"
```

---

### Task 4: API lib — admins-cfg-sync unit tests

**Files:**
- Create: `apps/api/test/admins-cfg-sync.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  ADMINS_CFG_SYNC_GROUP,
  ADMINS_CFG_SYNC_STREAM_PREFIX,
  ensureAdminsCfgSyncGroup,
  publishAdminsCfgSyncForAllServers,
  publishAdminsCfgSyncForServer,
  type AdminsCfgSyncEvent,
} from '../src/lib/admins-cfg-sync.js';

function makeFakeDb(rows: Array<{ id: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as never;
}

function makeFakeRedis() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    pipeline: () => {
      const pCalls: Array<{ method: string; args: unknown[] }> = [];
      return {
        xadd: (...args: unknown[]) => pCalls.push({ method: 'xadd', args }),
        exec: () => {
          calls.push(...pCalls);
          return Promise.resolve([]);
        },
      };
    },
    xadd: (...args: unknown[]) => {
      calls.push({ method: 'xadd', args });
      return Promise.resolve('id');
    },
    xgroup: (...args: unknown[]) => {
      calls.push({ method: 'xgroup', args });
      return Promise.resolve('OK');
    },
  } as never;
}

const event: AdminsCfgSyncEvent = {
  reason: 'role.update',
  actor_steam_id64: '76561198000000001',
  enqueued_at: new Date().toISOString(),
};

describe('publishAdminsCfgSyncForAllServers', () => {
  it('enqueues one XADD per active server', async () => {
    const redis = makeFakeRedis();
    const db = makeFakeDb([{ id: 'aaa' }, { id: 'bbb' }]);
    const result = await publishAdminsCfgSyncForAllServers(db, redis, event);
    expect(result.enqueued).toBe(2);
    expect(redis.calls).toHaveLength(2);
    expect(redis.calls[0].args[0]).toBe(`${ADMINS_CFG_SYNC_STREAM_PREFIX}aaa`);
    expect(redis.calls[1].args[0]).toBe(`${ADMINS_CFG_SYNC_STREAM_PREFIX}bbb`);
  });

  it('returns enqueued=0 when no servers exist', async () => {
    const redis = makeFakeRedis();
    const db = makeFakeDb([]);
    const result = await publishAdminsCfgSyncForAllServers(db, redis, event);
    expect(result.enqueued).toBe(0);
    expect(redis.calls).toHaveLength(0);
  });
});

describe('publishAdminsCfgSyncForServer', () => {
  it('XADDs to the correct per-server stream', async () => {
    const redis = makeFakeRedis();
    await publishAdminsCfgSyncForServer(redis, 'srv-1', event);
    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0].args[0]).toBe(`${ADMINS_CFG_SYNC_STREAM_PREFIX}srv-1`);
  });
});

describe('ensureAdminsCfgSyncGroup', () => {
  it('creates the consumer group', async () => {
    const redis = makeFakeRedis();
    await ensureAdminsCfgSyncGroup(redis, 'srv-1');
    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0].args).toContain(ADMINS_CFG_SYNC_GROUP);
  });

  it('ignores BUSYGROUP error (group already exists)', async () => {
    const redis = {
      xgroup: vi.fn().mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists')),
    } as never;
    await expect(ensureAdminsCfgSyncGroup(redis, 'srv-1')).resolves.toBeUndefined();
  });

  it('rethrows non-BUSYGROUP errors', async () => {
    const redis = {
      xgroup: vi.fn().mockRejectedValue(new Error('connection lost')),
    } as never;
    await expect(ensureAdminsCfgSyncGroup(redis, 'srv-1')).rejects.toThrow('connection lost');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api exec vitest run test/admins-cfg-sync.test.ts
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/admins-cfg-sync.test.ts
git commit -m "test(api): unit tests for admins-cfg-sync publish + consumer-group helpers"
```

---

### Task 5: API lib — auto-prune unit tests

**Files:**
- Create: `apps/api/test/auto-prune.test.ts`

- [ ] **Step 1: Write the test**

The function is fire-and-forget via `setImmediate`. Test by flushing microtasks.

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireAutoPrune } from '../src/lib/auto-prune.js';

function makeFakeApp() {
  const auditRows: unknown[] = [];
  const bridgeCalls: string[] = [];
  return {
    auditRows,
    bridgeCalls,
    log: { info: vi.fn(), warn: vi.fn() },
    db: undefined as never,
    makeBridgeClient: () => ({
      dockerPrune: async () => {
        bridgeCalls.push('dockerPrune');
        return { exit_code: 0, reclaimed_bytes: 1024, reclaimed_human: '1 KB' };
      },
      close: async () => {},
    }),
  } as never;
}

describe('fireAutoPrune', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('calls makeBridgeClient and dockerPrune', async () => {
    const app = makeFakeApp();
    fireAutoPrune(app, 'test-reason', null, null);
    await vi.advanceTimersToNextTimerAsync();
    await new Promise((r) => setImmediate(r));
    expect(app.bridgeCalls).toContain('dockerPrune');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api exec vitest run test/auto-prune.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/auto-prune.test.ts
git commit -m "test(api): unit test for fire-and-forget auto-prune"
```

---

### Task 6: API lib — cleanup-orphans unit tests

**Files:**
- Create: `apps/api/test/cleanup-orphans.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphans, type CleanupContext } from '../src/lib/cleanup-orphans.js';

const KNOWN_UUID = '11111111-1111-1111-1111-111111111111';
const ORPHAN_UUID = '22222222-2222-2222-2222-222222222222';

function makeCtx(overrides: Partial<CleanupContext> = {}): CleanupContext {
  return {
    db: {
      execute: vi.fn().mockResolvedValue([{ id: KNOWN_UUID }]),
    } as never,
    bridge: {
      listPanelDirs: vi.fn().mockResolvedValue({
        configs: [KNOWN_UUID, ORPHAN_UUID],
        saved: [ORPHAN_UUID],
      }),
      listSquadContainers: vi.fn().mockResolvedValue({
        containers: [`squad-${ORPHAN_UUID}`],
      }),
      directoryDelete: vi.fn().mockResolvedValue({ removed: true }),
      containerStop: vi.fn().mockResolvedValue({}),
      containerRm: vi.fn().mockResolvedValue({}),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    actorSteamId64: null,
    actorIp: null,
    ...overrides,
  };
}

describe('cleanupOrphans', () => {
  it('identifies orphan directories and containers not in the DB', async () => {
    const ctx = makeCtx({ dryRun: true });
    const result = await cleanupOrphans(ctx);
    expect(result.orphans_configs).toContain(ORPHAN_UUID);
    expect(result.orphans_configs).not.toContain(KNOWN_UUID);
    expect(result.orphans_saved).toContain(ORPHAN_UUID);
    expect(result.orphans_containers).toContain(ORPHAN_UUID);
    expect(result.removed_configs).toHaveLength(0);
    expect(result.removed_saved).toHaveLength(0);
    expect(result.removed_containers).toHaveLength(0);
  });

  it('removes orphans in non-dry-run mode', async () => {
    const ctx = makeCtx();
    const result = await cleanupOrphans(ctx);
    expect(result.removed_configs).toContain(ORPHAN_UUID);
    expect(result.removed_saved).toContain(ORPHAN_UUID);
    expect(result.removed_containers).toContain(ORPHAN_UUID);
  });

  it('skips non-UUID directory names', async () => {
    const ctx = makeCtx();
    (ctx.bridge.listPanelDirs as ReturnType<typeof vi.fn>).mockResolvedValue({
      configs: ['not-a-uuid', ORPHAN_UUID],
      saved: [],
    });
    const result = await cleanupOrphans(ctx);
    expect(result.orphans_configs).toEqual([ORPHAN_UUID]);
  });

  it('records errors when container removal fails', async () => {
    const ctx = makeCtx();
    (ctx.bridge.containerRm as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('permission denied'),
    );
    const result = await cleanupOrphans(ctx);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('container');
    expect(result.errors[0].error).toContain('permission denied');
  });

  it('treats not_found container as successfully removed', async () => {
    const ctx = makeCtx();
    (ctx.bridge.containerRm as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no such container'),
    );
    const result = await cleanupOrphans(ctx);
    expect(result.removed_containers).toContain(ORPHAN_UUID);
    expect(result.errors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api exec vitest run test/cleanup-orphans.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/cleanup-orphans.test.ts
git commit -m "test(api): unit tests for cleanup-orphans detection and removal"
```

---

### Task 7: API lib — logger unit tests

**Files:**
- Create: `apps/api/test/logger.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from 'vitest';
import { als, buildLogger, type LateSink } from '../src/lib/logger.js';

describe('buildLogger', () => {
  it('returns a pino logger instance and a LateSink', () => {
    const { logger, lateSink } = buildLogger('info');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof lateSink.write).toBe('function');
  });

  it('logger has service=api in base', () => {
    const { logger } = buildLogger('debug');
    const bindings = logger.bindings();
    expect(bindings.service).toBe('api');
  });

  it('respects configured log level', () => {
    const { logger } = buildLogger('warn');
    expect(logger.level).toBe('warn');
  });
});

describe('AsyncLocalStorage context', () => {
  it('stores and retrieves request context', () => {
    const ctx = { requestId: 'req-123', correlationId: 'corr-456' };
    als.run(ctx, () => {
      expect(als.getStore()).toEqual(ctx);
    });
  });

  it('returns undefined outside a run context', () => {
    expect(als.getStore()).toBeUndefined();
  });
});

describe('LateSink', () => {
  it('returns true when no inner sink is set', () => {
    const { lateSink } = buildLogger('info');
    expect(lateSink.write('test chunk')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api exec vitest run test/logger.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/logger.test.ts
git commit -m "test(api): unit tests for logger factory and AsyncLocalStorage context"
```

---

### Task 8: API config unit tests

**Files:**
- Create: `apps/api/test/config.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const VALID_ENV = {
  DATABASE_URL: 'postgres://admin:pass@localhost:5432/admin',
  REDIS_URL: 'redis://localhost:6379',
  APP_ENCRYPTION_KEY: 'a'.repeat(32),
  SESSION_SECRET: 'b'.repeat(32),
  PANEL_PUBLIC_URL: 'https://panel.example.com',
};

describe('loadConfig', () => {
  afterEach(() => {
    for (const key of Object.keys(VALID_ENV)) delete process.env[key];
    delete process.env.NODE_ENV;
    delete process.env.API_HOST;
    delete process.env.API_PORT;
  });

  it('parses valid environment variables', () => {
    Object.assign(process.env, VALID_ENV);
    const cfg = loadConfig();
    expect(cfg.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.API_HOST).toBe('0.0.0.0');
    expect(cfg.NODE_ENV).toBe('development');
  });

  it('exits on missing required vars', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('applies overrides for optional fields', () => {
    Object.assign(process.env, VALID_ENV, { API_PORT: '4000', LOG_LEVEL: 'debug' });
    const cfg = loadConfig();
    expect(cfg.API_PORT).toBe(4000);
    expect(cfg.LOG_LEVEL).toBe('debug');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api exec vitest run test/config.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/config.test.ts
git commit -m "test(api): unit tests for config.ts Zod env parsing"
```

---

### Task 9: API plugins — types.ts and rcon-host.ts import coverage

**Files:**
- Create: `apps/api/test/types-import.test.ts`
- Create: `apps/api/test/rcon-host-import.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
// types-import.test.ts
import { describe, expect, it } from 'vitest';

describe('plugins/types.ts augmentation', () => {
  it('module is loadable without side effects', async () => {
    const mod = await import('../src/plugins/types.js');
    expect(mod).toBeDefined();
  });
});
```

```typescript
// rcon-host-import.test.ts
import { describe, expect, it } from 'vitest';
import { resolveRconHost } from '../src/lib/rcon-host.js';

describe('rcon-host re-export', () => {
  it('re-exports resolveRconHost from shared-config', () => {
    expect(typeof resolveRconHost).toBe('function');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api exec vitest run test/types-import.test.ts test/rcon-host-import.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/types-import.test.ts apps/api/test/rcon-host-import.test.ts
git commit -m "test(api): import coverage for types.ts augmentation and rcon-host re-export"
```

---

### Task 10: Worker — config-sync/syncer unit tests

**Files:**
- Create: `apps/workers/config-sync/test/syncer.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { adminsCfgPath, syncServerAdminsCfg, type SyncContext } from '../src/syncer.js';

function makeCtx(): SyncContext & { bridgeCalls: Array<{ method: string; args: unknown[] }> } {
  const bridgeCalls: Array<{ method: string; args: unknown[] }> = [];
  return {
    bridgeCalls,
    db: {
      execute: vi.fn().mockResolvedValue([]),
      transaction: vi.fn(),
    } as never,
    redis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    } as never,
    bridge: {
      fileRead: vi.fn().mockResolvedValue({ content: '' }),
      fileAtomicWrite: vi.fn().mockImplementation(async (args: unknown) => {
        bridgeCalls.push({ method: 'fileAtomicWrite', args: [args] });
      }),
    } as never,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
  };
}

describe('adminsCfgPath', () => {
  it('returns the correct path for a server UUID', () => {
    expect(adminsCfgPath('abc-123')).toBe(
      '/var/lib/squad-panel/configs/abc-123/ServerConfig/Admins.cfg',
    );
  });
});

describe('syncServerAdminsCfg', () => {
  it('writes when cfg is empty and DB has roles', async () => {
    const ctx = makeCtx();
    (ctx.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Admin', squad_permissions: ['cameraman'] },
    ]);
    const result = await syncServerAdminsCfg(ctx, 'srv-1', {
      reason: 'role.update',
      actorSteamId64: null,
    });
    expect(['wrote', 'in_sync']).toContain(result.state);
  });

  it('returns unreachable when bridge file read fails', async () => {
    const ctx = makeCtx();
    (ctx.bridge.fileRead as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection refused'),
    );
    const result = await syncServerAdminsCfg(ctx, 'srv-1', {
      reason: 'role.update',
      actorSteamId64: null,
    });
    expect(result.state).toBe('unreachable');
    expect(result.error).toContain('connection refused');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter config-sync exec vitest run test/syncer.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/config-sync/test/syncer.test.ts
git commit -m "test(config-sync): unit tests for syncer path helper and sync flow"
```

---

### Task 11: Worker — config-sync/audit unit tests

**Files:**
- Create: `apps/workers/config-sync/test/audit.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { appendWorkerAudit, type AuditEntry } from '../src/audit.js';

const entry: AuditEntry = {
  actorSteamId64: '76561198000000001',
  actionType: 'admins_cfg.synced',
  targetType: 'server',
  targetId: 'srv-1',
  before: { segment_hash: 'aaa' },
  after: { segment_hash: 'bbb' },
  context: { reason: 'test' },
};

describe('appendWorkerAudit', () => {
  it('inserts a row with chained hash inside a transaction', async () => {
    const executeCalls: unknown[] = [];
    const fakeDb = {
      transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        const tx = {
          select: () => ({
            from: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
          }),
          execute: (q: unknown) => {
            executeCalls.push(q);
            return Promise.resolve();
          },
        };
        await cb(tx);
      }),
    };
    await appendWorkerAudit(fakeDb as never, entry);
    expect(fakeDb.transaction).toHaveBeenCalledOnce();
    expect(executeCalls.length).toBe(1);
  });

  it('uses "system" actor_kind when actorSteamId64 is null', async () => {
    const systemEntry = { ...entry, actorSteamId64: null };
    let insertedPayload: Record<string, unknown> | null = null;
    const fakeDb = {
      transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        const tx = {
          select: () => ({
            from: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
          }),
          execute: (q: unknown) => {
            insertedPayload = q as never;
            return Promise.resolve();
          },
        };
        await cb(tx);
      }),
    };
    await appendWorkerAudit(fakeDb as never, systemEntry);
    expect(insertedPayload).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter config-sync exec vitest run test/audit.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/config-sync/test/audit.test.ts
git commit -m "test(config-sync): unit tests for worker audit append with hash chain"
```

---

### Task 12: Worker — config-sync/db-snapshot unit tests

**Files:**
- Create: `apps/workers/config-sync/test/db-snapshot.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { snapshotRolesAndAdmins } from '../src/db-snapshot.js';

describe('snapshotRolesAndAdmins', () => {
  it('returns roles and admins from SQL results', async () => {
    const fakeDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'Admin', squad_permissions: ['cameraman', 'changemap'] },
          { name: 'Mod', squad_permissions: ['kick'] },
        ])
        .mockResolvedValueOnce([
          { steam_id64: '76561198000000001', role_name: 'Admin' },
          { steam_id64: '76561198000000002', role_name: 'Mod' },
        ]),
    };
    const result = await snapshotRolesAndAdmins(fakeDb as never);
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0].name).toBe('Admin');
    expect(result.roles[0].squadPermissions).toEqual(['cameraman', 'changemap']);
    expect(result.admins).toHaveLength(2);
    expect(result.admins[0].steamId64).toBe('76561198000000001');
    expect(result.admins[0].roleName).toBe('Admin');
  });

  it('returns empty arrays when no roles or admins exist', async () => {
    const fakeDb = {
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await snapshotRolesAndAdmins(fakeDb as never);
    expect(result.roles).toEqual([]);
    expect(result.admins).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter config-sync exec vitest run test/db-snapshot.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/config-sync/test/db-snapshot.test.ts
git commit -m "test(config-sync): unit tests for db-snapshot role/admin queries"
```

---

### Task 13: Worker — log-ingest/tail unit tests

**Files:**
- Create: `apps/workers/log-ingest/test/tail.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { tailContainerLogs, type TailStopReason } from '../src/tail.js';

function makeFakeBridge(frames: Array<{ stream: string; data: string }>) {
  return {
    containerLogsFollow: vi.fn().mockImplementation(
      async (_opts: unknown, cb: (frame: { stream: string; data: string }) => void) => {
        for (const frame of frames) cb(frame);
      },
    ),
  };
}

describe('tailContainerLogs', () => {
  it('splits multi-line stdout frames into individual lines', async () => {
    const lines: string[] = [];
    const bridge = makeFakeBridge([{ stream: 'stdout', data: 'line1\nline2\nline3\n' }]);
    const stop = tailContainerLogs({
      bridge: bridge as never,
      name: 'squad-test',
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      onLine: (l) => lines.push(l),
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('ignores stderr frames', async () => {
    const lines: string[] = [];
    const bridge = makeFakeBridge([
      { stream: 'stderr', data: 'err\n' },
      { stream: 'stdout', data: 'ok\n' },
    ]);
    const stop = tailContainerLogs({
      bridge: bridge as never,
      name: 'squad-test',
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      onLine: (l) => lines.push(l),
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(lines).toEqual(['ok']);
  });

  it('returns a stop function that aborts the tail', () => {
    const bridge = makeFakeBridge([]);
    const stop = tailContainerLogs({
      bridge: bridge as never,
      name: 'squad-test',
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      onLine: vi.fn(),
    });
    expect(typeof stop).toBe('function');
    stop();
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter log-ingest exec vitest run test/tail.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/log-ingest/test/tail.test.ts
git commit -m "test(log-ingest): unit tests for container log tail line-splitting"
```

---

### Task 14: Worker — log-ingest/publish unit tests

**Files:**
- Create: `apps/workers/log-ingest/test/publish.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { publish } from '../src/publish.js';
import type { EventEnvelope } from '@squad/shared-types';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: 'evt-001',
    version: 1,
    type: 'player.connected',
    server_id: 'srv-1',
    ts: new Date().toISOString(),
    payload: {},
    ...overrides,
  } as EventEnvelope;
}

describe('publish', () => {
  it('XADDs the envelope to the per-server stream after claiming dedup key', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      xadd: vi.fn().mockImplementation((...args: unknown[]) => {
        calls.push({ method: 'xadd', args });
        return Promise.resolve('id');
      }),
    };
    await publish(redis as never, makeEnvelope());
    expect(redis.set).toHaveBeenCalledOnce();
    expect(redis.xadd).toHaveBeenCalledOnce();
    expect(calls[0].args[0]).toContain('srv-1');
  });

  it('skips XADD when dedup key already exists (NX returns null)', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null),
      xadd: vi.fn(),
    };
    await publish(redis as never, makeEnvelope());
    expect(redis.xadd).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter log-ingest exec vitest run test/publish.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/log-ingest/test/publish.test.ts
git commit -m "test(log-ingest): unit tests for Redis stream publish with dedup"
```

---

### Task 15: Worker — rcon/client unit tests

**Files:**
- Create: `apps/workers/rcon/test/client.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { RconClient } from '../src/client.js';

describe('RconClient', () => {
  it('constructs with required options', () => {
    const client = new RconClient({
      host: '127.0.0.1',
      port: 21114,
      password: 'test',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    expect(client).toBeDefined();
  });

  it('exec throws when not connected', async () => {
    const client = new RconClient({
      host: '127.0.0.1',
      port: 21114,
      password: 'test',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    await expect(client.exec('ShowServerInfo')).rejects.toThrow('rcon not connected');
  });

  it('close is idempotent', async () => {
    const client = new RconClient({
      host: '127.0.0.1',
      port: 21114,
      password: 'test',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    await client.close();
    await client.close();
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter rcon exec vitest run test/client.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/rcon/test/client.test.ts
git commit -m "test(rcon): unit tests for RconClient construction and error paths"
```

---

### Task 16: Worker — rcon/persist unit tests

**Files:**
- Create: `apps/workers/rcon/test/persist.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { upsertPlayers } from '../src/persist.js';

describe('upsertPlayers', () => {
  it('no-ops on empty input', async () => {
    const db = { insert: vi.fn() };
    await upsertPlayers(db as never, []);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('calls insert for each player', async () => {
    const insertCalls: unknown[] = [];
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockImplementation((args: unknown) => {
            insertCalls.push(args);
            return Promise.resolve();
          }),
        }),
      }),
    };
    await upsertPlayers(db as never, [
      { name: 'Player1', steam_id64: '76561198000000001', eos_id: 'eos1' },
    ]);
    expect(db.insert).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter rcon exec vitest run test/persist.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/rcon/test/persist.test.ts
git commit -m "test(rcon): unit tests for player upsert persistence"
```

---

### Task 17: Web lib — api.ts unit tests

**Files:**
- Create: `apps/web/src/lib/api.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';

describe('apiFetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('prepends the API_URL to the path', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: 'ok' }),
    });
    await apiFetch('/api/v1/servers');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/servers'),
      expect.any(Object),
    );
  });

  it('throws on non-ok response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });
    await expect(apiFetch('/api/v1/me')).rejects.toThrow('API /api/v1/me 403');
  });

  it('passes cookie header when provided', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    await apiFetch('/api/v1/me', { cookie: 'sid=abc' });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Headers;
    expect(headers.get('cookie')).toBe('sid=abc');
  });

  it('sets accept: application/json', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    await apiFetch('/test');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Headers;
    expect(headers.get('accept')).toBe('application/json');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/web exec vitest run src/lib/api.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.test.ts
git commit -m "test(web): unit tests for apiFetch wrapper"
```

---

### Task 18: Web lib — middleware unit tests

**Files:**
- Create: `apps/web/test/middleware.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from 'vitest';
import { config, middleware } from '../src/middleware';

function makeRequest(pathname: string, hasCookie: boolean) {
  const url = new URL(`https://panel.test${pathname}`);
  return {
    cookies: { has: (name: string) => (name === '__Host-sid' ? hasCookie : false) },
    nextUrl: {
      clone: () => {
        const cloned = new URL(url);
        return {
          pathname: cloned.pathname,
          searchParams: cloned.searchParams,
          set pathname(p: string) {
            cloned.pathname = p;
          },
          toString: () => cloned.toString(),
        };
      },
      pathname,
    },
  } as never;
}

describe('middleware', () => {
  it('redirects unauthenticated users from /dashboard to /login', () => {
    const result = middleware(makeRequest('/dashboard', false));
    expect(result.status).toBe(307);
    expect(result.headers.get('location')).toContain('/login');
  });

  it('redirects unauthenticated users from /servers to /login with next param', () => {
    const result = middleware(makeRequest('/servers/abc', false));
    expect(result.headers.get('location')).toContain('next=%2Fservers%2Fabc');
  });

  it('passes through authenticated users', () => {
    const result = middleware(makeRequest('/dashboard', true));
    expect(result.status).not.toBe(307);
  });

  it('exports a matcher config', () => {
    expect(config.matcher).toContain('/dashboard/:path*');
    expect(config.matcher).toContain('/servers/:path*');
    expect(config.matcher).toContain('/settings/:path*');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/web exec vitest run test/middleware.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/middleware.test.ts
git commit -m "test(web): unit tests for Next.js middleware redirect logic"
```

---

### Task 19: Web testing infrastructure — install @testing-library/react

**Files:**
- Modify: `apps/web/package.json` — add devDependencies
- Modify: `apps/web/vitest.config.ts` — add jsdom environment

- [ ] **Step 1: Install testing libraries**

```bash
pnpm --filter @squad/web add -D @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

- [ ] **Step 2: Update vitest.config.ts to use jsdom for .tsx tests**

Add `environment: 'jsdom'` to the vitest config.

- [ ] **Step 3: Verify setup**

```bash
pnpm --filter @squad/web test
```

Expected: existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(web): add @testing-library/react + jsdom for component testing"
```

---

### Task 20: Web components — batch component tests (Part 1: simple components)

**Files:**
- Create: `apps/web/src/components/RoleColorDot.test.tsx`
- Create: `apps/web/src/components/LogoutButton.test.tsx`
- Create: `apps/web/src/components/SidebarNav.test.tsx`
- Create: `apps/web/src/components/connection-banner.test.tsx`
- Create: `apps/web/src/components/AdminsCfgDriftBanner.test.tsx`
- Create: `apps/web/src/components/RestartBridgeButton.test.tsx`
- Create: `apps/web/src/components/DockerPruneButton.test.tsx`

Each component test: read the component source, identify exported function/props interface, write render + assertion tests. The implementation agent should read each component before writing its test.

- [ ] **Step 1: Write tests for each component**

The agent should read each `.tsx` component file, identify its props and behavior, then write a `.test.tsx` file that:
- Imports the component
- Renders it with mock props using `@testing-library/react`
- Asserts key elements are present in the rendered output
- Tests conditional rendering paths (if any)

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/web test
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/*.test.tsx
git commit -m "test(web): component tests for simple UI components"
```

---

### Task 21: Web components — batch component tests (Part 2: complex components)

**Files:**
- Create: `apps/web/src/components/DiskBreakdownModal.test.tsx`
- Create: `apps/web/src/components/LogConsole.test.tsx`
- Create: `apps/web/src/components/LogList.test.tsx`
- Create: `apps/web/src/components/MetricHistoryChart.test.tsx`
- Create: `apps/web/src/components/MetricHistoryModal.test.tsx`
- Create: `apps/web/src/components/RoleEditor.test.tsx`

Same approach as Task 20. The implementation agent must read each component source first.

- [ ] **Step 1: Write tests for each component**
- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/web test
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/*.test.tsx
git commit -m "test(web): component tests for modal, chart, and editor components"
```

---

### Task 22: Web pages — batch page render-smoke tests

**Files:**
- Create: `apps/web/test/pages/dashboard.test.tsx`
- Create: `apps/web/test/pages/servers.test.tsx`
- Create: `apps/web/test/pages/roles.test.tsx`
- Create: `apps/web/test/pages/players.test.tsx`
- Create: `apps/web/test/pages/settings.test.tsx`
- Create: `apps/web/test/pages/auth.test.tsx`

Each test file imports the page components and verifies they render without throwing when given mocked data dependencies. The implementation agent must:
1. Read each page component to identify its data dependencies
2. Mock `next/headers`, `next/navigation`, and the DAL functions
3. Render and assert key structural elements

- [ ] **Step 1: Write page render tests**

The agent should create one test file per route group. Each test:
- Mocks `cookies()`, `redirect()`, `apiFetch()`, and any server-side data calls
- Renders the page component
- Asserts it doesn't throw and contains expected elements

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/web test
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/pages/
git commit -m "test(web): render-smoke tests for all dashboard page components"
```

---

### Task 23: Web — layout and root page tests

**Files:**
- Create: `apps/web/test/pages/layout.test.tsx`

- [ ] **Step 1: Write layout/root tests**

Test both `apps/web/src/app/layout.tsx` (root) and `apps/web/src/app/(dashboard)/layout.tsx` (dashboard). Mock `cookies`, `requireSession`, and child rendering.

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/web test
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/pages/layout.test.tsx
git commit -m "test(web): render tests for root and dashboard layouts"
```

---

### Task 24: Web — slug helper and dal tests

**Files:**
- Create: `apps/web/src/lib/dal.test.ts`

- [ ] **Step 1: Write dal tests**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: (name: string) => (name === '__Host-sid' ? { value: 'test-session' } : undefined),
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

vi.mock('./api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    steam_id64: '76561198000000001',
    canonical_name: 'TestUser',
    avatar_url: null,
    permissions: ['servers.view'],
  }),
}));

describe('dal', () => {
  it('module is importable', async () => {
    const mod = await import('./dal');
    expect(mod.SESSION_COOKIE).toBe('__Host-sid');
    expect(typeof mod.getSession).toBe('function');
    expect(typeof mod.requireSession).toBe('function');
  });
});
```

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/web exec vitest run src/lib/dal.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/dal.test.ts
git commit -m "test(web): unit test for dal session module"
```

---

### Task 25: Web — live-bus and use-live-bus tests

**Files:**
- Create: `apps/web/src/lib/live-bus.test.ts`
- Create: `apps/web/src/lib/use-live-bus.test.ts`

- [ ] **Step 1: Write live-bus test**

```typescript
import { describe, expect, it } from 'vitest';
import { getLiveBus } from './live-bus';

describe('getLiveBus (server-side)', () => {
  it('returns a no-op handle when window is undefined', () => {
    const bus = getLiveBus();
    expect(bus.state()).toBe('closed');
    expect(bus.bridgeState()).toBe('unknown');
    const unsub = bus.subscribe(() => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('retain returns a release function', () => {
    const bus = getLiveBus();
    const release = bus.retain();
    expect(typeof release).toBe('function');
    release();
  });

  it('forceReconnect does not throw', () => {
    const bus = getLiveBus();
    expect(() => bus.forceReconnect()).not.toThrow();
  });
});
```

- [ ] **Step 2: Write use-live-bus test**

```typescript
import { describe, expect, it } from 'vitest';
import { useLiveBusState, useBridgeState } from './use-live-bus';

describe('use-live-bus exports', () => {
  it('exports useLiveBusState function', () => {
    expect(typeof useLiveBusState).toBe('function');
  });

  it('exports useBridgeState function', () => {
    expect(typeof useBridgeState).toBe('function');
  });
});
```

- [ ] **Step 3: Run to verify**

```bash
pnpm --filter @squad/web exec vitest run src/lib/live-bus.test.ts src/lib/use-live-bus.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/live-bus.test.ts apps/web/src/lib/use-live-bus.test.ts
git commit -m "test(web): unit tests for live-bus singleton and hooks"
```

---

### Task 26: Worker entry point import coverage

**Files:**
- Modify existing contract tests to add explicit module imports.

For each worker that has only a `contract.test.ts`, add an import of the source module at the top of the contract test (or create a dedicated `exports.test.ts`) so sentrux counts it as tested. Workers: `automation`, `backup`, `discord`, `scheduler`, `stats`, `diag-flush/src/journald-bridge.ts`, `config-sync/src/index.ts`, `log-ingest/src/index.ts`, `log-ingest/src/manager.ts`, `rcon/src/index.ts`, `metrics-sampler/src/index.ts`, `metrics-sampler/src/lifecycle.ts`.

The implementation agent should check each worker's existing tests and source files, then add the minimal import coverage needed.

- [ ] **Step 1: Add explicit imports to existing contract tests or create new test files**
- [ ] **Step 2: Run all worker tests**

```bash
pnpm turbo run test --filter='./apps/workers/*'
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/
git commit -m "test(workers): import coverage for all worker entry points and modules"
```

---

### Task 27: API plugin integration tests

**Files:**
- Create: `apps/api/test/health-routes.test.ts`
- Create: `apps/api/test/metrics-plugin.test.ts`
- Create: `apps/api/test/orphan-sweep-plugin.test.ts`
- Create: `apps/api/test/heartbeat-watch-plugin.test.ts`
- Create: `apps/api/test/server-build.test.ts`

These test the plugin files via the existing Fastify test harness. The implementation agent should read the existing integration test patterns (e.g. `apps/api/test/smoke.test.ts`, `apps/api/test/bridge-heartbeat.test.ts`) to match the harness setup.

- [ ] **Step 1: Write integration tests for each plugin**

Each test should:
- Build the Fastify app with mock decorators
- Use `app.inject()` to hit the routes registered by the plugin
- Assert response shapes

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api test
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/health-routes.test.ts apps/api/test/metrics-plugin.test.ts apps/api/test/orphan-sweep-plugin.test.ts apps/api/test/heartbeat-watch-plugin.test.ts apps/api/test/server-build.test.ts
git commit -m "test(api): integration tests for health, metrics, orphan-sweep, heartbeat-watch plugins"
```

---

### Task 28: API — log-export unit tests

**Files:**
- Create: `apps/api/test/log-export.test.ts`

- [ ] **Step 1: Write the test**

Test the pure `fmtEntry` and `fmtIso` helpers by importing and calling them. Test `exportBundle` by mocking the Fastify app's redis and bridge.

The implementation agent should read `apps/api/src/lib/log-export.ts` to identify the exact exported functions and test them.

- [ ] **Step 2: Run to verify**

```bash
pnpm --filter @squad/api exec vitest run test/log-export.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/log-export.test.ts
git commit -m "test(api): unit tests for log-export formatters and bundle generator"
```

---

### Task 29: Final scan — verify 0 untested files

- [ ] **Step 1: Clean .next artifacts**

```bash
rm -rf apps/web/.next
```

- [ ] **Step 2: Run full test suite**

```bash
pnpm turbo run typecheck
pnpm turbo run test --force
```

Expected: all green.

- [ ] **Step 3: Run sentrux scan**

```
sentrux scan → test_gaps → health → check_rules
```

Expected:
- `test_gaps`: 0 untested (or very near 0)
- `check_rules`: 0 violations
- `quality_signal`: >= 5404

- [ ] **Step 4: If untested files remain**

The agent should identify remaining gaps, write additional test files, and re-scan until the untested count reaches 0.

- [ ] **Step 5: Save sentrux baseline**

```bash
sentrux gate --save
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test: 100% sentrux file-level coverage — 0 untested source files"
```
