# RNSquadJS Integration Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the April `feat/rnsquadjs-migration` work (phases 0–2) onto current master, fix its latent bugs, then execute the remaining rollout phases: shadow soak → canary cutover → fleet cutover → cleanup.

**Architecture:** RNSquadJS runs as a per-server sidecar container (pinned upstream SHA `d76fb4a`, our `panelBridge` plugin baked in). The sidecar tails the Squad log, maps events to `EventEnvelope`, and publishes to `events:server:{id}` (or `:shadow` while soaking). Cutover is per-server via Redis set `rnsquadjs:cutover-servers`: members are served by the sidecar and skipped by `worker-log-ingest`. `worker-rcon` is **not** replaced (see Deviation D4).

**Tech Stack:** TypeScript (Fastify 5 + Zod, Drizzle, ioredis, Vitest), Go 1.22 bridge, Node 18.18 sidecar image, Docker.

---

## Why not `git merge`

`feat/rnsquadjs-migration` diverged from master on 2026-04-24 (merge-base `e6a4025`). Since then master changed **961 files** (vs 50 on the branch), 27 of them on both sides, including a full player-UUID migration and a reimplementation of the branch's own `PANEL_DEPOT_HOST_PATH` fixes. A textual merge would resolve stale hunks against rewritten files. Instead: keep the branch as archive, restore its **net-new files** verbatim, and **re-apply its small modifications by hand** against current master anchors (all anchors verified on master @ `6a7b3b3`).

## Spec deviations (record in spec §11 — Task 16)

The April spec/plan is `docs/superpowers/specs/2026-04-24-rnsquadjs-migration-design.md`. This plan deviates:

- **D1 — config.json is a bind-mounted file, not HTTP.** The branch's `GET /internal/rnsquadjs/config/:id` is loopback-guarded (`req.socket.remoteAddress ∈ 127.0.0.1/::1`), but the sidecar runs `--network host` and the API container publishes no host port — via docker-proxy the API would see the docker gateway IP, never loopback. Also the entrypoint `curl -o /app/config.json` writes to a `--read-only` rootfs. Fix: API renders config to `/run/squad-panel/rnsquadjs/{id}/config.json` (dir is bind-mounted into the API container); the bridge bind-mounts it read-only at `/app/config.json`. The HTTP route is **not** ported.
- **D2 — per-server socket subdirectory.** The branch mounted the whole `/run/squad-panel/rnsquadjs` root into every sidecar and bound `rcon.sock` inside it — two sidecars would fight over one socket file. Fix: each sidecar gets `{root}/{serverId}/` mounted at `/run/panelBridge`; host socket path is `{root}/{serverId}/rcon.sock`.
- **D3 — inverted kill switch.** Spec proposed `SREM rcon:enabled-servers {id}` (default-on sets nobody populates). Fix: Redis set `rnsquadjs:cutover-servers`, empty by default; `worker-log-ingest` skips members. No bootstrap, backwards compatible.
- **D4 — cutover transfers the log pipeline only.** Since April, master's `worker-rcon` grew A2S polling, `tickrate_rt`, lag-spike detection, `rcon:status:changed` live-bus publishes, and a richer `rcon:status:{id}` payload. Replacing it is now a separate project. `worker-rcon` stays authoritative for `rcon:status`/`a2s:status`/rcon events; the sidecar in production mode writes its own `rnsquadjs:status:{id}` key (never `rcon:status:{id}`) and the stop flow keeps `rconSendOnce`. The sidecar RCON unix socket stays (cutover verification + future use).
- **D6 — panelBridge compiles into the upstream, not a runtime drop-in (discovered during execution, 2026-06-12).** Image inspection at the pinned SHA showed the April packaging cannot work: upstream loads plugins via a STATIC registry (`src/plugins/index.ts` imports + array), `lib/` is produced only by `yarn build` (rollup) which the April Dockerfile never ran (`node lib/index.js` was guaranteed MODULE_NOT_FOUND), and `config.plugins` is an ARRAY of `{name, enabled, options}` (the April renderer emitted an object map). Fix: plugin TS sources are copied into upstream `src/plugins/panelBridge/`, registered via `docker/rnsquadjs/upstream.patch` (git apply — breaks loudly on SHA bump), `yarn add ioredis uuid && yarn build` in the upstream stage, runtime runs the real `lib/index.js`. The config renderer emits the plugins array (absent plugin = disabled, so no disabled-plugins enumeration needed). Upstream's unconditional `connectToDatabase(config.db)` throws on missing `db` but is caught by the per-server try/catch AFTER event wiring — mongo-less configs work (verified at the pinned SHA). Additionally the plugin's envelope is aligned to the shared snake_case `EventEnvelope` (`packages/shared-types/src/events.ts`, strict zod) and the cutover-type payload keys mirror the legacy parser's, otherwise production consumers break and shadow parity reads 0%.
- **D5 — fail-safe defaults.** `PANEL_BRIDGE_MODE` defaults to `shadow` (branch defaulted to `production`). The sidecar's `REDIS_URL` must be host-reachable (`redis://127.0.0.1:6379` — compose publishes Redis on host loopback); the branch default `redis://redis:6379` does not resolve on the host network.

## Per-task quality protocol (user's global rules — mandatory)

Before each task: run Sentrux baseline (`mcp__plugin_sentrux_sentrux__session_start` or `scan`). After each task: Sentrux `rescan` + `check_rules` + `test_gaps`, then Codex review via `/codex:rescue` with the task summary, diff, test results, and Sentrux before/after. Blocker findings must be fixed before the next task. Record everything in the completion ledger. Sentrux or Codex unavailable ⇒ status `blocked`, stop.

## Hard gates (STOP points)

- **Gate G1** (after Task 15): all local suites green + image builds.
- **Gate G2** (after Task 18): 24 h shadow soak, event parity ≥ 99 %, zero missing event types. Do not proceed on failure — fix `eventMap` and re-soak.
- **Gate G3** (after Task 19): 24 h canary production soak, no UI regressions.
- **Gate G4** (after Task 20): full fleet green 24 h; Phase-5 cleanup only after ≥ 1 week soak.

---

## Files

### Restored verbatim from `feat/rnsquadjs-migration` (Task 2)
- `docker/rnsquadjs.Dockerfile`, `docker/rnsquadjs/entrypoint.sh` (rewritten in Task 5)
- `docker/rnsquadjs/plugins/panelBridge/**` (package, src, tests, fixtures)
- `apps/api/src/lib/rcon.ts`, `apps/api/test/lib/rcon.test.ts` (adapted in Task 9)
- `apps/workers/log-ingest/scripts/render-baseline.ts`
- `ai_docs/rnsquadjs-migration-pin-2026-04-24.md`

