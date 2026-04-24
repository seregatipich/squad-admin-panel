# RNSquadJS Migration — Phases 0–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-server RNSquadJS sidecar container, the `panelBridge` overlay plugin, and the panel API wiring so the canary server can be cut over (in a follow-up runbook covering Phases 3–5).

**Architecture:** RNSquadJS is built into a pinned-by-SHA Docker image with our `panelBridge` plugin baked in. Sidecar runs `--network host`, talks to its Squad sibling on `127.0.0.1:<rconPort>`, publishes `EventEnvelope` to `events:server:{id}` (or `:shadow` suffix), writes `rcon:status:{id}` and a heartbeat to Redis, and exposes RCON commands to the panel API over a per-server Unix socket. Panel API renders the sidecar's `config.json` from DB at start. Postgres remains the only datastore; no Mongo, no MariaDB.

**Tech Stack:** TypeScript (panel + plugin), Node 18.18 (RNSquadJS upstream constraint), Vitest, Fastify 5 + Zod type-provider, Drizzle/Postgres, ioredis, Go 1.22 bridge, Docker.

**Spec deviation (documented in §11):** The spec proposed a loopback HTTP server inside the sidecar for RCON commands. With `--network host` shared across all sidecars, port allocation becomes a problem. This plan switches to a **Unix domain socket per server** at `/run/squad-panel/rnsquadjs/{uuid}.sock`, bind-mounted into both the sidecar and the API container. The spec will be updated in Task 17.

---

## Files

### Created
- `docker/rnsquadjs.Dockerfile` — multi-stage build, Node 18.18, RNSquadJS pinned by SHA, `panelBridge` baked in.
- `docker/rnsquadjs/entrypoint.sh` — fetches `config.json` from API, waits for log file, execs RNSquadJS.
- `docker/rnsquadjs/plugins/panelBridge/package.json` — vitest + ioredis + uuid deps.
- `docker/rnsquadjs/plugins/panelBridge/tsconfig.json` — ESM, NodeNext.
- `docker/rnsquadjs/plugins/panelBridge/src/index.ts` — plugin entry, wires emitter→publisher, RCON socket, heartbeat.
- `docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts` — RNSquadJS event → `EventEnvelope` mapper.
- `docker/rnsquadjs/plugins/panelBridge/src/redisPublisher.ts` — `XADD events:…` and `SET rcon:status:…` honouring `PANEL_BRIDGE_MODE`.
- `docker/rnsquadjs/plugins/panelBridge/src/rconUnixServer.ts` — listens on `/run/panelBridge/rcon.sock` (mounted from host), forwards to `squad-rcon`.
- `docker/rnsquadjs/plugins/panelBridge/src/heartbeat.ts` — 10 s tick `SET worker:heartbeat:rnsquadjs:{id}`.
- `docker/rnsquadjs/plugins/panelBridge/test/eventMap.test.ts`
- `docker/rnsquadjs/plugins/panelBridge/test/redisPublisher.test.ts`
- `docker/rnsquadjs/plugins/panelBridge/test/rconUnixServer.test.ts`
- `docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log` — golden log fixture (Phase 0).
- `apps/api/src/routes/internal/rnsquadjs-config.ts` — `GET /internal/rnsquadjs/config/:id`, loopback-guarded.
- `apps/api/src/lib/rcon.ts` — `rcon.exec(serverId, method, args)` Unix-socket client with retry.
- `apps/api/test/internal-rnsquadjs-config.test.ts`
- `apps/api/test/lib/rcon.test.ts`
- `packages/db/drizzle/0008_servers_is_canary.sql`

### Modified
- `apps/bridge/internal/validate/docker.go` — add `RNSquadJSImage` constant + entry, extend `ContainerName` regex for sidecars.
- `apps/bridge/internal/validate/docker_test.go` — assertions for new image + container-name pattern.
- `apps/bridge/internal/validate/paths.go` — add `PanelSocketRoot` and `PanelSocketPath`.
- `apps/bridge/internal/validate/paths_test.go` — assertions for socket root.
- `apps/bridge/internal/runner/docker.go` — `RNSquadJSRunSpec`, `composeRNSquadJSArgs`, `RunRNSquadJS`.
- `apps/bridge/internal/runner/docker_test.go` — assertions for compose args + bad-uuid rejection.
- `apps/bridge/internal/handlers/handlers.go` — dispatch `container_run_rnsquadjs`.
- `packages/shared-config/src/bridge-methods.ts` — add `'container_run_rnsquadjs'` to allowlist.
- `packages/bridge-client/src/types.ts` — `ContainerRunRnsquadjsParams` / `Result`.
- `packages/bridge-client/src/client.ts` — `containerRunRnsquadjs` method.
- `scripts/install-host-bridge.sh` — pre-create `/run/squad-panel/rnsquadjs` 0775 root:panel.
- `packages/db/src/schema/servers.ts` — `is_canary boolean default false`.
- `apps/api/src/server.ts` — register `internalRnsquadjsConfigRoutes` + decorate `app.rcon`.
- `apps/api/src/plugins/types.ts` — augment `FastifyInstance` with `rcon`.
- `apps/api/src/routes/server-install.ts` — ensure Logs dir, sidecar launch via new bridge method.
- `apps/api/src/routes/servers.ts` — symmetric `containerStop` / `containerRm` for sidecar; route stop-flow RCON via `app.rcon.exec`.
- `apps/api/test/e2e/install-lifecycle.e2e.test.ts` — assertions for sidecar lifecycle, EventEnvelope flow, sidecar exit on stop.
- `apps/api/test/e2e/bridge-rpc.e2e.test.ts` — success + forbidden cases for `container_run_rnsquadjs`.
- `docs/superpowers/specs/2026-04-24-rnsquadjs-migration-design.md` — note Unix-socket deviation.

---

## Task 1: Capture golden log fixture (Phase 0)

**Files:**
- Create: `docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log`
- Create: `docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log.parsed.json`

- [ ] **Step 1: Pick the canary server and capture the live log tail**

Run on the host (the operator selects which server UUID to use for canary; the operator gives that UUID to the worker as `CANARY_UUID`):

```bash
mkdir -p docker/rnsquadjs/plugins/panelBridge/test/fixtures
sudo tail -n 5000 \
  /var/lib/squad-panel/saved/${CANARY_UUID}/SquadGame/Saved/Logs/SquadGame.log \
  > docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log
wc -l docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log
```

Expected: ~5000 lines containing at least one each of `LogNet: Join request`, `LogSquad: PostLogin`, `LogSquadTrace: ... OnPossess`, `LogGameMode: PostLogin`, `LogSquad: Player ... has been removed`, `LogSquadTrace: ... OnUnPossess`, `LogGameState: Match State Changed from`, `LogSquadCommon: SQCreatorComponent`. If a type is missing, append a longer capture.

- [ ] **Step 2: Render current parser output as the parity baseline**

```bash
pnpm --filter @squad/worker-log-ingest exec tsx -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { parseLine } from '../../apps/workers/log-ingest/src/parser/ingest.ts';
const lines = readFileSync('docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log','utf8').split(/\r?\n/);
const out = lines.map((line, i) => ({ i, line, parsed: parseLine(line) })).filter(r => r.parsed);
writeFileSync('docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log.parsed.json', JSON.stringify(out, null, 2));
console.log('events:', out.length);
"
```

Expected: `events: <N>` where N > 0. The JSON file is the **golden** parser output — Task 8 will assert RNSquadJS produces a semantically equivalent set.

- [ ] **Step 3: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/test/fixtures/
git commit -m "test(rnsquadjs): capture canary SquadGame.log + parser baseline"
```

---

## Task 2: Bridge image + container-name allowlist for sidecar

**Files:**
- Modify: `apps/bridge/internal/validate/docker.go:10-26`
- Modify: `apps/bridge/internal/validate/docker_test.go`

- [ ] **Step 1: Write failing test for the new image and sidecar container name**

Append to `apps/bridge/internal/validate/docker_test.go`:

```go
func TestContainerImage_AllowsRNSquadJS(t *testing.T) {
	if err := ContainerImage(RNSquadJSImage); err != nil {
		t.Fatalf("expected RNSquadJSImage allowed, got %v", err)
	}
}

