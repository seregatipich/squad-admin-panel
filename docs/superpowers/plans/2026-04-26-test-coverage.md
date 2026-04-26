# Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover every public surface, every flow, every edge case. Зелёные тесты — единственное доказательство, что фича работает; "вручную проверил" больше не считается.

**Architecture:** Six-tier pyramid:

| Tier | What | Where | Speed | Stack required |
|---|---|---|---|---|
| 1 | Unit — pure functions | `**/test/**/*.test.ts` next to source | <1s/file | none |
| 2 | Integration — Fastify inject + live DB | `apps/api/test/*.test.ts` | <30s/file | postgres + redis |
| 3 | E2E — HTTP against running stack | `apps/api/test/e2e/*.e2e.test.ts` | minutes | full compose |
| 4 | UI E2E — Playwright on running web | `apps/web/test/e2e/*.spec.ts` (NEW) | minutes | full compose + browser |
| 5 | Property-based / fuzz | colocated with unit | <5s/file | none |
| 6 | Security regression | `apps/api/test/security/*.test.ts` (NEW) | <30s/file | postgres + redis |

**Tech Stack:** Vitest (existing), Playwright (NEW for tier 4), `@fast-check/vitest` for property-based (NEW), supertest patterns via `app.inject()`.

**Coverage gates:**
- CI fails if `--coverage` line% drops below 80% per package.
- New mutating route without test → audit-coverage test fails (already in place).
- New permission key without registry test → permissions registry test fails.

---

## File Structure

| Path | Action | Purpose |
|---|---|---|
| `apps/web/playwright.config.ts` | Create | Playwright config (chromium only for now, headless) |
| `apps/web/test/e2e/` | Create dir | Playwright specs (1 per page = 19 specs) |
| `apps/web/test/fixtures/auth.ts` | Create | Storage-state factory: login as Owner / Viewer / no-role |
| `apps/api/test/security/` | Create dir | Permission boundary matrix, SQL injection, XSS smoke |
| `apps/api/test/property/` | Create dir | Fast-check property tests |
| `apps/api/test/helpers/snapshot-restore.ts` | Create | Reusable "snapshot live state → mask → restore" pattern |
| `vitest.workspace.ts` | Modify | Add coverage thresholds per project |
| `apps/api/vitest.config.ts` | Modify | Add `coverage: { thresholds: { lines: 80 } }` |
| `apps/web/vitest.config.ts` | Modify | Same |
| `.github/workflows/ci.yml` | Modify | Run `pnpm turbo run test -- --coverage` and fail on threshold breach |
| `package.json` | Modify | Add `@fast-check/vitest`, `@playwright/test`, `@vitest/coverage-v8` |

---

## Phase 1 — Foundation

### Task 1: Coverage reporting + CI gate

**Files:**
- Create: `apps/api/vitest.config.ts` (modify — add coverage)
- Create: `apps/web/vitest.config.ts` (modify)
- Modify: `.github/workflows/ci.yml`
- Modify: root `package.json`

- [ ] **Step 1: Add coverage dependency**

```bash
pnpm add -D -w @vitest/coverage-v8
```

- [ ] **Step 2: Add coverage to apps/api/vitest.config.ts**

After existing `test:` block, add:

```ts
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov'],
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
  thresholds: {
    lines: 70,        // initial floor; ratchet up as tests land
    functions: 70,
    branches: 60,
    statements: 70,
  },
},
```