### Not ported (superseded)
- `apps/api/src/routes/internal/rnsquadjs-config.ts` + its test (D1)
- `packages/db/drizzle/0008_servers_is_canary.sql` (master already has `0011_servers_is_canary.sql`)
- Branch versions of the 27 dual-changed files (master's versions win; the rnsquadjs deltas are re-applied by Tasks 6–12)

### Created
- `packages/shared-config/src/rnsquadjs.ts` + `packages/shared-config/test/rnsquadjs.test.ts` — cutover-set helpers
- `apps/api/src/lib/rnsquadjs.ts` + `apps/api/test/lib/rnsquadjs.test.ts` — config renderer, env builder, sidecar paths
- `apps/api/src/routes/server-rnsquadjs.ts` + `apps/api/test/server-rnsquadjs.test.ts` — cutover endpoint
- `docker/rnsquadjs/plugins/panelBridge/src/shadowDiff.ts` + `test/shadowDiff.test.ts` — parity comparator
- `scripts/rnsquadjs-shadow-diff.mjs` — soak runner

### Modified
- `apps/bridge/internal/validate/docker.go`, `paths.go` + tests — image/name/socket allowlists
- `apps/bridge/internal/runner/docker.go` + test — `RunRNSquadJS`
- `apps/bridge/internal/handlers/handlers.go` + test — `container_run_rnsquadjs` dispatch
- `apps/bridge/deploy/panel-host-bridge.tmpfiles.conf`, `panel-host-bridge.service` — socket root
- `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/types.ts`, `client.ts`
- `docker/rnsquadjs/plugins/panelBridge/src/{index,redisPublisher,heartbeat}.ts` + tests — D4/D5 fixes
- `apps/api/src/routes/server-install.ts`, `servers.ts`, `apps/api/src/lib/server-delete.ts`, `apps/api/src/server.ts`, `apps/api/src/plugins/types.ts`, `apps/api/src/config.ts`
- `apps/workers/log-ingest/src/index.ts` — kill-switch filter
- `docker-compose.yml` — API socket-root mount
- `docs/superpowers/specs/2026-04-24-rnsquadjs-migration-design.md` §11, `docs/architecture/decisions.md`

---

### Task 1: Archive the branch, create the integration branch

- [ ] **Step 1: Push the April branch to origin (it exists nowhere else)**

```bash
git push -u origin feat/rnsquadjs-migration
```

Expected: `* [new branch] feat/rnsquadjs-migration -> feat/rnsquadjs-migration`. Note: the pre-push hook runs typecheck+tests against the *checked-out* tree (master), not the pushed ref, so it passes.

- [ ] **Step 2: Create the integration branch off current master**

```bash
git checkout -b feat/rnsquadjs-integration master
git log --oneline -1   # expect 6a7b3b3 or later
```

### Task 2: Restore net-new files from the branch

- [ ] **Step 1: Restore**

```bash
git checkout feat/rnsquadjs-migration -- \
  docker/rnsquadjs.Dockerfile \
  docker/rnsquadjs/ \
  apps/api/src/lib/rcon.ts \
  apps/api/test/lib/rcon.test.ts \
  apps/workers/log-ingest/scripts/render-baseline.ts \
  ai_docs/rnsquadjs-migration-pin-2026-04-24.md
```

- [ ] **Step 2: Verify the plugin suite still passes standalone (uses its own package.json)**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npm ci && npx vitest run; cd -
```

Expected: `23 passed` across eventMap/redisPublisher/rconUnixServer tests.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(rnsquadjs): restore sidecar image, panelBridge plugin, and rcon client from feat/rnsquadjs-migration"
```

### Task 3: panelBridge fixes — fail-safe mode, own status key, structured heartbeat (D4/D5)

**Files:** Modify `docker/rnsquadjs/plugins/panelBridge/src/index.ts`, `src/redisPublisher.ts`, `src/heartbeat.ts`; Test `test/redisPublisher.test.ts`, `test/heartbeat.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Append to `docker/rnsquadjs/plugins/panelBridge/test/redisPublisher.test.ts`:

```typescript
it('production status goes to rnsquadjs:status, never rcon:status', async () => {
  const redis = fakeRedis();
  const pub = new RedisPublisher(redis as never, SERVER_ID, 'production');
  await pub.publishRconStatus({ state: 'connected', lastChange: NOW });
  expect(redis.set).toHaveBeenCalledWith(
    `rnsquadjs:status:${SERVER_ID}`,
    expect.any(String),
    'EX',
    300,
  );
});

it('shadow status key keeps the :shadow suffix', async () => {
  const redis = fakeRedis();
  const pub = new RedisPublisher(redis as never, SERVER_ID, 'shadow');
  await pub.publishRconStatus({ state: 'connected', lastChange: NOW });
  expect(redis.set).toHaveBeenCalledWith(
    `rnsquadjs:status:${SERVER_ID}:shadow`,
    expect.any(String),
    'EX',
    300,
  );
});
```

(Reuse the file's existing `fakeRedis`/`SERVER_ID` fixtures; add a `NOW` const if absent.)

Create `docker/rnsquadjs/plugins/panelBridge/test/heartbeat.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat } from '../src/heartbeat.js';

describe('Heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the shared worker-heartbeat JSON payload with 30s TTL', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const hb = new Heartbeat({ set } as never, 'srv-1');
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    hb.stop();
    const [key, raw, ex, ttl] = set.mock.calls[0];
    expect(key).toBe('worker:heartbeat:rnsquadjs:srv-1');
    expect(ex).toBe('EX');
    expect(ttl).toBe(30);
    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({ name: 'rnsquadjs:srv-1', status: 'ok' });
    expect(typeof payload.ts).toBe('string');
    expect(typeof payload.pid).toBe('number');
    expect(typeof payload.started_at).toBe('string');
  });
});
```

- [ ] **Step 2: Run, verify both fail**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/redisPublisher.test.ts test/heartbeat.test.ts
```

Expected: FAIL — status key is `rcon:status:...`; heartbeat payload is a bare ISO string (`JSON.parse` throws).

- [ ] **Step 3: Implement**

In `src/redisPublisher.ts` replace `statusKey()`:

```typescript
  private statusKey(): string {
    // D4: worker-rcon owns rcon:status:{id}; the sidecar must never clobber it.
    return `rnsquadjs:status:${this.serverId}${this.suffix()}`;
  }
```

In `src/heartbeat.ts` replace `tick()` (add `import { hostname } from 'node:os';` at top):

```typescript
  private readonly startedAt = new Date().toISOString();

  private async tick(): Promise<void> {
    const payload = {
      name: `rnsquadjs:${this.serverId}`,
      ts: new Date().toISOString(),
      pid: process.pid,
      hostname: hostname(),
      version: process.env.UPSTREAM_SHA ?? 'unknown',
      started_at: this.startedAt,
      status: 'ok',
    };
    await this.redis.set(
      `worker:heartbeat:rnsquadjs:${this.serverId}`,
      JSON.stringify(payload),
      'EX',
      30,
    );
  }
```

In `src/index.ts` flip the mode default (D5):

```typescript
  const mode: Mode = process.env.PANEL_BRIDGE_MODE === 'production' ? 'production' : 'shadow';
```

- [ ] **Step 4: Run the whole plugin suite**

```bash
npx vitest run
```

Expected: all pass (25+). Fix any test that asserted the old `rcon:status` key.

- [ ] **Step 5: Commit**

```bash
cd /home/squad/squad-admin-panel
git add docker/rnsquadjs/plugins/panelBridge && git commit -m "fix(panelBridge): shadow-by-default mode, rnsquadjs:status key, structured heartbeat payload"
```

### Task 4: shadowDiff — event parity comparator (tooling for Gate G2)

**Files:** Create `docker/rnsquadjs/plugins/panelBridge/src/shadowDiff.ts`, `test/shadowDiff.test.ts`, `scripts/rnsquadjs-shadow-diff.mjs`

- [ ] **Step 1: Write failing test** — `test/shadowDiff.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { compareStreams, type StreamEvent } from '../src/shadowDiff.js';

const ev = (type: string, ts: string, payload: unknown = {}): StreamEvent => ({
  type,
  ts,
  payload,
});

describe('compareStreams', () => {
  it('matches identical event sets at 100%', () => {
    const a = [ev('player.connected', '2026-06-12T10:00:00Z', { steam_id: '7656' })];
    const r = compareStreams(a, [...a]);
    expect(r.parityPct).toBe(100);
    expect(r.missingInShadow).toHaveLength(0);
    expect(r.extraInShadow).toHaveLength(0);
  });

  it('tolerates ts skew within 5s for the same type+payload', () => {
    const prod = [ev('match.started', '2026-06-12T10:00:00Z', { layer: 'Yeho' })];
    const shadow = [ev('match.started', '2026-06-12T10:00:03Z', { layer: 'Yeho' })];
    expect(compareStreams(prod, shadow).parityPct).toBe(100);
  });

  it('reports missing types and computes parity', () => {
    const prod = [
      ev('player.connected', '2026-06-12T10:00:00Z', { steam_id: '1' }),
      ev('player.disconnected', '2026-06-12T10:01:00Z', { steam_id: '1' }),
    ];
    const shadow = [ev('player.connected', '2026-06-12T10:00:01Z', { steam_id: '1' })];
    const r = compareStreams(prod, shadow);
    expect(r.parityPct).toBe(50);
    expect(r.missingTypes).toContain('player.disconnected');
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (`npx vitest run test/shadowDiff.test.ts` → module not found)

- [ ] **Step 3: Implement** — `src/shadowDiff.ts`:

```typescript
export interface StreamEvent {
  type: string;
  ts: string;
  payload: unknown;
}