func TestContainerName_AllowsRNSquadJSSidecar(t *testing.T) {
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	if err := ContainerName("rnsquadjs-" + uuid); err != nil {
		t.Fatalf("expected rnsquadjs-<uuid> allowed, got %v", err)
	}
}

func TestContainerName_RejectsBogusSidecar(t *testing.T) {
	if err := ContainerName("rnsquadjs-not-a-uuid"); err == nil {
		t.Fatal("expected rejection for non-uuid sidecar name")
	}
}
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd apps/bridge && go test -run "ContainerImage_AllowsRNSquadJS|ContainerName_AllowsRNSquadJSSidecar|ContainerName_RejectsBogusSidecar" ./internal/validate/...
```

Expected: FAIL — `RNSquadJSImage` undefined, sidecar name rejected.

- [ ] **Step 3: Add the constant, allowlist entry, and sidecar regex**

In `apps/bridge/internal/validate/docker.go`:

```go
const (
	PanelDataRoot    = "/var/lib/squad-panel"
	PanelConfigsRoot = "/var/lib/squad-panel/configs"
	PanelSavedRoot   = "/var/lib/squad-panel/saved"
	DepotVolumeName  = "squad-depot"
	ServerImage      = "squad-server:latest"
	DepotInitImage   = "squad-panel/depot-init:latest"
	RNSquadJSImage   = "squad-panel/rnsquadjs:latest"
)

var (
	serverContainerRegex   = regexp.MustCompile(`^squad-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	rnsquadjsContainerRegex = regexp.MustCompile(`^rnsquadjs-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	depotJobRegex          = regexp.MustCompile(`^squad-depot-init-[0-9]{14}$`)
	cfgFileRegex           = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}\.cfg$`)
	allowedImages          = map[string]struct{}{
		ServerImage:    {},
		DepotInitImage: {},
		RNSquadJSImage: {},
	}
	// allowedCfgFiles unchanged
)
```

Update `ContainerName`:

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

The image tag is `:latest` not `:<sha>` because Docker tags inside the daemon are independent of the immutable build SHA — we re-tag the SHA-built image to `:latest` at deploy time so the bridge can stay simple.

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd apps/bridge && go test -race -count=1 ./internal/validate/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/internal/validate/docker.go apps/bridge/internal/validate/docker_test.go
git commit -m "feat(bridge): allowlist rnsquadjs sidecar image + container name"
```

---

## Task 3: panelBridge package skeleton

**Files:**
- Create: `docker/rnsquadjs/plugins/panelBridge/package.json`
- Create: `docker/rnsquadjs/plugins/panelBridge/tsconfig.json`
- Create: `docker/rnsquadjs/plugins/panelBridge/src/index.ts`
- Create: `docker/rnsquadjs/plugins/panelBridge/vitest.config.ts`

- [ ] **Step 1: Write the manifest**

`docker/rnsquadjs/plugins/panelBridge/package.json`:

```json
{
  "name": "panel-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "ioredis": "^5.4.1",
    "uuid": "^14.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "typescript": "^5.7.2",
    "vitest": "^3.2.4"
  }
}
```

`docker/rnsquadjs/plugins/panelBridge/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`docker/rnsquadjs/plugins/panelBridge/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
```

`docker/rnsquadjs/plugins/panelBridge/src/index.ts`:

```ts
export const PANEL_BRIDGE_VERSION = '0.1.0';
```

- [ ] **Step 2: Install deps and confirm typecheck**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npm install && npx tsc -p tsconfig.json --noEmit
```

Expected: no output, exit 0. (Using `npm` instead of `pnpm` here keeps this package out of the monorepo workspace — it ships into the Docker image, not the panel runtime.)

- [ ] **Step 3: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}
git commit -m "feat(rnsquadjs): scaffold panelBridge plugin package"
```

---

## Task 4: Event mapper — single canonical event (TDD entry)

**Files:**
- Create: `docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts`
- Create: `docker/rnsquadjs/plugins/panelBridge/test/eventMap.test.ts`

- [ ] **Step 1: Write the failing test**

`docker/rnsquadjs/plugins/panelBridge/test/eventMap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapEvent } from '../src/eventMap.js';

describe('mapEvent', () => {
  it('maps PLAYER_CONNECTED to a panel EventEnvelope', () => {
    const envelope = mapEvent('019dbaa5-1234-7abc-8def-0123456789ab', 'PLAYER_CONNECTED', {
      steamID: '76561198000000001',
      eosID: '0002eos00000000000000000000000a1',
      name: 'Sergei',
      time: '2026-04-24T10:00:00.000Z',
    });
    expect(envelope).toMatchObject({
      serverId: '019dbaa5-1234-7abc-8def-0123456789ab',
      type: 'player.connected',
      version: 1,
      payload: { steamId: '76561198000000001', eosId: '0002eos00000000000000000000000a1', name: 'Sergei' },
    });
    expect(envelope.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(envelope.ts).toBe('2026-04-24T10:00:00.000Z');
  });

  it('returns null for unknown RNSquadJS event types', () => {
    expect(mapEvent('019dbaa5-1234-7abc-8def-0123456789ab', 'UNKNOWN_THING', {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/eventMap.test.ts
```

Expected: FAIL — `mapEvent` not defined.

- [ ] **Step 3: Implement minimal `mapEvent`**

`docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts`:

```ts
import { v7 as uuidv7 } from 'uuid';

export interface EventEnvelope {
  id: string;
  serverId: string;
  type: string;
  version: number;
  ts: string;
  payload: Record<string, unknown>;
}

type Mapper = (raw: any) => { type: string; payload: Record<string, unknown> } | null;

const MAPPERS: Record<string, Mapper> = {
  PLAYER_CONNECTED: (raw) => ({
    type: 'player.connected',
    payload: { steamId: raw.steamID, eosId: raw.eosID, name: raw.name },
  }),
};

export function mapEvent(serverId: string, rnType: string, raw: any): EventEnvelope | null {
  const mapper = MAPPERS[rnType];
  if (!mapper) return null;
  const mapped = mapper(raw);
  if (!mapped) return null;
  return {
    id: uuidv7(),
    serverId,
    type: mapped.type,
    version: 1,
    ts: typeof raw?.time === 'string' ? raw.time : new Date().toISOString(),
    payload: mapped.payload,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/eventMap.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts docker/rnsquadjs/plugins/panelBridge/test/eventMap.test.ts
git commit -m "feat(panelBridge): map PLAYER_CONNECTED to EventEnvelope"
```

---

## Task 5: Event mapper — full event coverage

**Files:**
- Modify: `docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts`
- Modify: `docker/rnsquadjs/plugins/panelBridge/test/eventMap.test.ts`

- [ ] **Step 1: Add a parametrised test for every event we care about**

Append to `test/eventMap.test.ts`:

```ts
const CASES: Array<[string, any, string, Record<string, unknown>]> = [
  ['PLAYER_DISCONNECTED', { steamID: 'A', eosID: 'B', name: 'X', time: '2026-04-24T10:00:00.000Z' }, 'player.disconnected', { steamId: 'A', eosId: 'B', name: 'X' }],
  ['PLAYER_DAMAGED', { attacker: 'A', victim: 'V', weapon: 'M4A1', damage: 32, time: '2026-04-24T10:00:00.000Z' }, 'player.damaged', { attacker: 'A', victim: 'V', weapon: 'M4A1', damage: 32 }],
  ['PLAYER_DIED', { attacker: 'A', victim: 'V', weapon: 'M4A1', time: '2026-04-24T10:00:00.000Z' }, 'player.died', { attacker: 'A', victim: 'V', weapon: 'M4A1' }],
  ['PLAYER_WOUNDED', { attacker: 'A', victim: 'V', weapon: 'M4A1', time: '2026-04-24T10:00:00.000Z' }, 'player.wounded', { attacker: 'A', victim: 'V', weapon: 'M4A1' }],
  ['PLAYER_REVIVED', { reviver: 'R', revived: 'V', time: '2026-04-24T10:00:00.000Z' }, 'player.revived', { reviver: 'R', revived: 'V' }],
  ['PLAYER_POSSESS', { player: 'P', possessClassname: 'BP_Soldier_C', time: '2026-04-24T10:00:00.000Z' }, 'player.possess', { player: 'P', vehicle: 'BP_Soldier_C' }],
  ['PLAYER_UNPOSSESS', { player: 'P', possessClassname: 'BP_Soldier_C', time: '2026-04-24T10:00:00.000Z' }, 'player.unpossess', { player: 'P', vehicle: 'BP_Soldier_C' }],
  ['NEW_GAME', { layer: 'Yehorivka_RAAS_v1', time: '2026-04-24T10:00:00.000Z' }, 'match.started', { layer: 'Yehorivka_RAAS_v1' }],
  ['ROUND_ENDED', { winner: 'Team1', layer: 'Yehorivka_RAAS_v1', time: '2026-04-24T10:00:00.000Z' }, 'match.ended', { winner: 'Team1', layer: 'Yehorivka_RAAS_v1' }],
  ['SQUAD_CREATED', { player: 'P', squadID: 3, squadName: 'Alpha', team: 1, time: '2026-04-24T10:00:00.000Z' }, 'squad.created', { player: 'P', squadId: 3, squadName: 'Alpha', team: 1 }],
  ['DEPLOYABLE_DAMAGED', { deployable: 'BP_FOB_Radio_C', damage: 100, attacker: 'A', time: '2026-04-24T10:00:00.000Z' }, 'deployable.damaged', { deployable: 'BP_FOB_Radio_C', damage: 100, attacker: 'A' }],
  ['TICK_RATE', { tickRate: 39.2, time: '2026-04-24T10:00:00.000Z' }, 'server.tick_rate', { tickRate: 39.2 }],
  ['ADMIN_BROADCAST', { message: 'gg', time: '2026-04-24T10:00:00.000Z' }, 'admin.broadcast', { message: 'gg' }],
  ['CHAT_MESSAGE', { chat: 'ChatAll', name: 'Sergei', message: 'hi', steamID: 'A', time: '2026-04-24T10:00:00.000Z' }, 'chat.message', { channel: 'ChatAll', steamId: 'A', name: 'Sergei', message: 'hi' }],
  ['POSSESSED_ADMIN_CAMERA', { player: 'P', time: '2026-04-24T10:00:00.000Z' }, 'admin.camera_entered', { player: 'P' }],
  ['UNPOSSESSED_ADMIN_CAMERA', { player: 'P', time: '2026-04-24T10:00:00.000Z' }, 'admin.camera_left', { player: 'P' }],
];

it.each(CASES)('maps %s', (rnType, raw, expectedType, expectedPayload) => {
  const env = mapEvent('019dbaa5-1234-7abc-8def-0123456789ab', rnType, raw);
  expect(env).not.toBeNull();
  expect(env!.type).toBe(expectedType);
  expect(env!.payload).toEqual(expectedPayload);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/eventMap.test.ts
```

Expected: 16 failures (only `PLAYER_CONNECTED` mapper exists).

- [ ] **Step 3: Add all mappers**

Replace the `MAPPERS` object in `src/eventMap.ts` with:

```ts
const MAPPERS: Record<string, Mapper> = {
  PLAYER_CONNECTED:    (r) => ({ type: 'player.connected',    payload: { steamId: r.steamID, eosId: r.eosID, name: r.name } }),
  PLAYER_DISCONNECTED: (r) => ({ type: 'player.disconnected', payload: { steamId: r.steamID, eosId: r.eosID, name: r.name } }),
  PLAYER_DAMAGED:      (r) => ({ type: 'player.damaged',      payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon, damage: r.damage } }),
  PLAYER_DIED:         (r) => ({ type: 'player.died',         payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon } }),
  PLAYER_WOUNDED:      (r) => ({ type: 'player.wounded',      payload: { attacker: r.attacker, victim: r.victim, weapon: r.weapon } }),
  PLAYER_REVIVED:      (r) => ({ type: 'player.revived',      payload: { reviver: r.reviver, revived: r.revived } }),
  PLAYER_POSSESS:      (r) => ({ type: 'player.possess',      payload: { player: r.player, vehicle: r.possessClassname } }),
  PLAYER_UNPOSSESS:    (r) => ({ type: 'player.unpossess',    payload: { player: r.player, vehicle: r.possessClassname } }),
  NEW_GAME:            (r) => ({ type: 'match.started',       payload: { layer: r.layer } }),
  ROUND_ENDED:         (r) => ({ type: 'match.ended',         payload: { winner: r.winner, layer: r.layer } }),
  SQUAD_CREATED:       (r) => ({ type: 'squad.created',       payload: { player: r.player, squadId: r.squadID, squadName: r.squadName, team: r.team } }),
  DEPLOYABLE_DAMAGED:  (r) => ({ type: 'deployable.damaged',  payload: { deployable: r.deployable, damage: r.damage, attacker: r.attacker } }),
  TICK_RATE:           (r) => ({ type: 'server.tick_rate',    payload: { tickRate: r.tickRate } }),
  ADMIN_BROADCAST:     (r) => ({ type: 'admin.broadcast',     payload: { message: r.message } }),
  CHAT_MESSAGE:        (r) => ({ type: 'chat.message',        payload: { channel: r.chat, steamId: r.steamID, name: r.name, message: r.message } }),
  POSSESSED_ADMIN_CAMERA:   (r) => ({ type: 'admin.camera_entered', payload: { player: r.player } }),
  UNPOSSESSED_ADMIN_CAMERA: (r) => ({ type: 'admin.camera_left',    payload: { player: r.player } }),
};
```

- [ ] **Step 4: Run test to verify all pass**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/eventMap.test.ts
```

Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts docker/rnsquadjs/plugins/panelBridge/test/eventMap.test.ts
git commit -m "feat(panelBridge): map full RNSquadJS event surface to EventEnvelope"
```

---

## Task 6: Redis publisher with shadow/production mode

**Files:**
- Create: `docker/rnsquadjs/plugins/panelBridge/src/redisPublisher.ts`
- Create: `docker/rnsquadjs/plugins/panelBridge/test/redisPublisher.test.ts`

- [ ] **Step 1: Write the failing test using a fake ioredis client**

`docker/rnsquadjs/plugins/panelBridge/test/redisPublisher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { RedisPublisher } from '../src/redisPublisher.js';

const fakeRedis = () => {
  const calls: { cmd: string; args: any[] }[] = [];
  return {
    calls,
    xadd: vi.fn(async (...args: any[]) => { calls.push({ cmd: 'xadd', args }); return '0-1'; }),
    set:  vi.fn(async (...args: any[]) => { calls.push({ cmd: 'set',  args }); return 'OK'; }),
  };
};

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
const ENVELOPE = { id: 'evt', serverId: SERVER_ID, type: 'player.connected', version: 1, ts: '2026-04-24T10:00:00.000Z', payload: { steamId: 'A' } };

describe('RedisPublisher (production mode)', () => {
  it('XADDs to events:server:{id} and SETs rcon:status:{id}', async () => {
    const r = fakeRedis();
    const pub = new RedisPublisher(r as any, SERVER_ID, 'production');
    await pub.publishEvent(ENVELOPE);
    await pub.publishRconStatus({ state: 'connected', lastChange: '2026-04-24T10:00:00.000Z' });
    expect(r.calls[0]).toEqual({ cmd: 'xadd', args: [`events:server:${SERVER_ID}`, '*', 'envelope', JSON.stringify(ENVELOPE)] });
    expect(r.calls[1].cmd).toBe('set');
    expect(r.calls[1].args[0]).toBe(`rcon:status:${SERVER_ID}`);
    expect(r.calls[1].args[2]).toBe('EX');
    expect(r.calls[1].args[3]).toBe(300);
  });
});

describe('RedisPublisher (shadow mode)', () => {
  it('writes to :shadow-suffixed keys instead', async () => {
    const r = fakeRedis();
    const pub = new RedisPublisher(r as any, SERVER_ID, 'shadow');
    await pub.publishEvent(ENVELOPE);
    await pub.publishRconStatus({ state: 'connected', lastChange: '2026-04-24T10:00:00.000Z' });
    expect(r.calls[0].args[0]).toBe(`events:server:${SERVER_ID}:shadow`);
    expect(r.calls[1].args[0]).toBe(`rcon:status:${SERVER_ID}:shadow`);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/redisPublisher.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RedisPublisher`**