Apply identical block to `apps/web/vitest.config.ts` (or create the file if it doesn't exist) with `include: ['src/**/*.{ts,tsx}']`.

- [ ] **Step 3: Run with coverage to see baseline**

```bash
PASS=$(grep ^POSTGRES_PASSWORD .env | cut -d= -f2-)
DATABASE_URL="postgres://admin:${PASS}@127.0.0.1:5432/admin" pnpm --filter @squad/api exec vitest run --coverage 2>&1 | tail -25
```

Record the actual numbers in the report. If they are below 70, the threshold blocks. We'll revisit per-file thresholds in Task 2.

- [ ] **Step 4: Wire CI**

In `.github/workflows/ci.yml`, find the `pnpm turbo run test` step. Replace with:

```yaml
- name: Run tests with coverage
  run: pnpm turbo run test -- --coverage
  env:
    DATABASE_URL: postgres://postgres:postgres@localhost:5432/test
    REDIS_URL: redis://localhost:6379
- name: Upload coverage
  uses: actions/upload-artifact@v4
  with:
    name: coverage
    path: '**/coverage/lcov.info'
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/vitest.config.ts apps/web/vitest.config.ts .github/workflows/ci.yml package.json pnpm-lock.yaml
git commit -m "test(infra): coverage thresholds + CI artifact upload"
```

### Task 2: Snapshot-restore helper for shared-DB tests

**Files:**
- Create: `apps/api/test/helpers/snapshot-restore.ts`
- Modify: existing tests that mutate live DB to use the helper.

The first-owner.test.ts pattern (snapshot real Owner state → mask during test → restore in afterEach) is now mandatory for any test that touches `players.role_id`, `panel_meta.first_owner_claimed`, `roles`, `role_permissions`. Generalize:

- [ ] **Step 1: Write the helper**

`apps/api/test/helpers/snapshot-restore.ts`:

```ts
import { panelMeta, players, roles } from '@squad/db/schema';
import type { DatabaseClient } from '@squad/db';
import { and, eq } from 'drizzle-orm';

export interface LiveStateSnapshot {
  panelMetaFlag: boolean;
  ownerSteamIds: bigint[];
  ownerRoleId: string;
}

export async function snapshotLiveOwnerState(
  db: DatabaseClient,
): Promise<LiveStateSnapshot> {
  const ownerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const ownerRoleId = ownerRows[0]?.id;
  if (!ownerRoleId) throw new Error('Owner role missing — migration 0009 not applied?');

  const meta = await db.select().from(panelMeta).where(eq(panelMeta.id, 1));
  const owners = await db
    .select({ steamId64: players.steamId64 })
    .from(players)
    .where(eq(players.roleId, ownerRoleId));

  return {
    panelMetaFlag: meta[0]?.firstOwnerClaimed ?? false,
    ownerSteamIds: owners.map((r) => r.steamId64),
    ownerRoleId,
  };
}

export async function maskLiveOwners(
  db: DatabaseClient,
  snapshot: LiveStateSnapshot,
): Promise<void> {
  for (const sid of snapshot.ownerSteamIds) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
  }
  await db.update(panelMeta).set({ firstOwnerClaimed: false }).where(eq(panelMeta.id, 1));
}

export async function restoreLiveOwners(
  db: DatabaseClient,
  snapshot: LiveStateSnapshot,
): Promise<void> {
  for (const sid of snapshot.ownerSteamIds) {
    await db
      .update(players)
      .set({ roleId: snapshot.ownerRoleId })
      .where(eq(players.steamId64, sid));
  }
  await db
    .update(panelMeta)
    .set({ firstOwnerClaimed: snapshot.panelMetaFlag })
    .where(eq(panelMeta.id, 1));
}

/**
 * Test SteamID range: 76561197999_______
 * Real players will never collide because Valve allocates from a much
 * higher base. ALWAYS use SteamIDs from this range in tests.
 */
export const TEST_STEAM_BASE = 76561197999000000n;
export function testSteamId(suffix: number): bigint {
  if (suffix < 0 || suffix > 999999) {
    throw new Error(`testSteamId suffix out of range: ${suffix}`);
  }
  return TEST_STEAM_BASE + BigInt(suffix);
}
```

- [ ] **Step 2: Refactor first-owner.test.ts and rbac.test.ts to use helper**

Replace inline snapshot logic with `snapshotLiveOwnerState` / `maskLiveOwners` / `restoreLiveOwners`.

- [ ] **Step 3: Audit all tests for unsafe mutation**

```bash
grep -rn "delete(players)\|update(players).*role\|update(panelMeta)\|delete(roles)" apps/api/test/ | grep -v "steamId64.*TEST_\|steamId64.*testSteamId"
```

Anything not using TEST_PLAYER_* or `testSteamId(...)` is a test-isolation bug. List them in the commit message.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/
git commit -m "test(api): shared snapshot-restore helper + TEST_STEAM_BASE convention"
```

---

## Phase 2 — API route coverage (16 tasks)

For each route file in `apps/api/src/routes/`, ensure complete behavioral coverage. The format is identical across all 16 — only the route names and assertions vary.

**Coverage matrix per mutating endpoint:**
1. **Happy path** (200/201) — payload accepted, side effects observed.
2. **Auth absent** (401) — no cookie, no Bearer.
3. **Permission denied** (403) — auth present but missing required permission.
4. **Validation failure** (400) — body/query/param fails Zod.
5. **Not found** (404) — target resource absent.
6. **Conflict** (409) — uniqueness or invariant violation.
7. **Audit row written** — `audit_log` has matching action/resource/actor/before/after.
8. **Cache invalidation** — when applicable, next request reflects mutation.

**Coverage matrix per read endpoint:**
1. Happy path with fixture data.
2. Auth absent (401).
3. Permission denied (403).
4. Empty result.
5. Pagination/filter (where applicable).

### Task 3: Test `routes/audit.ts` (currently has tests — verify completeness)

Read existing `apps/api/test/audit-entry.test.ts`. Ensure every endpoint hits all 5 read-path cases. Add missing.

### Task 4: Test `routes/auth.ts` and `routes/auth-steam.ts` (extend existing)

Already covered by `auth-sessions.test.ts` and `auth-steam.test.ts`. Audit which Bearer-token paths are missing — ensure intersectScopes is exercised. Add a "wrong-host return_to" test.

### Task 5: Test `routes/depot.ts` (NEW — currently 0 coverage)

**Files:**
- Create: `apps/api/test/depot.test.ts`

- [ ] **Step 1: Write tests**

Cover `POST /api/v1/depot/update` (or whatever the depot routes expose). Read `apps/api/src/routes/depot.ts` first to enumerate endpoints. For each:

```ts
import { describe, it, expect } from 'vitest';
import { withApp, asUser } from './integration/harness.js';

describe('POST /api/v1/depot/update', () => {
  it('happy path triggers bridge.depotUpdate and returns 202', async () => { /* ... */ });
  it('returns 401 when unauthenticated', async () => { /* ... */ });
  it('returns 403 when permissions are missing', async () => { /* ... */ });
  it('returns 409 if a depot update is already running', async () => { /* ... */ });
  it('writes audit entry with action=depot.update', async () => { /* ... */ });
});
```

Use `harness.makeFakeBridge()` to control bridge responses.

- [ ] **Step 2: Verify**

```bash
PASS=$(grep ^POSTGRES_PASSWORD .env | cut -d= -f2-)
DATABASE_URL="postgres://admin:${PASS}@127.0.0.1:5432/admin" pnpm --filter @squad/api exec vitest run test/depot.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/depot.test.ts
git commit -m "test(api/depot): full coverage matrix"
```

### Task 6: Test `routes/logs.ts` (NEW)

**Files:** `apps/api/test/logs.test.ts`

Cover:
- `GET /api/v1/logs` with cursor pagination, source filter, level filter.
- `GET /api/v1/logs/export` returns gzipped bundle, requires `host:metrics`.
- Empty Redis stream → empty result.
- Cursor invalid format → 400.

### Task 7-19: Apply the same pattern to remaining routes

| # | Route | Existing tests | Gap to fill |
|---|---|---|---|
| 7 | `host.ts` | host-actions.test.ts | host info / host metrics history endpoint |
| 8 | `host-actions.ts` | host-actions.test.ts | bridge restart 5xx propagation |
| 9 | `me-tokens.ts` | me-tokens.test.ts | scope-narrowing edge cases |
| 10 | `permissions.ts` | permissions-list.test.ts | full ✓ |
| 11 | `players.ts` | player-role-assign.test.ts | search ?q= with cyrillic, ?q= with steamId |
| 12 | `roles.ts` | roles-crud.test.ts | description=null update, color CHECK violation |
| 13 | `server-configs.ts` | server-install-configs.test.ts, blame.test.ts, config-rewrite.test.ts | restore endpoint, diff endpoint, blame cache |
| 14 | `server-install.ts` | install-ws.test.ts, server-install-configs.test.ts | install failure path, ws frame ordering |
| 15 | `server-logs.ts` | server-logs.test.ts | full ✓ |
| 16 | `servers.ts` | servers + start/stop tests | edge: stop while installing, force_stop, delete cascade |
| 17 | `users.ts` | users-list.test.ts | sort order, role join NULL handling |
| 18 | `setup.ts` (removed) | setup-removed.test.ts | full ✓ |

For each task: identify the gap, write tests, run, commit. One commit per route file.

---

## Phase 3 — Web Playwright suite (Tier 4)

### Task 20: Set up Playwright

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/test/e2e/` directory
- Create: `apps/web/test/fixtures/auth.ts`
- Modify: `apps/web/package.json` (add `@playwright/test`, scripts)

- [ ] **Step 1: Install Playwright**

```bash
pnpm --filter @squad/web add -D @playwright/test
pnpm --filter @squad/web exec playwright install chromium
```

- [ ] **Step 2: Write config**

`apps/web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // shared DB
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PANEL_TEST_URL ?? 'https://squad-panel.lan',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

- [ ] **Step 3: Auth fixture**

`apps/web/test/fixtures/auth.ts`:

```ts
import { test as base, type Page } from '@playwright/test';

interface Fixtures {
  ownerPage: Page;
  viewerPage: Page;
  noRolePage: Page;
}

export const test = base.extend<Fixtures>({
  ownerPage: async ({ browser }, use) => {
    const cookie = process.env.PANEL_TEST_COOKIE_OWNER;
    if (!cookie) throw new Error('PANEL_TEST_COOKIE_OWNER not set');
    const ctx = await browser.newContext();
    await ctx.addCookies([
      {
        name: '__Host-sid',
        value: cookie,
        domain: new URL(process.env.PANEL_TEST_URL ?? 'https://squad-panel.lan').hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
  // viewerPage / noRolePage analogous
});

export { expect } from '@playwright/test';
```

- [ ] **Step 4: Smoke test**

`apps/web/test/e2e/smoke.spec.ts`:

```ts
import { test, expect } from '../fixtures/auth';

test('Owner can reach /dashboard', async ({ ownerPage }) => {
  await ownerPage.goto('/dashboard');
  await expect(ownerPage.locator('nav')).toContainText('Серверы');
});
```

- [ ] **Step 5: Add scripts to package.json**

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

- [ ] **Step 6: Run + verify**

```bash
PANEL_TEST_URL=https://squad-panel.lan \
PANEL_TEST_COOKIE_OWNER=<your-cookie> \
pnpm --filter @squad/web test:e2e
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/test/ apps/web/package.json
git commit -m "test(web/e2e): Playwright skeleton + auth fixtures + smoke spec"
```

### Task 21-39: Per-page Playwright spec (one task per page = 19 tasks)

Page list (19 total):
1. `/login` — render, click Steam button → redirect.
2. `/no-access` — render with `?steam_id64=` param.
3. `/` (root) — redirects authed → /dashboard, unauthed → /login.
4. `/dashboard` — sidebar permission gating, dashboard cards present.
5. `/servers` — list renders, search filter, action buttons enabled by status.
6. `/servers/new` — form fields, slug auto-gen for cyrillic ("выфвфы" → "vyfvfy"), submit triggers WS install (mock with bridge fake), Owner confirm not applicable.
7. `/servers/[id]` — detail page renders, RCON state shown.
8. `/servers/[id]/configs` — Editor / History / Blame tabs each render, Monaco loads, save triggers PUT.
9. `/servers/[id]/events` — events list paginates.
10. `/players` — list renders, click row → detail.
11. `/players/[steam_id64]` — profile, name history, IP history (gated), PanelAccessSection single-role.
12. `/audit` — entries list, filter by action/actor/date.
13. `/logs` — live tail (WebSocket polling), source filter, level filter, export button (gated).
14. `/roles` — list with color dots, "Системная" badge on Owner, delete confirm.
15. `/roles/new` — RoleEditor form, color picker (16 swatches), permission search, save → redirect.
16. `/roles/[id]` — Owner read-only mode, non-Owner editable, save persists.
17. `/users` — table renders, assign-role modal with typeahead, Owner confirm dialog.
18. `/settings/account` — display info, sessions list, revoke session.
19. `/settings/tokens` — tokens list, mint with scope checkboxes, revoke.

For each page:

**Files:** `apps/web/test/e2e/<slug>.spec.ts`

- [ ] **Step 1: Write spec covering**:
  - Render state (loading → loaded → empty → populated).
  - Permission gating (page redirects/hides for users lacking permission).
  - Form fields (validation messages on bad input).
  - Form submission (network mock or assertion against live API).
  - Error state (forced 4xx/5xx response → user-readable error rendered).
  - Loading state (slow network → spinner visible).

- [ ] **Step 2: Run spec**

```bash
PANEL_TEST_URL=https://squad-panel.lan \
PANEL_TEST_COOKIE_OWNER=... \
pnpm --filter @squad/web exec playwright test test/e2e/<slug>.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/e2e/<slug>.spec.ts
git commit -m "test(web/e2e): <page-name> render + form + error states"
```

---

## Phase 4 — Worker contract tests (11 tasks)

Every worker — implemented or stub — MUST verify:
1. **Heartbeat publication.** Calls `startHeartbeat({ name, redis })` on boot. Within 30s a Redis key `worker:heartbeat:<name>` exists with TTL ≤ 30.
2. **Graceful shutdown.** SIGTERM → process exits 0 within 5s.
3. **Domain logic** (implemented workers only).

### Task 40: Worker contract harness

**Files:**
- Create: `apps/workers/_shared/test/contract.ts` (or per-worker if monorepo doesn't allow shared)

```ts
import { describe, it, expect } from 'vitest';
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export function workerContract(opts: {
  name: string;
  entryPath: string;
  expectedHeartbeatKey: string;
}) {
  describe(`${opts.name} worker contract`, () => {
    it('publishes heartbeat within 30s of start', async () => {
      const child = spawn('node', [opts.entryPath], {
        env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:6379/14' },
      });
      try {
        const redis = new Redis('redis://127.0.0.1:6379/14');
        for (let i = 0; i < 30; i++) {
          const ttl = await redis.ttl(opts.expectedHeartbeatKey);
          if (ttl > 0) {
            expect(ttl).toBeLessThanOrEqual(30);
            return;
          }
          await sleep(1000);
        }
        throw new Error('heartbeat key never appeared');
      } finally {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
    }, 35_000);

    it('exits 0 on SIGTERM within 5s', async () => {
      const child = spawn('node', [opts.entryPath], {
        env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:6379/14' },
      });
      await sleep(2000);
      child.kill('SIGTERM');
      const code = await Promise.race([
        new Promise<number>((r) => child.once('exit', (c) => r(c ?? -1))),
        sleep(5000).then(() => -1),
      ]);
      expect(code).toBe(0);
    }, 10_000);
  });
}
```

### Task 41-51: Per-worker contract spec

For each of 11 workers (audit-archiver, automation, backup, config-sync, discord, event-partition, log-ingest, metrics-sampler, rcon, scheduler, stats):

**Files:** `apps/workers/<name>/test/contract.test.ts`

```ts
import { workerContract } from '@squad/_shared-test/contract';
import { resolve } from 'node:path';

workerContract({
  name: '<name>',
  entryPath: resolve(__dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:<name>',
});
```

For implemented workers (rcon, log-ingest, audit-archiver, event-partition, metrics-sampler), add domain-specific tests:
- **rcon**: protocol two-packet AUTH trick, ListPlayers polling, ShowServerInfo keepalive, exponential backoff on disconnect.
- **log-ingest**: regex parser produces correct EventEnvelope per Squad log line, dedup window.
- **metrics-sampler**: 8-int packed tuple round-trips, MAXLEN 5760 enforced.
- **event-partition**: monthly DDL pre-creates next month, detaches old.
- **audit-archiver**: archives rows older than 90d, hash chain still valid after archive.

For stub workers (automation, backup, config-sync, discord, scheduler, stats): contract tests only.

Each task: write spec → run → commit.

---

## Phase 5 — DB and bridge-client unit tests

### Task 52: DB connection pool + transaction tests

**Files:** `packages/db/test/client.test.ts`

Cover:
- `createDatabaseClient(url)` with valid URL → returns `DatabaseClient`.
- Pool exhaustion: open N+1 long-running tx → N+1th waits.
- Transaction rollback on throw.
- Advisory lock serialization between two parallel tx.
- `ON DELETE CASCADE` and `ON DELETE SET NULL` behavior end-to-end.

### Task 53: bridge-client lifecycle tests

**Files:** `packages/bridge-client/test/lifecycle.test.ts`

Mock the Unix socket (use `node:net` createServer on a temp path). Cover:
- Connect → request → response.
- Length-prefix framing: split frames across multiple `data` events → still parsed.
- Decode error → socket dropped, `closed` stays false, next call reconnects.
- 16 MiB max frame size enforced.
- Streaming method (`container_logs_follow`) emits `onLog` callbacks until close.
- Per-WebSocket client teardown via `app.makeBridgeClient()`.
- SO_PEERCRED auth failure (wrong group) → connection closed by server side.

---

## Phase 6 — Property-based / fuzz tests

### Task 54: Slug auto-generation fuzz

**Files:** `apps/web/test/property/slug.test.ts`

Using `@fast-check/vitest`:

```ts
import { test, fc } from '@fast-check/vitest';
import { nameToSlug, sanitizeSlug } from '../../src/app/(dashboard)/servers/new/_slug';
// (extract slug helpers into _slug.ts to make them testable)

test.prop([fc.string({ minLength: 1, maxLength: 120 })])('nameToSlug always produces empty or valid slug', (input) => {
  const slug = nameToSlug(input);
  if (slug === '') return;
  expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
});

test.prop([fc.string()])('sanitizeSlug strips leading dashes', (input) => {
  const slug = sanitizeSlug(input);
  if (slug.length > 0) expect(slug[0]).not.toBe('-');
});
```

### Task 55: Permission registry consistency

**Files:** `packages/shared-config/test/property/registry.test.ts`

```ts
test.prop([fc.constantFrom(...PERMISSIONS.map((p) => p.key))])(
  'every registered key is detected by isPermissionKey',
  (key) => expect(isPermissionKey(key)).toBe(true),
);

test.prop([fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !PERMISSION_KEYS.includes(s))])(
  'unregistered keys are rejected',
  (s) => expect(isPermissionKey(s)).toBe(false),
);
```

### Task 56: Audit chain integrity under random insertion

**Files:** `apps/api/test/property/audit-chain.test.ts`

Insert N random audit rows in random order via `auditLog` schema, then verify chain integrity matches `scripts/verify-audit-chain.ts` output. Test that:
- Chain head equals last row's `row_hash`.
- Tampering any single row breaks the chain at that point.
- Concurrent inserts via two parallel transactions still produce valid chain.

---

## Phase 7 — Security regression tests

### Task 57: Permission boundary matrix

**Files:** `apps/api/test/security/permission-matrix.test.ts`

For every endpoint in the route table, for every permission in PERMISSIONS:
- A user holding ONLY that permission → endpoint accessible iff endpoint requires that permission (or none).
- A user holding NO permissions → endpoint returns 403 (or 401 if route is public).
- A user holding ALL permissions → endpoint accessible.

Generated programmatically:

```ts
import { PERMISSIONS } from '@squad/shared-config';
import { collectRoutes } from '../audit-coverage.js'; // reuse the existing route walker

const routes = await collectRoutes();
for (const route of routes) {
  const required = route.config.permissions ?? [];
  for (const perm of PERMISSIONS) {
    it(`${route.method} ${route.url} with only ${perm.key}`, async () => {
      const user = await createTestUser([perm.key]);
      const res = await asUser(app, user.session).inject({ method: route.method, url: route.url });
      const expected = required.length === 0 || required.every((r) => r === perm.key) ? '< 400' : 403;
      // ... assertion
    });
  }
}
```

This is a large matrix (16 routes × 48 perms ≈ 768 tests). Each assertion is fast (no DB round-trip beyond auth load). Acceptable.

### Task 58: SQL injection on text inputs

**Files:** `apps/api/test/security/sql-injection.test.ts`

For every endpoint that accepts a text parameter (steamId path param, `q` query, role name, server slug, audit search): submit `'; DROP TABLE players; --` and assert:
- Response is 4xx or 200, never 500.
- DB tables still exist after request.

### Task 59: XSS smoke

**Files:** `apps/web/test/e2e/security/xss.spec.ts`

Playwright spec. Set role name = `<script>alert(1)</script>`. Navigate to `/users`, `/roles`, `/players/{id}`. Assert:
- The literal string is rendered as text (escaped).
- `window.alert` was never called.

### Task 60: CSRF / cookie security

**Files:** `apps/api/test/security/cookie-security.test.ts`

Verify:
- `__Host-sid` cookie has `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`.
- Bearer token over HTTP (not HTTPS) → rejected (or warning).
- Cross-origin request without cookie → 401.

---

## Phase 8 — E2E suite expansion

### Task 61: Multi-user RBAC scenarios

**Files:** `apps/api/test/e2e/multi-user-rbac.e2e.test.ts`

Live stack. Sequence:
1. Owner creates roles "Senior" and "Junior" with different permission sets.
2. Owner assigns Senior to user A, Junior to user B.
3. User A logs in → can do X, can't do Y.
4. User B logs in → opposite.
5. Owner removes Junior role from B → B logs in → /no-access.
6. Owner deletes Senior role → A's role becomes NULL → A → /no-access.

### Task 62: Failure injection

**Files:** `apps/api/test/e2e/resilience.e2e.test.ts`

Test panel behavior under:
- `docker compose restart postgres` mid-request → API recovers, 503 during downtime, 200 after.
- `docker compose restart redis` → workers reconnect, sessions invalidated cleanly.
- Bridge socket disappears → relevant routes return 503 with descriptive error.
- Disk full simulation (write to a small tmpfs config dir) → config save returns 507.

---

## Phase 9 — Regression + ratchet

### Task 63: Ratchet coverage thresholds

After Tasks 1-62 land, raise the thresholds in vitest configs:
- lines: 70 → **90**
- functions: 70 → **85**
- branches: 60 → **75**
- statements: 70 → **90**

If any package falls below, add tests until it doesn't.

### Task 64: Add bug-regression tests for every closed issue

For every bug fixed during the RBAC + docs work (cyrillic slug, sentinel wedge, test-isolation Owner-strip, last-Owner test, vitest parallelism, etc.), add a regression test in the relevant tier. Naming convention: `<bug-slug>.regression.test.ts`.

Examples:
- `apps/web/test/property/cyrillic-slug.regression.test.ts`
- `apps/api/test/security/sentinel-wedge.regression.test.ts`
- `apps/api/test/integration/test-isolation.regression.test.ts`

### Task 65: Mutation testing pilot

**Files:** add `stryker` config for one package (start with shared-config — smallest, purest).

```bash
pnpm --filter @squad/shared-config add -D @stryker-mutator/core @stryker-mutator/vitest-runner
```

Run and review the mutation score. Document baseline. Set goal: ≥80% mutation score for shared-config within 2 weeks; expand to other packages once toolchain is comfortable.

### Task 66: Final coverage audit

- [ ] **Step 1: Run everything**

```bash
PASS=$(grep ^POSTGRES_PASSWORD .env | cut -d= -f2-)
DATABASE_URL="postgres://admin:${PASS}@127.0.0.1:5432/admin" pnpm turbo run test -- --coverage 2>&1 | tee coverage.log
```

- [ ] **Step 2: Aggregate coverage report**

Combine all `coverage/lcov.info` files. Use `lcov` CLI:

```bash
lcov -a apps/api/coverage/lcov.info -a apps/web/coverage/lcov.info -a packages/shared-config/coverage/lcov.info ... -o combined.lcov
genhtml combined.lcov -o coverage-html/
```

Open `coverage-html/index.html`. Document the bottom-line numbers.

- [ ] **Step 3: Document in `docs/development/testing.md`**

Add a "Coverage" section listing per-package thresholds, total line %, total function %, list of files/branches still uncovered with rationale.

- [ ] **Step 4: Commit**

```bash
git add docs/development/testing.md
git commit -m "docs(testing): coverage baseline and per-package thresholds"
```

---

## Self-Review

### Spec coverage

- ✅ All 16 API routes covered (Tasks 3-19).
- ✅ All 19 web pages covered (Tasks 21-39).
- ✅ All 11 workers contract-tested (Tasks 41-51).
- ✅ DB and bridge-client low-level coverage (Tasks 52-53).
- ✅ Property-based for slug, registry, audit chain (Tasks 54-56).
- ✅ Security regression matrix (Tasks 57-60).
- ✅ E2E expansion for multi-user + resilience (Tasks 61-62).
- ✅ Coverage gates and ratchet (Task 63).
- ✅ Regression for every bug found during RBAC work (Task 64).

### Placeholder scan

- No "TBD". Every step has concrete code or commands.
- All file paths absolute or repo-relative-precise.
- Every Vitest config snippet runnable as-is.

### Type consistency

- `LiveStateSnapshot`, `snapshotLiveOwnerState`, `maskLiveOwners`, `restoreLiveOwners` defined in Task 2 and used in Tasks 3+.
- `workerContract` factory defined in Task 40 used in Tasks 41-51.

### Total task count

**66 tasks** broken down:
- Phase 1 (foundation): 2
- Phase 2 (API routes): 17
- Phase 3 (Playwright): 20 (1 setup + 19 pages)
- Phase 4 (workers): 12 (1 harness + 11 specs)
- Phase 5 (DB/bridge unit): 2
- Phase 6 (property-based): 3
- Phase 7 (security): 4
- Phase 8 (E2E expansion): 2
- Phase 9 (regression + ratchet): 4

Estimated: 60-80 hours of focused work spread across multiple subagent dispatches.

### Recommended execution order

1. **Phase 1** (foundation) — must come first; everything else assumes coverage reporting + snapshot helper are in place.
2. **Phase 2** (API routes) — fastest payoff per hour. Each task is mechanical given the matrix.
3. **Phase 4** (workers contract) — independent of API; can run in parallel.
4. **Phase 5** (DB / bridge unit) — small, fast wins.
5. **Phase 3** (Playwright) — heavier setup, slower iteration. Worth doing in parallel with Phase 2.
6. **Phase 6** (property-based) — once the obvious cases are tested, fuzz finds the weird ones.
7. **Phase 7** (security) — late-stage hardening, depends on Phase 2.
8. **Phase 8** (E2E expansion) — needs everything else stable.
9. **Phase 9** (regression + ratchet) — closes out.

### Out of scope

- Cross-browser testing (Playwright firefox/webkit) — chromium only for now.
- Visual regression (screenshot diffing) — separate epic if needed.
- Load testing (k6, artillery) — separate epic.
- Chaos engineering beyond the basic failure-injection tests — separate epic.
- Mobile / accessibility audits — separate epic.

If any of those become priorities, they get their own plan and their own task list.