export interface DiffResult {
  parityPct: number;
  matched: number;
  missingInShadow: StreamEvent[];
  extraInShadow: StreamEvent[];
  missingTypes: string[];
}

const SKEW_MS = 5_000;

function key(e: StreamEvent): string {
  return `${e.type} ${JSON.stringify(e.payload)}`;
}

export function compareStreams(prod: StreamEvent[], shadow: StreamEvent[]): DiffResult {
  const pool = new Map<string, StreamEvent[]>();
  for (const e of shadow) {
    const k = key(e);
    const arr = pool.get(k) ?? [];
    arr.push(e);
    pool.set(k, arr);
  }
  const missingInShadow: StreamEvent[] = [];
  let matched = 0;
  for (const e of prod) {
    const candidates = pool.get(key(e)) ?? [];
    const i = candidates.findIndex(
      (c) => Math.abs(Date.parse(c.ts) - Date.parse(e.ts)) <= SKEW_MS,
    );
    if (i === -1) {
      missingInShadow.push(e);
    } else {
      candidates.splice(i, 1);
      matched += 1;
    }
  }
  const extraInShadow = [...pool.values()].flat();
  const parityPct = prod.length === 0 ? 100 : Math.round((matched / prod.length) * 10000) / 100;
  const missingTypes = [...new Set(missingInShadow.map((e) => e.type))];
  return { parityPct, matched, missingInShadow, extraInShadow, missingTypes };
}
```

- [ ] **Step 4: Run, verify PASS**, then add the soak runner `scripts/rnsquadjs-shadow-diff.mjs`:

```javascript
#!/usr/bin/env node
// Usage: REDIS_URL=redis://127.0.0.1:6379 node scripts/rnsquadjs-shadow-diff.mjs <serverId> [sinceMs]
import Redis from 'ioredis';
import { compareStreams } from '../docker/rnsquadjs/plugins/panelBridge/src/shadowDiff.js';

const [serverId, sinceMsRaw] = process.argv.slice(2);
if (!serverId) {
  console.error('usage: rnsquadjs-shadow-diff.mjs <serverId> [sinceMs]');
  process.exit(2);
}
const since = Date.now() - Number(sinceMsRaw ?? 24 * 3600 * 1000);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

async function readStream(name) {
  const raw = await redis.xrange(name, String(since), '+');
  return raw.map(([, fields]) => {
    const envelope = JSON.parse(fields[fields.indexOf('envelope') + 1]);
    return { type: envelope.type, ts: envelope.ts, payload: envelope.payload };
  });
}