`docker/rnsquadjs/plugins/panelBridge/src/redisPublisher.ts`:

```ts
import type Redis from 'ioredis';
import type { EventEnvelope } from './eventMap.js';

export type Mode = 'production' | 'shadow';
export interface RconStatus { state: 'connected' | 'disconnected'; lastChange: string }

export class RedisPublisher {
  constructor(private readonly redis: Redis, private readonly serverId: string, private readonly mode: Mode) {}

  private suffix(): string { return this.mode === 'shadow' ? ':shadow' : ''; }
  private eventStream(): string { return `events:server:${this.serverId}${this.suffix()}`; }
  private statusKey(): string  { return `rcon:status:${this.serverId}${this.suffix()}`; }

  async publishEvent(envelope: EventEnvelope): Promise<void> {
    await this.redis.xadd(this.eventStream(), '*', 'envelope', JSON.stringify(envelope));
  }

  async publishRconStatus(status: RconStatus): Promise<void> {
    await this.redis.set(this.statusKey(), JSON.stringify(status), 'EX', 300);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/redisPublisher.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/src/redisPublisher.ts docker/rnsquadjs/plugins/panelBridge/test/redisPublisher.test.ts
git commit -m "feat(panelBridge): redis publisher with shadow/production routing"
```

---

## Task 7: RCON Unix-socket server

**Files:**
- Create: `docker/rnsquadjs/plugins/panelBridge/src/rconUnixServer.ts`
- Create: `docker/rnsquadjs/plugins/panelBridge/test/rconUnixServer.test.ts`

- [ ] **Step 1: Write the failing test**

`docker/rnsquadjs/plugins/panelBridge/test/rconUnixServer.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { RconUnixServer } from '../src/rconUnixServer.js';

const tmp = mkdtempSync(join(tmpdir(), 'panelbridge-'));
const sock = join(tmp, 'rcon.sock');

describe('RconUnixServer', () => {
  let server: RconUnixServer;
  afterEach(async () => { await server?.close(); });

  it('forwards POST /rcon to the executor and returns its response', async () => {
    const exec = vi.fn(async (method: string, args: any) => `OK:${method}:${JSON.stringify(args)}`);
    server = new RconUnixServer(sock, exec as any);
    await server.listen();

    const res = await request(`http://localhost/rcon`, {
      method: 'POST',
      dispatcher: new (await import('undici')).Agent({ connect: { socketPath: sock } }) as any,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'AdminBroadcast', args: ['gg'] }),
    });
    expect(res.statusCode).toBe(200);
    const body = await res.body.json() as any;
    expect(body).toEqual({ ok: true, response: 'OK:AdminBroadcast:["gg"]' });
    expect(exec).toHaveBeenCalledWith('AdminBroadcast', ['gg']);
  });

  it('returns 400 on missing method', async () => {
    server = new RconUnixServer(sock, vi.fn() as any);
    await server.listen();
    const res = await request(`http://localhost/rcon`, {
      method: 'POST',
      dispatcher: new (await import('undici')).Agent({ connect: { socketPath: sock } }) as any,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['gg'] }),
    });
    expect(res.statusCode).toBe(400);
  });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));
```

Add `undici` to devDependencies first:

```bash
cd docker/rnsquadjs/plugins/panelBridge && npm install --save-dev undici
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/rconUnixServer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RconUnixServer`**

`docker/rnsquadjs/plugins/panelBridge/src/rconUnixServer.ts`:

```ts
import { createServer, Server } from 'node:http';
import { unlink } from 'node:fs/promises';

export type RconExecutor = (method: string, args: unknown[]) => Promise<string>;

export class RconUnixServer {
  private server?: Server;
  constructor(private readonly socketPath: string, private readonly exec: RconExecutor) {}

  async listen(): Promise<void> {
    await unlink(this.socketPath).catch(() => {});
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/rcon') {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof body?.method !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'missing method' }));
            return;
          }
          const response = await this.exec(body.method, Array.isArray(body.args) ? body.args : []);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, response }));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await unlink(this.socketPath).catch(() => {});
  }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/rconUnixServer.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/{src/rconUnixServer.ts,test/rconUnixServer.test.ts,package.json,package-lock.json}