// D4: only log-pipeline event types are owned by the sidecar; rcon.* stay with worker-rcon.
const SIDE_TYPES = new Set([
  'player.connected', 'player.disconnected', 'player.name_changed',
  'match.started', 'match.ended',
]);
const prod = (await readStream(`events:server:${serverId}`)).filter((e) => SIDE_TYPES.has(e.type));
const shadow = (await readStream(`events:server:${serverId}:shadow`)).filter((e) =>
  SIDE_TYPES.has(e.type),
);
const r = compareStreams(prod, shadow);
console.log(JSON.stringify({ serverId, prod: prod.length, shadow: shadow.length, ...r }, null, 2));
await redis.quit();
process.exit(r.parityPct >= 99 && r.missingTypes.length === 0 ? 0 : 1);
```

Note: the plugin ships compiled JS in the image, but in-repo it is TS. Add `"build": "tsc -p tsconfig.json"` check: run `npx tsc -p tsconfig.json --noEmit` in the plugin dir; the runner imports the **built** `lib/shadowDiff.js` if `src/*.js` is absent — if the import fails at soak time, run `npx tsc -p tsconfig.json` in the plugin dir first and import from `../docker/rnsquadjs/plugins/panelBridge/lib/shadowDiff.js`. Pick whichever path exists and keep the import consistent.

- [ ] **Step 5: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge scripts/rnsquadjs-shadow-diff.mjs
git commit -m "feat(rnsquadjs): shadow-stream parity comparator and soak runner"
```

### Task 5: Rewrite the sidecar entrypoint for file-based config (D1)

**Files:** Modify `docker/rnsquadjs/entrypoint.sh`, `docker/rnsquadjs.Dockerfile`

- [ ] **Step 1: Replace `docker/rnsquadjs/entrypoint.sh` entirely:**

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${SERVER_ID:?SERVER_ID is required}"
: "${LOG_FILE:=/squad/Logs/SquadGame.log}"

if [ ! -s /app/config.json ]; then
  echo "[panelBridge] /app/config.json missing or empty (must be bind-mounted by the bridge)" >&2
  exit 1
fi

echo "[panelBridge] waiting for ${LOG_FILE} (up to 60s)"
deadline=$(( $(date +%s) + 60 ))
until [ -f "${LOG_FILE}" ]; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "[panelBridge] timed out waiting for ${LOG_FILE}" >&2
    exit 1
  fi
  sleep 1
done
echo "[panelBridge] log file present; upstream SHA: $(cat /UPSTREAM_SHA 2>/dev/null || echo unknown)"

exec node lib/index.js
```

- [ ] **Step 2: Check the Dockerfile still applies** — `curl` may now be removable from the runtime stage; if `docker/rnsquadjs.Dockerfile` installs curl only for the entrypoint, drop it. Build:

```bash
docker build -f docker/rnsquadjs.Dockerfile -t squad-panel/rnsquadjs:latest .
docker run --rm --entrypoint cat squad-panel/rnsquadjs:latest /UPSTREAM_SHA
```

Expected: image builds; prints `d76fb4a84bc64ae09b654d4dc17ab06ef308d295`. (If the build context in the Dockerfile is the repo root, use the build command recorded in `ai_docs/rnsquadjs-migration-pin-2026-04-24.md`.)

- [ ] **Step 3: Commit** — `git add docker/ && git commit -m "feat(rnsquadjs): file-based config entrypoint (no HTTP fetch, read-only rootfs safe)"`

### Task 6: Go bridge — validate allowlists (image, container name, socket root)

**Files:** Modify `apps/bridge/internal/validate/docker.go` (consts at :10-26, `ContainerName` at :50-55), `apps/bridge/internal/validate/paths.go`; Test `docker_test.go`, `paths_test.go`

- [ ] **Step 1: Write failing tests** — append to `apps/bridge/internal/validate/docker_test.go`:

```go
func TestContainerNameAcceptsRnsquadjsSidecar(t *testing.T) {
	if err := ContainerName("rnsquadjs-0196f0a2-1111-2222-3333-444444444444"); err != nil {
		t.Fatalf("expected sidecar name to be allowed, got %v", err)
	}
}

func TestContainerNameRejectsRnsquadjsGarbage(t *testing.T) {
	for _, name := range []string{"rnsquadjs-", "rnsquadjs-notauuid", "rnsquadjs-0196f0a2-1111-2222-3333-44444444444Z"} {
		if err := ContainerName(name); err == nil {
			t.Fatalf("expected %q to be rejected", name)
		}
	}
}

func TestContainerImageAllowsRnsquadjs(t *testing.T) {
	if err := ContainerImage(RNSquadJSImage); err != nil {
		t.Fatalf("expected rnsquadjs image allowed, got %v", err)
	}
}
```

Append to `paths_test.go`:

```go
func TestPanelSocketPath(t *testing.T) {
	if _, err := PanelSocketPath("/run/squad-panel/rnsquadjs/0196f0a2-1111-2222-3333-444444444444"); err != nil {
		t.Fatalf("expected socket subdir allowed, got %v", err)
	}
	if _, err := PanelSocketPath("/etc/passwd"); err == nil {
		t.Fatal("expected path outside socket root rejected")
	}
}
```

- [ ] **Step 2: Run** `cd apps/bridge && go test ./internal/validate/` — expected: FAIL (undefined: `RNSquadJSImage`, `PanelSocketPath`).

- [ ] **Step 3: Implement** — in `docker.go` add to the const block (after `DepotInitImage`):

```go
	RNSquadJSImage  = "squad-panel/rnsquadjs:latest"
	PanelSocketRoot = "/run/squad-panel/rnsquadjs"
```

Add to the var block:

```go
	rnsquadjsContainerRegex = regexp.MustCompile(`^rnsquadjs-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
```

Register the image in `allowedImages` (add `RNSquadJSImage: {},`) and extend `ContainerName`:

```go
func ContainerName(name string) error {
	if !serverContainerRegex.MatchString(name) &&
		!rnsquadjsContainerRegex.MatchString(name) &&
		!depotJobRegex.MatchString(name) {
		return fmt.Errorf("%w: container name %q does not match allowed pattern", ErrForbidden, name)
	}
	return nil
}
```

In `paths.go` add:

```go
// PanelSocketPath validates p lies under the rnsquadjs socket/config root.
func PanelSocketPath(p string) (string, error) {
	return Path(p, PanelSocketRoot)
}
```

(`PanelSocketRoot` lives in `docker.go`; both files are package `validate`.)

- [ ] **Step 4: Run** `go test ./internal/validate/` — expected: PASS. Also `go vet ./...`.

- [ ] **Step 5: Commit** — `git add apps/bridge/internal/validate && git commit -m "feat(bridge): allowlist rnsquadjs image, sidecar container names, socket root"`

### Task 7: Go bridge — `RunRNSquadJS` runner + RPC dispatch

**Files:** Modify `apps/bridge/internal/runner/docker.go`, `apps/bridge/internal/handlers/handlers.go` (dispatch switch at :115-162, params structs near :495); Test `runner/docker_test.go`, `handlers/handlers_test.go`

- [ ] **Step 1: Write failing runner test** — append to `runner/docker_test.go` (follow the file's existing fake-runner pattern for `d.R`):

```go
func TestComposeRNSquadJSArgs(t *testing.T) {
	d := &DockerRunner{}
	spec := RNSquadJSRunSpec{
		ServerID: "0196f0a2-1111-2222-3333-444444444444",
		Env:      map[string]string{"PANEL_BRIDGE_MODE": "shadow", "SERVER_ID": "0196f0a2-1111-2222-3333-444444444444"},
	}
	args, err := d.composeRNSquadJSArgs(spec)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--name rnsquadjs-0196f0a2-1111-2222-3333-444444444444",
		"--network host",
		"--read-only",
		"-v /var/lib/squad-panel/saved/0196f0a2-1111-2222-3333-444444444444/SquadGame/Saved/Logs:/squad/Logs:ro",
		"-v /run/squad-panel/rnsquadjs/0196f0a2-1111-2222-3333-444444444444:/run/panelBridge:rw",
		"-v /run/squad-panel/rnsquadjs/0196f0a2-1111-2222-3333-444444444444/config.json:/app/config.json:ro",
		"-e PANEL_BRIDGE_MODE=shadow",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q\nargs: %s", want, joined)
		}
	}
}

func TestComposeRNSquadJSArgsRejectsBadUUID(t *testing.T) {
	d := &DockerRunner{}
	if _, err := d.composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: "not-a-uuid"}); err == nil {
		t.Fatal("expected bad uuid rejected")
	}
}
```

- [ ] **Step 2: Run** `go test ./internal/runner/` — FAIL (undefined `RNSquadJSRunSpec`).

- [ ] **Step 3: Implement** in `runner/docker.go` (imports: add `"os"`, `"sort"` if absent):

```go
type RNSquadJSRunSpec struct {
	ServerID string            `json:"server_id"`
	Env      map[string]string `json:"env"`
}

func (d *DockerRunner) composeRNSquadJSArgs(spec RNSquadJSRunSpec) ([]string, error) {
	if err := validate.ServerUUID(spec.ServerID); err != nil {
		return nil, err
	}
	name := "rnsquadjs-" + spec.ServerID
	if err := validate.ContainerName(name); err != nil {
		return nil, err
	}
	serverDir := validate.PanelSocketRoot + "/" + spec.ServerID
	logsBind := fmt.Sprintf("%s/%s/SquadGame/Saved/Logs:/squad/Logs:ro", validate.PanelSavedRoot, spec.ServerID)
	socketBind := fmt.Sprintf("%s:/run/panelBridge:rw", serverDir)
	configBind := fmt.Sprintf("%s/config.json:/app/config.json:ro", serverDir)

	args := []string{
		"run", "-d",
		"--pull", "never",
		"--name", name,
		"--label", "panel.server_id=" + spec.ServerID,
		"--label", "panel.kind=rnsquadjs",
		"--network", "host",
		"--user", "1001:1001",
		"--read-only",
		"--restart", "unless-stopped",
		"-v", logsBind,
		"-v", socketBind,
		"-v", configBind,
	}
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, spec.Env[k]))
	}
	args = append(args, validate.RNSquadJSImage)
	return args, nil
}

// RunRNSquadJS launches the per-server sidecar. The per-server socket/config
// directory must exist with panel-group write access before docker mounts it;
// the root is created by tmpfiles.d as 2775 root:panel, so the setgid bit
// propagates the group here. MkdirAll honours umask, hence the explicit Chmod.
func (d *DockerRunner) RunRNSquadJS(ctx context.Context, spec RNSquadJSRunSpec) (string, error) {
	args, err := d.composeRNSquadJSArgs(spec)
	if err != nil {
		return "", err
	}
	serverDir := validate.PanelSocketRoot + "/" + spec.ServerID
	if err := os.MkdirAll(serverDir, 0o775); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", serverDir, err)
	}
	if err := os.Chmod(serverDir, 0o2775); err != nil {
		return "", fmt.Errorf("chmod %s: %w", serverDir, err)
	}
	so, se, exit, err := d.R.Run(ctx, d.Bin, args, nil)
	if err != nil {
		return strings.TrimSpace(string(so)), err
	}
	if exit != 0 {
		return strings.TrimSpace(string(so)), fmt.Errorf("docker run rnsquadjs exit %d: %s", exit, strings.TrimSpace(string(se)))
	}
	return strings.TrimSpace(string(so)), nil
}
```

- [ ] **Step 4: Run** `go test ./internal/runner/` — PASS.

- [ ] **Step 5: Write failing handlers test** — append to `handlers/handlers_test.go` (mirror an existing `container_run` dispatch test in the file for setup):

```go
func TestContainerRunRnsquadjsDispatch(t *testing.T) {
	d := newTestDispatcher(t) // use the file's existing dispatcher fixture helper
	req := makeReq(t, "container_run_rnsquadjs", map[string]any{
		"server_id": "not-a-uuid",
		"env":       map[string]string{},
	})
	resp := d.Handle(context.Background(), req, nil)
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected forbidden for bad uuid, got %+v", resp)
	}
}
```

(Adapt fixture-helper names to the ones actually present in `handlers_test.go`; the assertion contract — unknown uuid ⇒ `CodeForbidden` — must hold.)

- [ ] **Step 6: Implement** in `handlers.go` — add the params struct next to `containerRunParams`:

```go
type containerRunRnsquadjsParams struct {
	ServerID string            `json:"server_id"`
	Env      map[string]string `json:"env"`
}
```

Add to the `Handle` switch (after `case "container_run":`):

```go
	case "container_run_rnsquadjs":
		return d.containerRunRnsquadjs(ctx, req)
```

Add the handler (next to `containerRun`):

```go
func (d *Dispatcher) containerRunRnsquadjs(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerRunRnsquadjsParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	id, err := d.Docker.RunRNSquadJS(ctx, runner.RNSquadJSRunSpec{ServerID: p.ServerID, Env: p.Env})
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"container_id": id, "status": "started"})
	return rpc.NewSuccessResponse(req.ID, body)
}
```

- [ ] **Step 7: Full bridge gate**

```bash
cd apps/bridge && gofmt -l -s . && go vet ./... && go test -race -count=1 ./...
```

Expected: no gofmt output, vet clean, all packages PASS.

- [ ] **Step 8: Commit** — `git commit -am "feat(bridge): container_run_rnsquadjs RPC with per-server socket dir and config bind"`

### Task 8: Method allowlist + bridge client

**Files:** Modify `packages/shared-config/src/bridge-methods.ts` (array at :1-25), `packages/bridge-client/src/types.ts`, `packages/bridge-client/src/client.ts` (near `containerRun` at :195)

- [ ] **Step 1:** Add `'container_run_rnsquadjs',` after `'container_run',` in `BRIDGE_METHODS`.

- [ ] **Step 2:** In `bridge-client/src/types.ts` (next to `ContainerRunParams`):

```typescript
export interface ContainerRunRnsquadjsParams {
  server_id: string;
  env: Record<string, string>;
}

export interface ContainerRunRnsquadjsResult {
  container_id: string;
  status: 'started';
}
```

- [ ] **Step 3:** In `client.ts` (next to `containerRun`):

```typescript
  containerRunRnsquadjs = (p: ContainerRunRnsquadjsParams) =>
    this.call<ContainerRunRnsquadjsResult>('container_run_rnsquadjs', p, { timeoutMs: 60_000 });
```

(Import the two types in the file's existing type-import block.)

- [ ] **Step 4: Gate + commit**

```bash
pnpm turbo run typecheck --filter=@squad/shared-config --filter=@squad/bridge-client
pnpm turbo run test --filter=@squad/shared-config --filter=@squad/bridge-client
git commit -am "feat(bridge-client): containerRunRnsquadjs wrapper + method allowlist"
```

### Task 9: Cutover-set helper + rcon socket client path fix

**Files:** Create `packages/shared-config/src/rnsquadjs.ts`, `packages/shared-config/test/rnsquadjs.test.ts`; Modify `packages/shared-config/src/index.ts` (re-export), `apps/api/src/lib/rcon.ts`, `apps/api/test/lib/rcon.test.ts`

- [ ] **Step 1: Failing test** — `packages/shared-config/test/rnsquadjs.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { RNSQUADJS_CUTOVER_SET, filterCutoverServers } from '../src/rnsquadjs.js';

describe('filterCutoverServers', () => {
  it('partitions ids by set membership with one SMISMEMBER call', async () => {
    const smismember = vi.fn().mockResolvedValue([1, 0]);
    const redis = { smismember } as never;
    const r = await filterCutoverServers(redis, ['a', 'b']);
    expect(smismember).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, 'a', 'b');
    expect(r.cutover).toEqual(['a']);
    expect(r.legacy).toEqual(['b']);
  });

  it('returns empty partitions for empty input without calling redis', async () => {
    const smismember = vi.fn();
    const r = await filterCutoverServers({ smismember } as never, []);
    expect(r).toEqual({ cutover: [], legacy: [] });
    expect(smismember).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, FAIL**, then implement `src/rnsquadjs.ts`:

```typescript
import type { Redis } from 'ioredis';

/** Members of this set are served by the RNSquadJS sidecar (production mode);
 *  worker-log-ingest must skip them. Empty set = fully legacy (D3). */
export const RNSQUADJS_CUTOVER_SET = 'rnsquadjs:cutover-servers';

export async function filterCutoverServers(
  redis: Redis,
  serverIds: string[],
): Promise<{ cutover: string[]; legacy: string[] }> {
  if (serverIds.length === 0) return { cutover: [], legacy: [] };
  const flags = await redis.smismember(RNSQUADJS_CUTOVER_SET, ...serverIds);
  const cutover: string[] = [];
  const legacy: string[] = [];
  serverIds.forEach((id, i) => (flags[i] === 1 ? cutover : legacy).push(id));
  return { cutover, legacy };
}
```

Re-export from `packages/shared-config/src/index.ts` alongside the existing exports: `export * from './rnsquadjs.js';`

- [ ] **Step 3:** Fix `apps/api/src/lib/rcon.ts` socket path for D2 — change the `exec` line:

```typescript
      const socketPath = join(socketDir, serverId, 'rcon.sock');
```

Update the path assertion in `apps/api/test/lib/rcon.test.ts` accordingly (the test stands up a unix-socket server; point it at `<tmpdir>/<serverId>/rcon.sock`).

- [ ] **Step 4: Gate + commit**

```bash
pnpm turbo run test --filter=@squad/shared-config --filter=@squad/api -- lib/rcon
git commit -am "feat(shared-config): rnsquadjs cutover set helpers; fix(api): per-server sidecar socket path"
```

### Task 10: API sidecar library — config renderer, env builder, paths

**Files:** Create `apps/api/src/lib/rnsquadjs.ts`, `apps/api/test/lib/rnsquadjs.test.ts`; Modify `apps/api/src/config.ts`

- [ ] **Step 1: Failing test** — `apps/api/test/lib/rnsquadjs.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  buildSidecarEnv,
  renderRnsquadjsConfig,
  sidecarConfigPath,
} from '../../src/lib/rnsquadjs.js';

const SERVER_ID = '0196f0a2-1111-2222-3333-444444444444';