git commit -m "feat(panelBridge): per-server unix-socket rcon executor"
```

---

## Task 8: Heartbeat ticker

**Files:**
- Create: `docker/rnsquadjs/plugins/panelBridge/src/heartbeat.ts`

- [ ] **Step 1: Add heartbeat assertion to redisPublisher tests**

Append to `test/redisPublisher.test.ts`:

```ts
import { Heartbeat } from '../src/heartbeat.js';
describe('Heartbeat', () => {
  it('SETs worker:heartbeat:rnsquadjs:{id} every interval', async () => {
    vi.useFakeTimers();
    const r = fakeRedis();
    const hb = new Heartbeat(r as any, SERVER_ID, 1000);
    hb.start();
    await vi.advanceTimersByTimeAsync(2500);
    hb.stop();
    expect(r.set).toHaveBeenCalledTimes(3); // immediate + 2 ticks
    expect(r.calls[0].args[0]).toBe(`worker:heartbeat:rnsquadjs:${SERVER_ID}`);
    expect(r.calls[0].args[2]).toBe('EX');
    expect(r.calls[0].args[3]).toBe(30);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/redisPublisher.test.ts
```

Expected: FAIL — `Heartbeat` not found.

- [ ] **Step 3: Implement `Heartbeat`**

`docker/rnsquadjs/plugins/panelBridge/src/heartbeat.ts`:

```ts
import type Redis from 'ioredis';

export class Heartbeat {
  private timer?: NodeJS.Timeout;
  constructor(private readonly redis: Redis, private readonly serverId: string, private readonly intervalMs = 10_000) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private async tick(): Promise<void> {
    await this.redis.set(`worker:heartbeat:rnsquadjs:${this.serverId}`, new Date().toISOString(), 'EX', 30);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run test/redisPublisher.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/src/heartbeat.ts docker/rnsquadjs/plugins/panelBridge/test/redisPublisher.test.ts
git commit -m "feat(panelBridge): periodic worker heartbeat"
```

---

## Task 9: panelBridge plugin entry — wire mapper + publisher + sockets + heartbeat

**Files:**
- Modify: `docker/rnsquadjs/plugins/panelBridge/src/index.ts`

- [ ] **Step 1: Replace skeleton with the plugin entry**

Replace `docker/rnsquadjs/plugins/panelBridge/src/index.ts` with:

```ts
import IORedis from 'ioredis';
import type { EventEmitter } from 'node:events';
import { mapEvent } from './eventMap.js';
import { RedisPublisher, type Mode } from './redisPublisher.js';
import { RconUnixServer } from './rconUnixServer.js';
import { Heartbeat } from './heartbeat.js';

export interface PanelBridgeContext {
  serverId: string;
  emitter: EventEmitter;
  rconExec: (method: string, args: unknown[]) => Promise<string>;
  onStatus: (cb: (s: 'connected' | 'disconnected') => void) => void;
}

const RN_EVENTS = [
  'PLAYER_CONNECTED','PLAYER_DISCONNECTED','PLAYER_DAMAGED','PLAYER_DIED','PLAYER_WOUNDED',
  'PLAYER_REVIVED','PLAYER_POSSESS','PLAYER_UNPOSSESS','NEW_GAME','ROUND_ENDED',
  'SQUAD_CREATED','DEPLOYABLE_DAMAGED','TICK_RATE','ADMIN_BROADCAST','CHAT_MESSAGE',
  'POSSESSED_ADMIN_CAMERA','UNPOSSESSED_ADMIN_CAMERA',
] as const;

export async function startPanelBridge(ctx: PanelBridgeContext): Promise<{ stop: () => Promise<void> }> {
  const mode = (process.env.PANEL_BRIDGE_MODE === 'shadow' ? 'shadow' : 'production') as Mode;
  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379');
  const publisher = new RedisPublisher(redis, ctx.serverId, mode);
  const heartbeat = new Heartbeat(redis, ctx.serverId);

  for (const evt of RN_EVENTS) {
    ctx.emitter.on(evt, async (raw: any) => {
      const env = mapEvent(ctx.serverId, evt, raw);
      if (env) await publisher.publishEvent(env).catch((e) => console.error('panelBridge publishEvent', e));
    });
  }

  ctx.onStatus((state) => {
    publisher.publishRconStatus({ state, lastChange: new Date().toISOString() }).catch((e) => console.error('panelBridge publishRconStatus', e));
  });

  let rconServer: RconUnixServer | undefined;
  if (mode === 'production') {
    rconServer = new RconUnixServer(process.env.PANEL_BRIDGE_SOCKET ?? '/run/panelBridge/rcon.sock', ctx.rconExec);
    await rconServer.listen();
  }

  heartbeat.start();
  return {
    stop: async () => {
      heartbeat.stop();
      await rconServer?.close();
      await redis.quit();
    },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx tsc -p tsconfig.json --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Run all panelBridge tests**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run
```

Expected: all green (5 tests across 2 files).

- [ ] **Step 4: Commit**

```bash
git add docker/rnsquadjs/plugins/panelBridge/src/index.ts
git commit -m "feat(panelBridge): plugin entry wiring mapper + publisher + rcon socket + heartbeat"
```

---

## Task 10: Sidecar Dockerfile + entrypoint

**Files:**
- Create: `docker/rnsquadjs.Dockerfile`
- Create: `docker/rnsquadjs/entrypoint.sh`

- [ ] **Step 1: Write the Dockerfile**

`docker/rnsquadjs.Dockerfile`:

```dockerfile
ARG RNSQUADJS_REPO=https://github.com/lACTEPUKCl/RNSquadJS.git
ARG RNSQUADJS_SHA

FROM node:18.18-bookworm-slim AS upstream
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ARG RNSQUADJS_REPO
ARG RNSQUADJS_SHA
RUN git clone "$RNSQUADJS_REPO" . && git checkout "$RNSQUADJS_SHA"
RUN corepack enable && yarn install --frozen-lockfile

FROM node:18.18-bookworm-slim AS plugin
WORKDIR /plugin
COPY docker/rnsquadjs/plugins/panelBridge/package.json docker/rnsquadjs/plugins/panelBridge/tsconfig.json ./
COPY docker/rnsquadjs/plugins/panelBridge/src ./src
RUN npm install --omit=dev && npx tsc -p tsconfig.json

FROM node:18.18-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=upstream /src /app
COPY --from=plugin   /plugin/dist /app/lib/plugins/panelBridge
COPY --from=plugin   /plugin/node_modules/ioredis /app/node_modules/ioredis
COPY --from=plugin   /plugin/node_modules/uuid    /app/node_modules/uuid
COPY docker/rnsquadjs/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER 1001:1001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 2: Write the entrypoint**

`docker/rnsquadjs/entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${SERVER_ID:?SERVER_ID is required}"
: "${API_URL:?API_URL is required}"
: "${LOG_FILE:=/squad/Logs/SquadGame.log}"

curl --silent --fail --retry 10 --retry-delay 3 --max-time 5 \
  "${API_URL}/internal/rnsquadjs/config/${SERVER_ID}" -o /app/config.json

deadline=$(( $(date +%s) + 60 ))
until [ -f "${LOG_FILE}" ]; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "panelBridge: timed out waiting for ${LOG_FILE}" >&2
    exit 1
  fi
  sleep 1
done

exec node lib/index.js
```

- [ ] **Step 3: Build the image with a placeholder SHA to verify the Dockerfile compiles**

Pick the current `master` HEAD SHA from `https://github.com/lACTEPUKCl/RNSquadJS/commits/master` and export it as `RN_SHA`:

```bash
docker build \
  --build-arg RNSQUADJS_SHA="${RN_SHA}" \
  -f docker/rnsquadjs.Dockerfile \
  -t squad-panel/rnsquadjs:latest \
  .
```

Expected: image builds, final tag created. If `yarn install` of upstream fails on a dep that needs build tools (e.g. `mariadb`), add `python3 make g++` to the `upstream` stage's apt install — this is the only acceptable Dockerfile drift.

- [ ] **Step 4: Smoke-test the entrypoint with a fake API**

```bash
docker run --rm \
  -e SERVER_ID=019dbaa5-1234-7abc-8def-0123456789ab \
  -e API_URL=http://does-not-exist:0 \
  squad-panel/rnsquadjs:latest 2>&1 | head -5
```

Expected: curl retries 10 times then exits with non-zero. The point is to confirm the entrypoint runs and dies cleanly when the API is unreachable.

- [ ] **Step 5: Commit**

```bash
git add docker/rnsquadjs.Dockerfile docker/rnsquadjs/entrypoint.sh
git commit -m "feat(rnsquadjs): sidecar dockerfile + entrypoint with config-fetch + log-wait"
```

---

## Task 11: `is_canary` migration

**Files:**
- Modify: `packages/db/src/schema/servers.ts`
- Create: `packages/db/drizzle/0008_servers_is_canary.sql`

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/db/src/schema/servers.ts`, locate the `servers = pgTable(...)` definition. Add:

```ts
isCanary: boolean('is_canary').notNull().default(false),
```

(adjust import — `boolean` from `drizzle-orm/pg-core`).

- [ ] **Step 2: Generate the migration**

```bash
pnpm db:generate
```

Expected: a new file like `packages/db/drizzle/0008_<auto>.sql`. Rename it to `0008_servers_is_canary.sql`.

- [ ] **Step 3: Inspect the SQL**

`packages/db/drizzle/0008_servers_is_canary.sql` should contain:

```sql
ALTER TABLE "servers" ADD COLUMN "is_canary" boolean DEFAULT false NOT NULL;
```

If anything else is in the file, edit it down to this single statement.

- [ ] **Step 4: Apply migration locally**

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
psql "postgres://admin:$PASS@127.0.0.1:5432/admin" -c "\d+ servers" | grep is_canary
```

Expected: `is_canary | boolean | not null default false`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/servers.ts packages/db/drizzle/0008_servers_is_canary.sql
git commit -m "feat(db): is_canary flag on servers"
```

---

## Task 12: `/internal/rnsquadjs/config/:id` endpoint

**Files:**
- Create: `apps/api/src/routes/internal/rnsquadjs-config.ts`
- Create: `apps/api/test/internal-rnsquadjs-config.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/internal-rnsquadjs-config.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp, seedServer } from './integration/harness.js';

let app: TestApp;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

describe('GET /internal/rnsquadjs/config/:id', () => {
  it('rejects non-loopback callers with 403', async () => {
    const { id } = await seedServer(app);
    const res = await app.fastify.inject({
      method: 'GET',
      url: `/internal/rnsquadjs/config/${id}`,
      remoteAddress: '10.0.0.5',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the rendered RNSquadJS config from loopback', async () => {
    const { id, rconPort, rconPassword } = await seedServer(app);
    const res = await app.fastify.inject({
      method: 'GET',
      url: `/internal/rnsquadjs/config/${id}`,
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      [id]: {
        host: '127.0.0.1',
        port: rconPort,
        password: rconPassword,
        logFilePath: '/squad/Logs/SquadGame.log',
        plugins: { panelBridge: { enabled: true } },
      },
    });
    expect(body[id].plugins.autoUpdateMods.enabled).toBe(false);
  });

  it('404 on unknown server', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/internal/rnsquadjs/config/019dbaa5-0000-7000-8000-000000000000',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(404);
  });
});
```

The test relies on existing `apps/api/test/integration/harness.ts`. If `seedServer` is not exported there, add it as a thin helper that inserts a row with `rconPort` and reads back the password from `Rcon.cfg`.

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @squad/api exec vitest run test/internal-rnsquadjs-config.test.ts
```

Expected: FAIL — route not registered.

- [ ] **Step 3: Implement the route**

`apps/api/src/routes/internal/rnsquadjs-config.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const RN_PLUGINS_DISABLED = ['autoUpdateMods', 'chatCommands', 'voteMap', 'warnings', 'broadcasts', 'autoKick', 'squadLeader'];

export const internalRnsquadjsConfigRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send({ error: 'forbidden' });
  });

  app.get('/internal/rnsquadjs/config/:id', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const server = await app.db.query.servers.findFirst({ where: (s, { eq }) => eq(s.id, id) });
    if (!server) return reply.code(404).send({ error: 'not_found' });

    const rcon = await app.bridge.fileRead({ path: `/var/lib/squad-panel/configs/${id}/ServerConfig/Rcon.cfg` });
    const password = (rcon.match(/^Password=(.+)$/m)?.[1] ?? '').trim();

    const cfg: Record<string, unknown> = {
      [id]: {
        id,
        host: '127.0.0.1',
        port: server.rconPort,
        password,
        logFilePath: '/squad/Logs/SquadGame.log',
        adminsFilePath: `/squad/SquadGame/ServerConfig/Admins.cfg`,
        mapsName: 'vanilla.json',
        mapsRegExp: '',
        plugins: {
          panelBridge: { enabled: true },
          ...Object.fromEntries(RN_PLUGINS_DISABLED.map((name) => [name, { enabled: false }])),
        },
      },
    };
    return cfg;
  });
};

export default internalRnsquadjsConfigRoutes;
```

Register in `apps/api/src/server.ts` near the other route imports/registrations:

```ts
import internalRnsquadjsConfigRoutes from './routes/internal/rnsquadjs-config.js';
// ...
await app.register(internalRnsquadjsConfigRoutes);
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @squad/api exec vitest run test/internal-rnsquadjs-config.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/internal/rnsquadjs-config.ts apps/api/src/server.ts apps/api/test/internal-rnsquadjs-config.test.ts
git commit -m "feat(api): loopback-guarded /internal/rnsquadjs/config/:id"
```

---

## Task 13: `app.rcon.exec` Unix-socket client

**Files:**
- Create: `apps/api/src/lib/rcon.ts`
- Create: `apps/api/test/lib/rcon.test.ts`

- [ ] **Step 1: Write the failing test (uses a real ephemeral Unix socket)**

`apps/api/test/lib/rcon.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';
import { createRconClient } from '../../src/lib/rcon.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
let tmp: string;
let socketPath: string;
let server: Server | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rcon-'));
  socketPath = join(tmp, `${SERVER_ID}.sock`);
});
afterEach(async () => {
  await new Promise<void>((r) => server ? server.close(() => r()) : r());
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

describe('rcon.exec', () => {
  it('POSTs to the per-server socket and returns the response', async () => {
    server = createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, response: 'pong:' + buf })));
    });
    await new Promise<void>((r) => server!.listen(socketPath, r));

    const rcon = createRconClient({ socketDir: tmp });
    const resp = await rcon.exec(SERVER_ID, 'AdminBroadcast', ['gg']);
    expect(resp).toBe('pong:{"method":"AdminBroadcast","args":["gg"]}');
  });

  it('retries on ECONNREFUSED for up to retryMs', async () => {
    const rcon = createRconClient({ socketDir: tmp, retryMs: 1500 });
    const startedAt = Date.now();
    const promise = rcon.exec(SERVER_ID, 'AdminBroadcast', ['gg']);

    setTimeout(async () => {
      server = createServer((req, res) => {
        let buf = '';
        req.on('data', (c) => (buf += c));
        req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, response: 'late' })));
      });
      await new Promise<void>((r) => server!.listen(socketPath, r));
    }, 600);

    expect(await promise).toBe('late');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
  });

  it('throws when the sidecar returns ok:false', async () => {
    server = createServer((_req, res) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'rcon not connected' })));
    await new Promise<void>((r) => server!.listen(socketPath, r));
    const rcon = createRconClient({ socketDir: tmp });
    await expect(rcon.exec(SERVER_ID, 'AdminBroadcast', ['gg'])).rejects.toThrow(/rcon not connected/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @squad/api exec vitest run test/lib/rcon.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `createRconClient`**

`apps/api/src/lib/rcon.ts`:

```ts
import { request, Agent } from 'undici';
import { join } from 'node:path';

export interface RconClient {
  exec(serverId: string, method: string, args: unknown[]): Promise<string>;
}

export interface RconClientOptions {
  socketDir?: string;
  retryMs?: number;
}

export function createRconClient(opts: RconClientOptions = {}): RconClient {
  const socketDir = opts.socketDir ?? '/run/squad-panel/rnsquadjs';
  const retryMs   = opts.retryMs ?? 5_000;

  return {
    async exec(serverId, method, args) {
      const socketPath = join(socketDir, `${serverId}.sock`);
      const dispatcher = new Agent({ connect: { socketPath } });
      const deadline = Date.now() + retryMs;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try {
          const res = await request(`http://localhost/rcon`, {
            method: 'POST',
            dispatcher,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, args }),
          });
          const body = await res.body.json() as { ok: boolean; response?: string; error?: string };
          if (!body.ok) throw new Error(body.error ?? `rcon failed (${res.statusCode})`);
          return body.response ?? '';
        } catch (err: any) {
          if (err?.code !== 'ECONNREFUSED' && err?.code !== 'ENOENT') throw err;
          lastErr = err;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      throw lastErr ?? new Error('rcon timeout');
    },
  };
}
```

- [ ] **Step 4: Verify pass**

```bash
pnpm --filter @squad/api exec vitest run test/lib/rcon.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/rcon.ts apps/api/test/lib/rcon.test.ts
git commit -m "feat(api): rcon.exec via per-server unix socket with retry"
```

---

## Task 14: Bridge RPC `container_run_rnsquadjs` — Go side

**Files:**
- Modify: `apps/bridge/internal/validate/paths.go` (add `PanelSocketRoot`)
- Modify: `apps/bridge/internal/validate/paths_test.go`
- Modify: `apps/bridge/internal/runner/docker.go` (new `RunRNSquadJS` method composing the docker CLI args)
- Modify: `apps/bridge/internal/runner/docker_test.go`
- Modify: `apps/bridge/internal/handlers/handlers.go` (dispatch new method)

The existing `container_run` hardcodes squad-server's three binds (configs/saved/depot). Sidecars need a different shape, so per CLAUDE.md ("Client passes structured params, never raw flags") we add a separate, narrowly-scoped RPC method.

- [ ] **Step 1: Write failing tests for the new path constant + runner**

Append to `apps/bridge/internal/validate/paths_test.go`:

```go
func TestPanelSocketPath_AllowsRnsquadjsSocketDir(t *testing.T) {
	if _, err := PanelSocketPath("/run/squad-panel/rnsquadjs"); err != nil {
		t.Fatalf("expected sockets root allowed: %v", err)
	}
}

func TestPanelSocketPath_RejectsEscape(t *testing.T) {
	if _, err := PanelSocketPath("/run/squad-panel/rnsquadjs/../../etc"); err == nil {
		t.Fatal("expected rejection for escape")
	}
}
```

Append to `apps/bridge/internal/runner/docker_test.go`:

```go
func TestRunRNSquadJS_ComposesExpectedDockerArgs(t *testing.T) {
	d := &Dispatcher{Cmd: &fakeCmd{}, Docker: nil} // see existing fake test setup
	id := "019dbaa5-1234-7abc-8def-0123456789ab"
	args, err := d.composeRNSquadJSArgs(RNSquadJSRunSpec{
		ServerID: id,
		Env:      map[string]string{"SERVER_ID": id, "API_URL": "http://api:3000"},
	})
	if err != nil { t.Fatal(err) }
	want := []string{
		"run", "-d",
		"--name", "rnsquadjs-" + id,
		"--label", "panel.kind=rnsquadjs",
		"--network", "host",
		"--user", "1001:1001",
		"--read-only",
		"--restart", "unless-stopped",
		"-v", "/var/lib/squad-panel/saved/" + id + "/SquadGame/Saved/Logs:/squad/Logs:ro",
		"-v", "/run/squad-panel/rnsquadjs:/run/panelBridge:rw",
		"-e", "SERVER_ID=" + id,
		"-e", "API_URL=http://api:3000",
		"squad-panel/rnsquadjs:latest",
	}
	if !reflect.DeepEqual(args, want) { t.Fatalf("got %v, want %v", args, want) }
}

func TestRunRNSquadJS_RejectsBadServerID(t *testing.T) {
	d := &Dispatcher{}
	_, err := d.composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: "../etc"})
	if err == nil { t.Fatal("expected rejection") }
}
```

(If the existing test file does not have a `fakeCmd` or `Dispatcher` constructor, follow the same pattern used by the existing `containerRun` tests in the same file.)

- [ ] **Step 2: Run tests to verify failures**

```bash
cd apps/bridge && go test -run "PanelSocketPath|RunRNSquadJS" ./...
```

Expected: FAIL — symbols undefined.

- [ ] **Step 3: Add `PanelSocketRoot` and `PanelSocketPath`**

In `apps/bridge/internal/validate/paths.go` (alongside `PanelSavedPath`):

```go
const PanelSocketRoot = "/run/squad-panel/rnsquadjs"

func PanelSocketPath(p string) (string, error) {
	clean := filepath.Clean(p)
	if clean != PanelSocketRoot && !strings.HasPrefix(clean, PanelSocketRoot+"/") {
		return "", fmt.Errorf("%w: path %q not in socket root", ErrForbidden, p)
	}
	return clean, nil
}
```

- [ ] **Step 4: Add `composeRNSquadJSArgs` + `RunRNSquadJS`**

In `apps/bridge/internal/runner/docker.go`:

```go
type RNSquadJSRunSpec struct {
	ServerID string            `json:"serverId"`
	Env      map[string]string `json:"env"`
}

func (d *Dispatcher) composeRNSquadJSArgs(spec RNSquadJSRunSpec) ([]string, error) {
	if err := validate.ServerUUID(spec.ServerID); err != nil { return nil, err }
	name := "rnsquadjs-" + spec.ServerID
	if err := validate.ContainerName(name); err != nil { return nil, err }
	logsBind   := fmt.Sprintf("%s/%s/SquadGame/Saved/Logs:/squad/Logs:ro", validate.PanelSavedRoot, spec.ServerID)
	socketBind := fmt.Sprintf("%s:/run/panelBridge:rw", validate.PanelSocketRoot)

	args := []string{
		"run", "-d",
		"--name", name,
		"--label", "panel.kind=rnsquadjs",
		"--network", "host",
		"--user", "1001:1001",
		"--read-only",
		"--restart", "unless-stopped",
		"-v", logsBind,
		"-v", socketBind,
	}
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env { keys = append(keys, k) }
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, spec.Env[k]))
	}
	args = append(args, validate.RNSquadJSImage)
	return args, nil
}

func (d *Dispatcher) RunRNSquadJS(ctx context.Context, spec RNSquadJSRunSpec) (string, error) {
	args, err := d.composeRNSquadJSArgs(spec)
	if err != nil { return "", err }
	out, err := d.Cmd.Run(ctx, "docker", args...)
	if err != nil { return "", fmt.Errorf("docker run rnsquadjs: %w (%s)", err, out) }
	return strings.TrimSpace(out), nil
}
```

In `apps/bridge/internal/handlers/handlers.go`, add a case:

```go
case "container_run_rnsquadjs":
	return d.containerRunRnsquadjs(ctx, req)
```

and the handler:

```go
type rnsquadjsRunParams struct {
	ServerID string            `json:"serverId"`
	Env      map[string]string `json:"env"`
}

func (d *Dispatcher) containerRunRnsquadjs(ctx context.Context, req *rpc.Request) rpc.Response {
	var p rnsquadjsRunParams
	if err := json.Unmarshal(req.Params, &p); err != nil { return rpc.Error(req, -32602, err.Error()) }
	id, err := d.Docker.RunRNSquadJS(ctx, runner.RNSquadJSRunSpec{ServerID: p.ServerID, Env: p.Env})
	if err != nil { return rpc.Error(req, -32000, err.Error()) }
	return rpc.OK(req, map[string]string{"containerId": id})
}
```

Also ensure the host pre-creates `/run/squad-panel/rnsquadjs` with `0775 root:panel` (add to `scripts/install-host-bridge.sh`) so non-root sidecar uid 1001 can mknod its socket.

- [ ] **Step 5: Run tests to verify pass**

```bash
cd apps/bridge && go test -race -count=1 ./...
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/bridge/internal/validate/paths.go apps/bridge/internal/validate/paths_test.go \
        apps/bridge/internal/runner/docker.go apps/bridge/internal/runner/docker_test.go \
        apps/bridge/internal/handlers/handlers.go scripts/install-host-bridge.sh
git commit -m "feat(bridge): container_run_rnsquadjs RPC + socket-dir allowlist"
```

---

## Task 15: Bridge client wrapper + method allowlist + e2e

**Files:**
- Modify: `packages/shared-config/src/bridge-methods.ts`
- Modify: `packages/bridge-client/src/types.ts`
- Modify: `packages/bridge-client/src/client.ts`
- Modify: `apps/api/test/e2e/bridge-rpc.e2e.test.ts`

- [ ] **Step 1: Add the method to the shared allowlist**

In `packages/shared-config/src/bridge-methods.ts`, append `'container_run_rnsquadjs'` to the `BRIDGE_METHODS` constant.

- [ ] **Step 2: Add types and client method**

In `packages/bridge-client/src/types.ts`:

```ts
export interface ContainerRunRnsquadjsParams { serverId: string; env: Record<string, string> }
export interface ContainerRunRnsquadjsResult { containerId: string }
```

In `packages/bridge-client/src/client.ts`, add (alongside the existing `containerRun`):

```ts
async containerRunRnsquadjs(params: ContainerRunRnsquadjsParams): Promise<ContainerRunRnsquadjsResult> {
  return this.call<ContainerRunRnsquadjsResult>('container_run_rnsquadjs', params);
}
```

- [ ] **Step 3: Add e2e cases for success and forbidden**

In `apps/api/test/e2e/bridge-rpc.e2e.test.ts`, append:

```ts
test('container_run_rnsquadjs launches sidecar', async () => {
  const id = await ensureCanaryServer(); // existing test helper or inline insert
  const res = await client.containerRunRnsquadjs({
    serverId: id,
    env: { SERVER_ID: id, API_URL: 'http://api:3000', LOG_FILE: '/squad/Logs/SquadGame.log',
           PANEL_BRIDGE_MODE: 'shadow', REDIS_URL: 'redis://redis:6379' },
  });
  expect(res.containerId).toMatch(/^[a-f0-9]{12,}$/);
  await client.containerRm({ name: `rnsquadjs-${id}`, force: true });
});

test('container_run_rnsquadjs rejects bogus serverId', async () => {
  await expect(client.containerRunRnsquadjs({ serverId: '../etc/passwd', env: {} })).rejects.toThrow(/forbidden/i);
});
```

- [ ] **Step 4: Run unit + e2e**

```bash
pnpm --filter @squad/bridge-client typecheck
pnpm --filter @squad/api test:e2e -- bridge-rpc
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-config/src/bridge-methods.ts packages/bridge-client/src/types.ts packages/bridge-client/src/client.ts apps/api/test/e2e/bridge-rpc.e2e.test.ts
git commit -m "feat(bridge-client): containerRunRnsquadjs wrapper + e2e"
```

---

## Task 16: server-install — Logs dir guarantee + sidecar launch

**Files:**
- Modify: `apps/api/src/routes/server-install.ts`

- [ ] **Step 1: Read the current install flow around the Squad `containerRun`**

```bash
sed -n '150,210p' apps/api/src/routes/server-install.ts
```

Confirm where Squad's `containerRun` resolves successfully (the seam).

- [ ] **Step 2: After Squad `containerRun`, ensure the Logs dir exists then launch the sidecar**

Insert immediately after the existing `await app.bridge.containerRun({ ... })` for `squad-{uuid}`:

```ts
await app.bridge.fileAtomicWrite({
  path: `/var/lib/squad-panel/saved/${id}/SquadGame/Saved/Logs/.keep`,
  content: '',
});

await app.bridge.containerRunRnsquadjs({
  serverId: id,
  env: {
    SERVER_ID: id,
    API_URL: 'http://api:3000',
    LOG_FILE: '/squad/Logs/SquadGame.log',
    PANEL_BRIDGE_MODE: 'production',
    PANEL_BRIDGE_SOCKET: '/run/panelBridge/rcon.sock',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://redis:6379',
  },
});
```

The socket directory itself was created by `scripts/install-host-bridge.sh` in Task 14 step 4.

- [ ] **Step 3: Run typecheck and existing api tests**

```bash
pnpm --filter @squad/api typecheck
pnpm --filter @squad/api test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/server-install.ts
git commit -m "feat(api): launch rnsquadjs sidecar on install"
```

---

## Task 17: stop / delete — symmetric sidecar teardown

**Files:**
- Modify: `apps/api/src/routes/servers.ts` (stop and delete handlers)
- Modify: `apps/api/src/server.ts` (decorate `app.rcon`)
- Modify: `apps/api/src/plugins/types.ts`

- [ ] **Step 1: In the stop handler, call sidecar stop AFTER Squad stop**

Locate the existing `app.bridge.containerStop({ name: \`squad-${id}\` })` and append:

```ts
await app.bridge.containerStop({ name: `rnsquadjs-${id}` }).catch((err) => {
  app.log.warn({ err, id }, 'rnsquadjs sidecar stop failed (continuing)');
});
```

- [ ] **Step 2: In the delete handler, remove sidecar BEFORE Squad container**

Locate the existing `containerRm({ name: \`squad-${id}\` })`. Insert before it:

```ts
await app.bridge.containerRm({ name: `rnsquadjs-${id}`, force: true }).catch((err) => {
  app.log.warn({ err, id }, 'rnsquadjs sidecar rm failed (continuing)');
});
```

The `.catch` for both is intentional — operator-initiated stop must not be blocked by a sidecar that already crashed.

- [ ] **Step 3: Update `app.rcon` calls inside `stop`**

The current stop flow opens a direct RCON socket to issue `AdminBroadcast` + `AdminEndMatch`. Replace with `app.rcon.exec(id, 'AdminBroadcast', ['Сервер останавливается'])` and `app.rcon.exec(id, 'AdminEndMatch', [])`. Decorate `app.rcon` in `apps/api/src/server.ts`:

```ts
import { createRconClient } from './lib/rcon.js';
// ...
app.decorate('rcon', createRconClient());
```

Add the decoration type in `apps/api/src/plugins/types.ts`:

```ts
import type { RconClient } from '../lib/rcon.js';
declare module 'fastify' {
  interface FastifyInstance { rcon: RconClient }
}
```

- [ ] **Step 4: Run all api tests**

```bash
pnpm --filter @squad/api test
```

Expected: PASS, including the existing stop-flow integration tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/servers.ts apps/api/src/server.ts apps/api/src/plugins/types.ts
git commit -m "feat(api): symmetric rnsquadjs sidecar stop/delete + route rcon via sidecar"
```

---

## Task 18: e2e — assert sidecar lifecycle

**Files:**
- Modify: `apps/api/test/e2e/install-lifecycle.e2e.test.ts`

- [ ] **Step 1: Add four assertions to the existing install-lifecycle test**

After the existing assertion that the Squad container is `running`:

```ts
const sidecarInspect = await bridgeClient.containerInspect({ name: `rnsquadjs-${serverId}` });
expect(sidecarInspect.state).toBe('running');

const heartbeat = await waitFor(async () => {
  const v = await redis.get(`worker:heartbeat:rnsquadjs:${serverId}`);
  return v ?? null;
}, { timeoutMs: 30_000 });
expect(heartbeat).toBeTruthy();

const status = await waitFor(async () => {
  const raw = await redis.get(`rcon:status:${serverId}`);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return parsed.state === 'connected' ? parsed : null;
}, { timeoutMs: 60_000 });
expect(status?.state).toBe('connected');

const events = await waitFor(async () => {
  const rows = await redis.xrange(`events:server:${serverId}`, '-', '+', 'COUNT', 50);
  return rows.length > 0 ? rows : null;
}, { timeoutMs: 120_000 });
expect(events).not.toBeNull();
const types = events!.map(([, fields]) => JSON.parse(fields[1]).type);
expect(types.length).toBeGreaterThan(0);
// Specific event-type parity is enforced by the shadow-stream comparison in
// Phase 1 of the cutover runbook (against the golden fixture from Task 1),
// not here on a fresh-install timeline where NEW_GAME may not fire for ~30 min.
```

After the existing `/stop` assertion:

```ts
const sidecarStopped = await waitFor(async () => {
  const i = await bridgeClient.containerInspect({ name: `rnsquadjs-${serverId}` });
  return i.state === 'exited' ? i : null;
}, { timeoutMs: 30_000 });
expect(sidecarStopped?.state).toBe('exited');
```

If `waitFor` is not present in the suite, add a 12-line helper at the top of the file:

```ts
async function waitFor<T>(fn: () => Promise<T | null>, { timeoutMs }: { timeoutMs: number }): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}
```

- [ ] **Step 2: Run the e2e**

```bash
export PANEL_TEST_URL=https://squad-panel.lan
export PANEL_TEST_COOKIE=<session cookie from browser>
pnpm --filter @squad/api test:e2e -- install-lifecycle
```

Expected: PASS within ~3 min. Failure modes worth recognising:
- `rnsquadjs-{uuid}` `state=exited` immediately → entrypoint crashed; check `docker logs rnsquadjs-{uuid}` for `curl` exit code (API unreachable) or missing `LOG_FILE`.
- `rcon:status` stuck at `disconnected` → `squad-rcon` AUTH failed; verify two-packet workaround per spec §7.3.
- No `events:server:{id}` entries → `panelBridge` plugin not loaded; check the rendered `config.json` `plugins.panelBridge.enabled === true`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/e2e/install-lifecycle.e2e.test.ts
git commit -m "test(e2e): assert rnsquadjs sidecar runs, publishes events, stops with squad"
```

---

## Task 19: Document the Unix-socket deviation in the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-24-rnsquadjs-migration-design.md`

- [ ] **Step 1: Replace the "RCON command HTTP" bullet in §3.2**

Find:

> **RCON command HTTP.** `POST /rcon { method, args }` on `127.0.0.1:8765` …

Replace with:

> **RCON command Unix socket.** `POST /rcon { method, args }` on a per-server Unix socket at `/run/panelBridge/rcon.sock` inside the sidecar (bind-mounted from host `/run/squad-panel/rnsquadjs/{uuid}.sock` so the panel API container can reach it). Loopback HTTP would require port allocation under `--network host` because all sidecars share the host network — the socket avoids that allocation problem entirely.

And update the diagram block in §2:

> ├── HTTP POST /rcon  (loopback only — API → sidecar)

→

> ├── Unix POST /rcon  (per-server socket — API → sidecar)

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-24-rnsquadjs-migration-design.md
git commit -m "docs(spec): replace loopback HTTP with per-server unix socket"
```

---

## Task 20: Full check before handoff

**Files:** none

- [ ] **Step 1: Full repo typecheck and unit suite**

```bash
pnpm turbo run typecheck
pnpm turbo run test
```

Expected: both green. Anything red blocks the handoff to Phase 3 (canary cutover runbook).

- [ ] **Step 2: Bridge unit + race**

```bash
cd apps/bridge && go test -race -count=1 ./...
```

Expected: green.

- [ ] **Step 3: panelBridge full suite**

```bash
cd docker/rnsquadjs/plugins/panelBridge && npx vitest run
```

Expected: 5 tests across 2 files green.

- [ ] **Step 4: Compatibility checklist (spec §7) — record results**

Diff `https://github.com/lACTEPUKCl/RNSquadJS/compare/<previously-pinned>...${RN_SHA}` (or, on first run, just inspect `${RN_SHA}` and answer the questions):

1. `squad-logs` regex change? — record yes/no in commit message of the SHA pin.
2. EventEmitter event renames? — same.
3. `squad-rcon` AUTH workaround intact? — same.
4. New plugin opening Mongo without `enabled` check? — same.
5. Node version >18.18? — same.

If any answer is ambiguous, do not proceed to Phase 3 — open an issue, hold the bump.

- [ ] **Step 5: Commit the SHA pin (if not already pinned in Task 10)**

```bash
git add docker/rnsquadjs.Dockerfile
git commit -m "chore(rnsquadjs): pin upstream to <short-sha>

§7 checklist: squad-logs regex unchanged; emitter API unchanged;
two-packet AUTH present; no new mongo-coupled plugin; node 18.18 ok."
```

Plan complete. The Phase 3–5 cutover is a runbook, not a code change — to be authored against `docs/superpowers/plans/2026-XX-XX-rnsquadjs-cutover-runbook.md` once the panel team is ready to flip the canary.