describe('sidecar paths and env', () => {
  it('config path lives in the per-server socket dir', () => {
    expect(sidecarConfigPath(SERVER_ID)).toBe(
      `/run/squad-panel/rnsquadjs/${SERVER_ID}/config.json`,
    );
  });

  it('env defaults to shadow mode and host-loopback redis (D5)', () => {
    const env = buildSidecarEnv(SERVER_ID, 'shadow', undefined);
    expect(env).toEqual({
      SERVER_ID,
      LOG_FILE: '/squad/Logs/SquadGame.log',
      PANEL_BRIDGE_MODE: 'shadow',
      PANEL_BRIDGE_SOCKET: '/run/panelBridge/rcon.sock',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
  });

  it('production mode and explicit redis url pass through', () => {
    const env = buildSidecarEnv(SERVER_ID, 'production', 'redis://127.0.0.1:6380/2');
    expect(env.PANEL_BRIDGE_MODE).toBe('production');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6380/2');
  });
});

describe('renderRnsquadjsConfig', () => {
  it('renders rcon target, disables mongo-coupled plugins, enables panelBridge', async () => {
    const app = {
      db: {
        query: {
          serverCredentials: {
            findFirst: vi.fn().mockResolvedValue({ serverId: SERVER_ID, rconPort: 21114 }),
          },
        },
      },
      bridge: {
        fileRead: vi.fn().mockResolvedValue({ content: 'Password=s3cret\n' }),
      },
    };
    const cfg = await renderRnsquadjsConfig(app as never, SERVER_ID);
    const entry = cfg[SERVER_ID];
    expect(entry).toMatchObject({
      id: SERVER_ID,
      host: '127.0.0.1',
      port: 21114,
      password: 's3cret',
      logFilePath: '/squad/Logs/SquadGame.log',
    });
    expect(entry.plugins.panelBridge).toEqual({ enabled: true });
    for (const p of ['autoUpdateMods', 'chatCommands', 'voteMap', 'warnings', 'broadcasts', 'autoKick', 'squadLeader']) {
      expect(entry.plugins[p]).toEqual({ enabled: false });
    }
  });

  it('throws when credentials are missing', async () => {
    const app = {
      db: { query: { serverCredentials: { findFirst: vi.fn().mockResolvedValue(undefined) } } },
      bridge: { fileRead: vi.fn() },
    };
    await expect(renderRnsquadjsConfig(app as never, SERVER_ID)).rejects.toThrow(/credentials/);
  });
});
```

- [ ] **Step 2: Run, FAIL**, then implement `apps/api/src/lib/rnsquadjs.ts` (mirror `PANEL_CONFIGS_ROOT` usage from `server-install.ts`):

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serverCredentials } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export const RNSQUADJS_SOCKET_ROOT = '/run/squad-panel/rnsquadjs';
const PANEL_CONFIGS_ROOT = '/var/lib/squad-panel/configs';

const RN_DISABLED_PLUGINS = [
  'autoUpdateMods',
  'chatCommands',
  'voteMap',
  'warnings',
  'broadcasts',
  'autoKick',
  'squadLeader',
] as const;

export type SidecarMode = 'shadow' | 'production';

export function sidecarConfigPath(serverId: string): string {
  return `${RNSQUADJS_SOCKET_ROOT}/${serverId}/config.json`;
}

export function sidecarContainerName(serverId: string): string {
  return `rnsquadjs-${serverId}`;
}

export function buildSidecarEnv(
  serverId: string,
  mode: SidecarMode,
  redisUrl: string | undefined,
): Record<string, string> {
  return {
    SERVER_ID: serverId,
    LOG_FILE: '/squad/Logs/SquadGame.log',
    PANEL_BRIDGE_MODE: mode,
    PANEL_BRIDGE_SOCKET: '/run/panelBridge/rcon.sock',
    REDIS_URL: redisUrl ?? 'redis://127.0.0.1:6379',
  };
}

export async function renderRnsquadjsConfig(
  app: FastifyInstance,
  serverId: string,
): Promise<Record<string, Record<string, unknown> & { plugins: Record<string, { enabled: boolean }> }>> {
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });
  if (!creds) throw new Error(`no credentials for server ${serverId}`);

  const rconCfg = await app.bridge.fileRead({
    path: `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/Rcon.cfg`,
  });
  const password = rconCfg.content.match(/^\s*Password\s*=\s*(.*)$/m)?.[1]?.trim() ?? '';

  return {
    [serverId]: {
      id: serverId,
      host: '127.0.0.1',
      port: creds.rconPort,
      password,
      logFilePath: '/squad/Logs/SquadGame.log',
      adminsFilePath: '/squad/SquadGame/ServerConfig/Admins.cfg',
      mapsName: 'vanilla.json',
      mapsRegExp: '',
      plugins: {
        panelBridge: { enabled: true },
        ...Object.fromEntries(RN_DISABLED_PLUGINS.map((name) => [name, { enabled: false }])),
      },
    },
  };
}

/** The socket root is bind-mounted rw into the API container (docker-compose),
 *  so the API writes the file directly — no bridge round-trip (D1). */
export async function writeSidecarConfig(app: FastifyInstance, serverId: string): Promise<void> {
  const config = await renderRnsquadjsConfig(app, serverId);
  const path = sidecarConfigPath(serverId);
  await mkdir(dirname(path), { recursive: true, mode: 0o775 });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o640 });
}
```

If `app.db.query.serverCredentials` is not enabled in the drizzle instance, fall back to the select style used across `apps/api/src/routes/servers.ts:409-411` (`app.db.select().from(serverCredentials).where(...).limit(1)`) and adjust the test mock to match.

- [ ] **Step 3:** Run tests — PASS. Then `pnpm turbo run typecheck --filter=@squad/api`.

- [ ] **Step 4: Commit** — `git add apps/api && git commit -m "feat(api): rnsquadjs config renderer, sidecar env builder, file-based config writer"`

### Task 11: Wire install / stop / delete + app decoration

**Files:** Modify `apps/api/src/routes/server-install.ts` (after the `containerRun` block at :239-252), `apps/api/src/routes/servers.ts` (stop flow, after `containerStop` at :516), `apps/api/src/lib/server-delete.ts` (next to its `containerRm` call), `apps/api/src/server.ts` (:77-78 decorations), `apps/api/src/plugins/types.ts` (:14-21)

- [ ] **Step 1: Decorate `app.rcon`** — in `server.ts` after the `encryptionKey` decoration:

```typescript
app.decorate('rcon', createRconClient());
```

with `import { createRconClient } from './lib/rcon.js';`. In `plugins/types.ts` add to the `FastifyInstance` interface:

```typescript
    rcon: RconClient;
```

with `import type { RconClient } from '../lib/rcon.js';`.

- [ ] **Step 2: Install flow** — in `server-install.ts`, inside `runInstall` directly after the squad `containerRun` success (after the `container` sink step, before the `done` step), insert:

```typescript
  sink('rnsquadjs', 'rendering sidecar config');
  await app.bridge.fileAtomicWrite({
    path: `${PANEL_SAVED_ROOT}/${serverId}/SquadGame/Saved/Logs/.keep`,
    content: '',
  });
  await writeSidecarConfig(app, serverId);
  const mode = (await app.redis.sismember(RNSQUADJS_CUTOVER_SET, serverId)) === 1
    ? 'production'
    : 'shadow';
  const sidecar = await app.bridge.containerRunRnsquadjs({
    server_id: serverId,
    env: buildSidecarEnv(serverId, mode, process.env.RNSQUADJS_REDIS_URL),
  });
  sink('rnsquadjs', `sidecar ${sidecar.container_id} started (${mode})`);
```

Imports: `writeSidecarConfig`, `buildSidecarEnv` from `../lib/rnsquadjs.js`; `RNSQUADJS_CUTOVER_SET` from `@squad/shared-config`. Match the file's actual `sink(...)` signature (see neighbouring `sink('container', ...)` calls) — if sink takes a single line string, emit `rnsquadjs: …` strings the same way neighbours do. Sidecar launch failures must **not** fail the install: wrap the block in try/catch, `sink('rnsquadjs', 'sidecar launch failed: …')` and continue (shadow sidecar is non-load-bearing pre-cutover).

- [ ] **Step 3: Stop flow** — in `servers.ts` directly after the squad `containerStop` call (:516):

```typescript
      await app.bridge
        .containerStop({ name: sidecarContainerName(s.id), timeout_sec: 30 })
        .catch((err: unknown) => {
          req.log.warn({ err: (err as Error).message, id: s.id }, 'rnsquadjs sidecar stop failed (continuing)');
        });
```

The graceful-RCON section (rconSendOnce broadcasts) stays **unchanged** (D4).

- [ ] **Step 4: Delete flow** — in `apps/api/src/lib/server-delete.ts`, immediately after the existing squad `containerRm` call add:

```typescript
  await bridge.containerRm({ name: `rnsquadjs-${serverId}` }).catch(() => {});
```

(Adapt receiver names — `bridge` vs `app.bridge`, `serverId` vs the local id variable — to the function you are inside; the squad `containerRm` line two lines above is the template.)

- [ ] **Step 5: Tests.** Extend the existing install/stop/delete unit tests (they mock `app.bridge`): in the install test file assert `containerRunRnsquadjs` was called with `env.PANEL_BRIDGE_MODE === 'shadow'` when the redis mock returns 0 from `sismember`; in the stop/delete test files assert `containerStop`/`containerRm` were additionally called with `name: 'rnsquadjs-<id>'`. Follow each file's existing mock-bridge fixture; add `sismember: vi.fn().mockResolvedValue(0)` to the redis mock where missing.

- [ ] **Step 6: Gate + commit**

```bash
pnpm turbo run test --filter=@squad/api && pnpm turbo run typecheck --filter=@squad/api
git commit -am "feat(api): launch rnsquadjs sidecar on install, symmetric stop/delete teardown"
```

### Task 12: log-ingest kill switch (D3)

**Files:** Modify `apps/workers/log-ingest/src/index.ts` (reconcile fn, lines 128-141); Test: extend an existing log-ingest unit test file or add `apps/workers/log-ingest/test/cutover-filter.test.ts`

- [ ] **Step 1: Failing test** — `apps/workers/log-ingest/test/cutover-filter.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { dropCutoverServers } from '../src/cutover.js';

describe('dropCutoverServers', () => {
  it('removes servers present in rnsquadjs:cutover-servers', async () => {
    const redis = { smismember: vi.fn().mockResolvedValue([0, 1]) } as never;
    const wanted = [
      { serverId: 'a', beaconPort: 1 },
      { serverId: 'b', beaconPort: 2 },
    ];
    const out = await dropCutoverServers(redis, wanted);
    expect(out.map((w) => w.serverId)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run, FAIL**, implement `apps/workers/log-ingest/src/cutover.ts`:

```typescript
import { filterCutoverServers } from '@squad/shared-config';
import type { Redis } from 'ioredis';

export async function dropCutoverServers<T extends { serverId: string }>(
  redis: Redis,
  wanted: T[],
): Promise<T[]> {
  const { legacy } = await filterCutoverServers(redis, wanted.map((w) => w.serverId));
  const keep = new Set(legacy);
  return wanted.filter((w) => keep.has(w.serverId));
}
```

- [ ] **Step 3: Wire** — in `src/index.ts`, in the reconcile function, after the `wanted` array is built and before `manager.reconcile(wanted)` (≈ line 140):

```typescript
    const active = await dropCutoverServers(redis, wanted);
    manager.reconcile(active);
```

(Use the file's actual redis handle name. If `wanted` items use a different id field name, adapt `dropCutoverServers`'s constraint accordingly — check the `TailWanted` type at the top of the file.)

- [ ] **Step 4: Gate + commit**

```bash
pnpm turbo run test --filter=@squad/worker-log-ingest && pnpm turbo run typecheck --filter=@squad/worker-log-ingest
git commit -am "feat(log-ingest): skip servers cut over to the rnsquadjs sidecar"
```

### Task 13: Cutover/rollback endpoint

**Files:** Create `apps/api/src/routes/server-rnsquadjs.ts`, `apps/api/test/server-rnsquadjs.test.ts`; Modify `apps/api/src/server.ts` (register after `serverInstallRoutes`, :127)

- [ ] **Step 1: Failing test** — `apps/api/test/server-rnsquadjs.test.ts`, following the harness pattern of `apps/api/test/server-archive.test.ts` (build app with mocked bridge/redis, authenticated owner session). Assert:

```typescript
// POST /api/v1/servers/:id/rnsquadjs { mode: 'production' }
// 1. SADD rnsquadjs:cutover-servers <id> was called
// 2. bridge.containerRm({ name: `rnsquadjs-<id>` }) then bridge.containerRunRnsquadjs
//    with env.PANEL_BRIDGE_MODE === 'production'
// 3. response 200 { server_id, mode: 'production' }
//
// POST { mode: 'shadow' } (rollback):
// 1. containerRm + containerRunRnsquadjs with PANEL_BRIDGE_MODE 'shadow' FIRST
// 2. SREM rnsquadjs:cutover-servers <id> AFTER the sidecar swap (call order!)
// 3. response 200 { server_id, mode: 'shadow' }
//
// 404 for unknown server id; 403 without the server-control permission.
```

Write these as real vitest cases with the harness; assert call order via `mock.invocationCallOrder`.

- [ ] **Step 2: Run, FAIL**, implement `apps/api/src/routes/server-rnsquadjs.ts`:

```typescript
import { setTimeout as sleep } from 'node:timers/promises';
import { servers } from '@squad/db/schema';
import { RNSQUADJS_CUTOVER_SET } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  buildSidecarEnv,
  sidecarContainerName,
  writeSidecarConfig,
} from '../lib/rnsquadjs.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ mode: z.enum(['production', 'shadow']) });

// During production cutover the log-ingest worker keeps tailing until its next
// reconcile tick (15s). Waiting one full tick before the sidecar goes
// production-mode prevents duplicate events in events:server:{id}.
const RECONCILE_TICK_MS = 16_000;

const serverRnsquadjsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/rnsquadjs',
    {
      schema: { params: paramsSchema, body: bodySchema },
      config: {
        permissions: ['server:control'],
        audit: { action: 'server.rnsquadjs_cutover', resource: 'server' },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { mode } = req.body;
      const row = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }

      if (mode === 'production') {
        await app.redis.sadd(RNSQUADJS_CUTOVER_SET, id);
        await sleep(RECONCILE_TICK_MS);
      }

      await writeSidecarConfig(app, id);
      await app.bridge.containerRm({ name: sidecarContainerName(id) }).catch(() => {});
      const sidecar = await app.bridge.containerRunRnsquadjs({
        server_id: id,
        env: buildSidecarEnv(id, mode, process.env.RNSQUADJS_REDIS_URL),
      });

      if (mode === 'shadow') {
        // Rollback order: sidecar back to shadow first, then re-enable log-ingest.
        await app.redis.srem(RNSQUADJS_CUTOVER_SET, id);
      }

      return { server_id: id, mode, container_id: sidecar.container_id };
    },
  );
};

export default serverRnsquadjsRoutes;
```

Adapt `permissions: ['server:control']` to the **exact** permission string the stop route uses (`servers.ts:388-395`, visible in its route config) — they must match. Same for the `audit` config shape (copy a neighbouring mutating route). If `app.db.query.servers` is unavailable, use the select style as in Task 10. The 16 s sleep will slow the route; if the API's default request timeout is below ~20 s, move the SADD+sleep+swap into a fire-and-forget async block that reports progress via the audit log — check how `server-install.ts` handles its long-running `runInstall` (fire-and-forget at :374) and mirror it; the test then asserts on the eventual bridge calls with `vi.waitFor`.

- [ ] **Step 3:** Register in `server.ts` after `serverInstallRoutes`:

```typescript
await app.register(serverRnsquadjsRoutes);
```

- [ ] **Step 4: Gate + commit**

```bash
pnpm turbo run test --filter=@squad/api && pnpm turbo run typecheck --filter=@squad/api
git commit -am "feat(api): per-server rnsquadjs cutover/rollback endpoint"
```

### Task 14: Host plumbing — compose mount, tmpfiles, systemd, e2e

**Files:** Modify `docker-compose.yml` (api service), `apps/bridge/deploy/panel-host-bridge.tmpfiles.conf`, `apps/bridge/deploy/panel-host-bridge.service` (:48 ReadWritePaths), `apps/api/test/e2e/install-lifecycle.e2e.test.ts`

- [ ] **Step 1:** `docker-compose.yml` — add to the `api` service `volumes` list:

```yaml
      - /run/squad-panel/rnsquadjs:/run/squad-panel/rnsquadjs:rw
```

- [ ] **Step 2:** `panel-host-bridge.tmpfiles.conf` — add (setgid so per-server dirs inherit the panel group; see Task 7 comment):

```
d /run/squad-panel 0755 root root -
d /run/squad-panel/rnsquadjs 2775 root panel -
```

- [ ] **Step 3:** `panel-host-bridge.service` — extend `ReadWritePaths` with ` /run/squad-panel` (the bridge mkdirs per-server subdirs under `ProtectSystem=strict`).

- [ ] **Step 4:** Port the branch's e2e assertions: in `apps/api/test/e2e/install-lifecycle.e2e.test.ts` add, after the existing install-success assertions — sidecar container exists (`docker ps` label `panel.kind=rnsquadjs`), heartbeat key `worker:heartbeat:rnsquadjs:<id>` appears within 30 s, shadow stream `events:server:<id>:shadow` receives at least one envelope while the server runs, and the sidecar exits when the squad container stops. Use the branch file as reference for shape: `git show feat/rnsquadjs-migration:apps/api/test/e2e/install-lifecycle.e2e.test.ts` — port the *assertions*, not the file (master's version changed).

- [ ] **Step 5: Commit** — `git commit -am "feat(infra): rnsquadjs socket root via tmpfiles, api mount, sidecar e2e assertions"`

### Task 15: Full local gate (Gate G1) + push

- [ ] **Step 1:**

```bash
pnpm turbo run typecheck && pnpm turbo run test
cd apps/bridge && gofmt -l -s . && go vet ./... && go test -race -count=1 ./... && cd -
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run && npx tsc -p tsconfig.json --noEmit && cd -
docker build -f docker/rnsquadjs.Dockerfile -t squad-panel/rnsquadjs:latest .
pnpm exec biome check --no-errors-on-unmatched .
```

Expected: everything green. Type/lint errors are blockers — fix before proceeding.

- [ ] **Step 2:** Run the full per-task quality protocol one more time over the whole branch diff (Sentrux rescan + `/codex:rescue` with the cumulative diff). Fix blockers.

- [ ] **Step 3:**

```bash
git push -u origin feat/rnsquadjs-integration
```

**GATE G1: STOP.** Review the branch (PR or self-review), merge to master only when green. Phases below run against the deployed master.

### Task 16: Record deviations in the spec

**Files:** Modify `docs/superpowers/specs/2026-04-24-rnsquadjs-migration-design.md` §11, `docs/architecture/decisions.md`

- [ ] **Step 1:** Append D1–D5 (verbatim from this plan's header) to spec §11 with date 2026-06-12. Add one decision-log entry to `docs/architecture/decisions.md` following its existing format: "RNSquadJS sidecar replaces the in-house log parser; worker-rcon retained (D4)".
- [ ] **Step 2:** `git commit -am "docs(spec): record 2026-06-12 rnsquadjs integration deviations D1-D5"` and push.

### Task 17: Deploy to the host (operator steps — Phase 1 prerequisites)

These need sudo; run them on the host, in order. From `ai_docs/rnsquadjs-migration-pin-2026-04-24.md` (updated for tmpfiles):

- [ ] **Step 1: Bridge binary + units**

```bash
cd apps/bridge && make build
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/
sudo install -m 0644 deploy/panel-host-bridge.service /etc/systemd/system/
sudo install -m 0644 deploy/panel-host-bridge.tmpfiles.conf /etc/tmpfiles.d/panel-host-bridge.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/panel-host-bridge.conf
sudo systemctl daemon-reload && sudo systemctl restart panel-host-bridge
sg panel -c 'bash scripts/verify-bridge.sh'
ls -ld /run/squad-panel/rnsquadjs   # expect drwxrwsr-x root panel
```

- [ ] **Step 2: Panel images**

```bash
docker compose build api && docker compose up -d api
docker build -f docker/rnsquadjs.Dockerfile -t squad-panel/rnsquadjs:latest .
```

- [ ] **Step 3: Live e2e**

```bash
export PANEL_TEST_URL=https://squad-panel.lan
export PANEL_TEST_COOKIE=<__Host-sid from browser>
pnpm --filter @squad/api test:e2e
```

Expected: `install-lifecycle` and `bridge-rpc` e2e suites green, including the new sidecar assertions.

### Task 18: Phase 1 — shadow soak on the canary (Gate G2)

- [ ] **Step 1:** Pick the canary (`SELECT id FROM servers WHERE is_canary = true;` — if none, mark one running server: `UPDATE servers SET is_canary = true WHERE id = '<uuid>';`).
- [ ] **Step 2:** Launch its sidecar in shadow mode via the endpoint (`mode: 'shadow'` performs create-or-recreate and does not touch the cutover set):

```bash
curl -sS -X POST "https://squad-panel.lan/api/v1/servers/<uuid>/rnsquadjs" \
  -H 'content-type: application/json' -b "__Host-sid=<cookie>" \
  -d '{"mode":"shadow"}'
```

- [ ] **Step 3:** Verify liveness: `docker logs rnsquadjs-<uuid> --tail 20` (config found, log file found); `redis-cli -u redis://127.0.0.1:6379 ttl worker:heartbeat:rnsquadjs:<uuid>` → positive.
- [ ] **Step 4:** After 24 h of real traffic:

```bash
node scripts/rnsquadjs-shadow-diff.mjs <uuid>
```

**GATE G2:** exit code 0 (parity ≥ 99 %, no missing types). On failure: diff `missingInShadow` samples against `docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts`, fix mapping (TDD in the plugin package against `test/fixtures/SquadGame.log.parsed.json`), rebuild image, recreate sidecar, re-soak 24 h. Max 2 fix iterations, then stop and reassess upstream pin.

### Task 19: Phase 3 — canary production cutover (Gate G3)

- [ ] **Step 1:** `curl … -d '{"mode":"production"}'` (same endpoint). Verify: `redis-cli sismember rnsquadjs:cutover-servers <uuid>` → 1; within 60 s `xlen events:server:<uuid>` grows from sidecar events; log-ingest logs show the server dropped on next reconcile.
- [ ] **Step 2:** UI spot-check (browser, not curl): server detail page events feed updates; players page reflects joins/leaves; no duplicate events in the feed.
- [ ] **Step 3:** 24 h soak. Watch `GET /api/v1/health/workers` (sidecar heartbeat listed, `log-ingest` still healthy) and the diag stream for `worker.heartbeat_lost`.
- [ ] **Rollback if anything regresses:** `curl … -d '{"mode":"shadow"}'` — sidecar returns to shadow, log-ingest resumes within 15 s (events gap ≤ 15 s, no duplicates by design).

**GATE G3: STOP** until 24 h green.

### Task 20: Phase 4 — fleet cutover (Gate G4)

- [ ] **Step 1:** Cut over remaining servers in batches of ≤ 5 via the endpoint; after each batch verify each server's heartbeat + event flow as in Task 19 Step 1, then wait 24 h before the next batch.
- [ ] **Step 2:** Record per-batch results in the ledger. **GATE G4:** whole fleet green 24 h, then 1 week soak before Task 21.

### Task 21: Phase 5 — cleanup

Only after Gate G4 + 1 week. New branch `feat/rnsquadjs-cleanup`:

- [ ] **Step 1:** Delete `apps/workers/log-ingest/` and its compose service `worker-log-ingest` from `docker-compose.yml`; remove `log-ingest` from `KNOWN_WORKERS` in `apps/api/src/plugins/heartbeat-watch.ts:4-11`. The golden fixture already lives in the plugin package (survives per spec §3.6). Keep `worker-rcon` (D4). Keep `dropCutoverServers`? — it dies with the worker; delete `packages/shared-config` helpers only if no other references remain (`git grep filterCutoverServers`).
- [ ] **Step 2:** Run the full Gate-G1 command set again; fix fallout (e.g., tests importing the deleted worker, `turbo.json` filters, README worker table).
- [ ] **Step 3:** Update `README.md` worker list + `docs/architecture/README.md` topology; spec §3.6 checkboxes.
- [ ] **Step 4:** Sentrux + Codex gates, commit, push, merge per `superpowers:finishing-a-development-branch`.

---

## Self-review notes

- Spec coverage: phases 0–2 land via Tasks 1–15; §9 Phase 1 → Task 18; Phase 3 → Tasks 13+19; Phase 4 → Task 20; Phase 5 → Task 21; §7 checklist — unchanged pin, recorded in `ai_docs/rnsquadjs-migration-pin-2026-04-24.md` (re-run only on SHA bump).
- Known intentionally-deferred items (record in ledger as risks): sidecar heartbeats are not in `heartbeat-watch.ts` KNOWN_WORKERS (no `worker.heartbeat_lost` diag for sidecars — per-server watch needs design); `rnsquadjs:status:{id}` has no UI surface yet; `worker-rcon` replacement is out of scope (D4).
- Anchors (`:line`) were verified against master `6a7b3b3` on 2026-06-12; if files drift before execution, search for the quoted code, not the line number.
