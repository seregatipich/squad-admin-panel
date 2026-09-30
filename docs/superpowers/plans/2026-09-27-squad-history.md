# Squad History and Creator Crowns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect in-game squad creations, squad-leader changes and disbands from worker-rcon's roster refreshes and RCON broadcasts, persist them as `squad.*` events, and show grey/red creator crowns in the live roster. Also fix `match_players.squad_name`, which is always `null` today.

**Architecture:** worker-rcon parses the unsolicited `has created Squad` broadcast (`squad-broadcast.ts`). On every roster refresh it diffs consecutive `ListSquads` + `ListPlayers` snapshots with a pure tracker (`squad-tracker.ts`) and folds the events into per-creator crown histories (`squad-crowns.ts`). `PerServerSupervisor` persists each event the way `emitSeedingTransition` does (XADD + `events` insert) and mirrors crowns into the Redis hash `rcon:squad-crowns:{serverId}`. `GET /api/v1/servers/:id/roster` attaches `squad_crown` to each player, and the web roster renders an inline SVG crown with a Russian tooltip. log-ingest builds `match_players` team and squad name from the `rcon:roster` / `rcon:squads` Redis snapshots instead of `rcon.players_polled` rows that are never written.

**Tech Stack:** TypeScript (strict), Zod 3, ioredis 5, Drizzle ORM + postgres.js, Fastify 5, Next.js 15 / React 19, Vitest 3, @testing-library/react, Biome, pnpm 9 + Turbo.

**Spec:** [`docs/superpowers/specs/2026-09-27-squad-history-design.md`](../specs/2026-09-27-squad-history-design.md)

---

## Global Constraints

- **Workspace.** Work only in `/home/seregatipich/squad-admin-panel/.claude/worktrees/feature-squad-history` on branch `feature/squad-history`, which is based on `origin/dev`. Do not push, merge, or touch `dev` or `master` from this plan. Every command below runs from the worktree root unless a step says otherwise.
- **Test infrastructure. This host is production (tk104). NEVER connect to ports 5432 or 6379.** Every shell that runs tests must start with:
  ```bash
  cd /home/seregatipich/squad-admin-panel/.claude/worktrees/feature-squad-history
  export PG_CONTAINER=squad-fixwave-pg PG_PORT=55441
  eval "$(bash scripts/new-test-db.sh squad_history)"
  export REDIS_URL=redis://127.0.0.1:56391/14 TEST_REDIS_URL=redis://127.0.0.1:56391/14
  ```
  Both Redis variables are required. `apps/workers/_test-shared/load-env.ts` falls back to `redis://127.0.0.1:6379`, while the API harness (`apps/api/test/integration/isolated-db.ts`) throws when `TEST_REDIS_URL` is unset. Before running any test, check with `echo "$DATABASE_URL $TEST_DATABASE_URL $REDIS_URL $TEST_REDIS_URL"` that every value shows port 55441 or 56391.
- **Dependencies.** The worktree starts without `node_modules`. Run `nice -n 10 pnpm install --frozen-lockfile` once before Task 1. Otherwise `vitest`, `tsc` and `biome` are not found.
- **Heavy commands.** Prefix every `pnpm`, `vitest`, `tsc`, `turbo` and `biome` invocation with `nice -n 10`.
- **Test commands.** Run one file at a time with `nice -n 10 pnpm --filter <pkg> exec vitest run <file>`. Do not use `test:cov` or `pnpm turbo run test`, which build everything first.
- **Never commit red.** Before each commit, the task's test files, the affected package's typecheck (`nice -n 10 pnpm turbo run typecheck --filter=<pkg>`) and `nice -n 10 pnpm exec biome check <touched files>` must all pass. Import order is a Biome error. Fix it with `nice -n 10 pnpm exec biome check --write <file>`.
- **Commits.** Every commit is authored and trailed like this:
  ```bash
  git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "<type>(<scope>): <subject>" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
  ```
- **UI language.** Every user-visible string (tooltip, `aria-label`, journal label) is Russian.
- **Shared types.** `packages/shared-types` enforces **100 %** coverage thresholds (`vitest.config.ts`). Every new export must be exercised by a test. After changing it, run `nice -n 10 pnpm --filter @squad/shared-types build` so the dependents' typecheck sees the new `dist/*.d.ts`.
- **No migration, no new dependencies, no new routes, no new live-bus frame.** `events` is already partitioned (default partition exists, `0029`). The existing `rcon.roster` frame already refetches the roster.
- **Docs.** Documentation changes happen in Task 10. Code comments and docstrings are updated in the task that changes the code.

## Review Focus

These are the five failure modes most likely to slip past a happy-path run. Each one has a dedicated test in the task that owns it.

1. **A restart or reconnect storms the journal with false `squad.created` events, or erases crowns.** The first snapshot after a worker start or an RCON (re)connect must be a baseline, and crowns restored from Redis must be extended rather than replaced. Test: Task 5, `starts from a baseline after a restart and extends the restored crowns`.
2. **A round end on a small server reports every squad as disbanded.** The mass-vanish rule only fires at 3 or more squads. A seeding round with 1–2 squads loses them all at the map change, between `match.ended` and `match.started`. Tests: Task 3, `treats every squad of a 3+ squad snapshot vanishing at once as a map change` and `still reports disbands when only two squads vanish`. Task 5, `clears crowns at round end and reports no disbands when the old map's squads vanish`.
3. **Skew between ListSquads and ListPlayers invents leader changes.** A refresh can catch a squad whose leader flag is momentarily missing. That must not produce A → A or A → nobody events, and a real A → nobody → B change must be reported once, from A. Tests: Task 3, `reports nothing when the same leader reappears after a leaderless refresh` and `bridges a leaderless gap`.
4. **Downstream consumers silently drop the new envelopes.** `apps/workers/automation/src/dispatch.ts` and `apps/workers/discord/src/consume.ts` parse every stream entry with the strict `eventEnvelope`. Today it rejects `actor.kind = 'player'`, and a payload that drifts from its Zod schema is invisible until a consumer needs it. Tests: Task 1, `accepts a player actor on the envelope`. Task 5, `publishes envelopes every stream consumer accepts`, which validates every XADDed `squad.*` envelope and payload.
5. **Match close writes the wrong squad, or no roster at all.** A Redis snapshot from another match (log replay, late close) must be ignored, and a Redis outage must still write `match_players` with `null` squads. Tests: Task 9, `ignores a roster snapshot polled after the match window` and `still writes the roster when Redis is unavailable`.

---

### Task 1: Shared contracts — `squad.*` event kinds, payload schemas, player actor, crown hash

**Files:**
- Modify: `packages/shared-types/src/events.ts` — lines 3–48 (`EVENT_TYPES`), line 52 (`actorKind`), after line 250 (new schemas), lines 252–275 (`PAYLOAD_SCHEMAS`)
- Create: `packages/shared-types/src/squad-crowns.ts`
- Modify: `packages/shared-types/src/index.ts` (add one export after line 11)
- Test: `packages/shared-types/test/events.test.ts` (append a describe block and extend the import at lines 2–18)
- Test (create): `packages/shared-types/test/squad-crowns.test.ts`
- Test: `packages/shared-types/test/index.test.ts` (append one `it`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // events.ts
  export type EventType = /* ... */ | 'squad.created' | 'squad.leader_changed' | 'squad.disbanded';
  // actor.kind: 'user' | 'system' | 'external' | 'player'
  export const squadPlayerRef: z.ZodObject<...>;
  export type SquadPlayerRef = { eos_id: string; steam_id64: string | null; name: string };
  export const squadLeaderChangeReason: z.ZodEnum<['passed', 'left_squad', 'disconnected']>;
  export type SquadLeaderChangeReason = 'passed' | 'left_squad' | 'disconnected';
  export const squadCreatedPayload, squadLeaderChangedPayload, squadDisbandedPayload;
  export type SquadCreatedPayload = { team_id: number; team_name: string; squad_id: number; squad_name: string; creator: SquadPlayerRef };
  export type SquadLeaderChangedPayload = SquadCreatedPayload & { from: SquadPlayerRef; to: SquadPlayerRef; reason: SquadLeaderChangeReason };
  export type SquadDisbandedPayload = SquadCreatedPayload & { last_leader: SquadPlayerRef | null; creator_was_leader: boolean };
  // squad-crowns.ts
  export const SQUAD_CROWNS_KEY_PREFIX = 'rcon:squad-crowns:';
  export const SQUAD_CROWNS_TTL_SECONDS = 21_600;
  export function squadCrownsKey(serverId: string): string;
  export const squadCrownHandoffSchema, squadCrownSquadSchema, squadCrownSchema;
  export type SquadCrownHandoff = { to_name: string; reason: SquadLeaderChangeReason; at: string };
  export type SquadCrownSquad = { squad_name: string; team_id: number; squad_id: number; created_at: string | null; handoffs: SquadCrownHandoff[]; disbanded_at: string | null; abandoned_at: string | null };
  export type SquadCrown = { color: 'grey' | 'red'; squads: SquadCrownSquad[] };
  ```

- [ ] **Step 1: Write the failing tests**

In `packages/shared-types/test/events.test.ts`, add `squadCreatedPayload`, `squadDisbandedPayload`, `squadLeaderChangedPayload` and `squadPlayerRef` to the import list from `'../src/events.js'` (lines 2–18). Then append this block at the end of the file:

```ts
describe('squad history payload schemas', () => {
  const anna = { eos_id: 'a'.repeat(32), steam_id64: '76561198000000001', name: 'Anna' };
  const boris = { eos_id: 'b'.repeat(32), steam_id64: null, name: 'Boris' };
  const base = {
    team_id: 1,
    team_name: 'United States Army',
    squad_id: 3,
    squad_name: 'Alpha',
    creator: anna,
  };

  it('lists the three squad kinds in EVENT_TYPES', () => {
    expect(EVENT_TYPES).toEqual(
      expect.arrayContaining(['squad.created', 'squad.leader_changed', 'squad.disbanded']),
    );
  });

  it('accepts a created payload and rejects unknown keys', () => {
    expect(validatePayload('squad.created', base).ok).toBe(true);
    expect(squadCreatedPayload.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('accepts every leader change reason and rejects any other', () => {
    for (const reason of ['passed', 'left_squad', 'disconnected'] as const) {
      expect(
        validatePayload('squad.leader_changed', { ...base, from: anna, to: boris, reason }).ok,
      ).toBe(true);
    }
    expect(
      squadLeaderChangedPayload.safeParse({ ...base, from: anna, to: boris, reason: 'kicked' })
        .success,
    ).toBe(false);
  });

  it('accepts a disband with or without a known last leader', () => {
    expect(
      validatePayload('squad.disbanded', { ...base, last_leader: anna, creator_was_leader: true })
        .ok,
    ).toBe(true);
    expect(
      squadDisbandedPayload.safeParse({ ...base, last_leader: null, creator_was_leader: false })
        .success,
    ).toBe(true);
  });

  it('rejects a player reference without a 32-hex EOS id', () => {
    expect(squadPlayerRef.safeParse({ ...anna, eos_id: 'not-eos' }).success).toBe(false);
  });

  it('accepts a player actor on the envelope', () => {
    expect(
      eventEnvelope.safeParse({
        ...baseEnvelope,
        type: 'squad.created',
        actor: { kind: 'player', id: anna.eos_id },
        payload: base,
      }).success,
    ).toBe(true);
  });
});
```

Create `packages/shared-types/test/squad-crowns.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SQUAD_CROWNS_TTL_SECONDS, squadCrownSchema, squadCrownsKey } from '../src/squad-crowns.js';

const squad = {
  squad_name: 'Alpha',
  team_id: 1,
  squad_id: 3,
  created_at: '2026-09-27T21:04:00.000Z',
  handoffs: [{ to_name: 'Ivan', reason: 'passed', at: '2026-09-27T21:10:00.000Z' }],
  disbanded_at: null,
  abandoned_at: null,
};
const crown = { color: 'grey', squads: [squad] };

describe('squad crowns contract', () => {
  it('keys the hash per server', () => {
    expect(squadCrownsKey('srv-1')).toBe('rcon:squad-crowns:srv-1');
  });

  it('keeps crowns for six hours', () => {
    expect(SQUAD_CROWNS_TTL_SECONDS).toBe(21_600);
  });

  it('accepts a grey and a red crown', () => {
    expect(squadCrownSchema.safeParse(crown).success).toBe(true);
    expect(squadCrownSchema.safeParse({ ...crown, color: 'red' }).success).toBe(true);
  });

  it('accepts a squad whose creation the worker never saw', () => {
    expect(
      squadCrownSchema.safeParse({ ...crown, squads: [{ ...squad, created_at: null }] }).success,
    ).toBe(true);
  });

  it('rejects an unknown colour, a bad timestamp and extra keys', () => {
    expect(squadCrownSchema.safeParse({ ...crown, color: 'gold' }).success).toBe(false);
    expect(
      squadCrownSchema.safeParse({ ...crown, squads: [{ ...squad, created_at: '21:04' }] })
        .success,
    ).toBe(false);
    expect(squadCrownSchema.safeParse({ ...crown, extra: true }).success).toBe(false);
  });
});
```

In `packages/shared-types/test/index.test.ts`, append inside `describe('shared-types index re-exports', …)`:

```ts
  it('re-exports the squad crowns contract', () => {
    expect(root.squadCrownsKey('srv-1')).toBe('rcon:squad-crowns:srv-1');
    expect(typeof root.squadCrownSchema.safeParse).toBe('function');
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
nice -n 10 pnpm --filter @squad/shared-types exec vitest run test/events.test.ts test/squad-crowns.test.ts test/index.test.ts
```

Expected: FAIL. `squad-crowns.test.ts` cannot resolve `../src/squad-crowns.js`. In `events.test.ts`, `TypeError: Cannot read properties of undefined (reading 'safeParse')` for `squadCreatedPayload`, and the `EVENT_TYPES`/player-actor cases fail on their assertions. `index.test.ts` fails with `root.squadCrownsKey is not a function`.

- [ ] **Step 3: Implement**

In `packages/shared-types/src/events.ts`, append three entries to `EVENT_TYPES` after `'server.seeding_ended',`:

```ts
  'server.seeding_ended',

  'squad.created',
  'squad.leader_changed',
  'squad.disbanded',
] as const;
```

Replace line 52:

```ts
/**
 * Who caused an event. `player` marks events about an in-game player that no
 * panel user triggered (squad history); `id` is then the player's EOS id.
 */
const actorKind = z.enum(['user', 'system', 'external', 'player']);
```

Insert after `export type SeedingTransitionPayload = …;` (line 250):

```ts
/** A player as squad history names them: EOS id always, SteamID64 when linked. */
export const squadPlayerRef = z
  .object({
    eos_id: z.string().regex(/^[a-f0-9]{32}$/),
    steam_id64: z
      .string()
      .regex(/^\d{17}$/)
      .nullable(),
    name: z.string(),
  })
  .strict();
export type SquadPlayerRef = z.infer<typeof squadPlayerRef>;

/**
 * Why a squad's leader changed, judged by where the previous leader is in the
 * same roster refresh: still in the squad (`passed`), online elsewhere
 * (`left_squad`), or gone from `ListPlayers` (`disconnected`).
 */
export const squadLeaderChangeReason = z.enum(['passed', 'left_squad', 'disconnected']);
export type SquadLeaderChangeReason = z.infer<typeof squadLeaderChangeReason>;

/**
 * Identity shared by every `squad.*` payload. Within a match a squad is
 * `(team_id, squad_id, creator.eos_id)`: Squad reuses squad numbers.
 */
const squadBase = {
  team_id: z.number().int(),
  team_name: z.string(),
  squad_id: z.number().int(),
  squad_name: z.string(),
  creator: squadPlayerRef,
};

/** `squad.created` — emitted by worker-rcon (`apps/workers/rcon/src/squad-tracker.ts`). */
export const squadCreatedPayload = z.object(squadBase).strict();
export type SquadCreatedPayload = z.infer<typeof squadCreatedPayload>;

/** `squad.leader_changed` — leadership moved from `from` to `to`. */
export const squadLeaderChangedPayload = z
  .object({
    ...squadBase,
    from: squadPlayerRef,
    to: squadPlayerRef,
    reason: squadLeaderChangeReason,
  })
  .strict();
export type SquadLeaderChangedPayload = z.infer<typeof squadLeaderChangedPayload>;

/** `squad.disbanded` — the squad is gone; `creator_was_leader` is true when its creator led it last. */
export const squadDisbandedPayload = z
  .object({
    ...squadBase,
    last_leader: squadPlayerRef.nullable(),
    creator_was_leader: z.boolean(),
  })
  .strict();
export type SquadDisbandedPayload = z.infer<typeof squadDisbandedPayload>;
```

Add three entries to `PAYLOAD_SCHEMAS` after `'server.seeding_ended': seedingTransitionPayload,`:

```ts
  'squad.created': squadCreatedPayload,
  'squad.leader_changed': squadLeaderChangedPayload,
  'squad.disbanded': squadDisbandedPayload,
```

Create `packages/shared-types/src/squad-crowns.ts`:

```ts
/**
 * Contract of the `rcon:squad-crowns:{serverId}` Redis hash (squad history,
 * docs/superpowers/specs/2026-09-27-squad-history-design.md §2).
 *
 * worker-rcon writes one field per squad creator (EOS id) whose leadership
 * earned a crown in the current match, and deletes the hash on a match reset.
 * `GET /api/v1/servers/:id/roster` reads it and attaches the matching entry to
 * each roster player as `squad_crown`.
 */
import { z } from 'zod';
import { squadLeaderChangeReason } from './events.js';

export const SQUAD_CROWNS_KEY_PREFIX = 'rcon:squad-crowns:';

/** Refreshed on every write; a hash whose server stopped reporting expires on its own. */
export const SQUAD_CROWNS_TTL_SECONDS = 6 * 60 * 60;

/** Redis key of one server's crown hash. */
export function squadCrownsKey(serverId: string): string {
  return `${SQUAD_CROWNS_KEY_PREFIX}${serverId}`;
}

/** One change of command away from the creator. */
export const squadCrownHandoffSchema = z
  .object({
    to_name: z.string(),
    reason: squadLeaderChangeReason,
    at: z.string().datetime(),
  })
  .strict();

/** One squad the creator made in the current match. */
export const squadCrownSquadSchema = z
  .object({
    squad_name: z.string(),
    team_id: z.number().int(),
    squad_id: z.number().int(),
    /** `null` when the squad already existed when the worker started tracking it. */
    created_at: z.string().datetime().nullable(),
    handoffs: z.array(squadCrownHandoffSchema),
    disbanded_at: z.string().datetime().nullable(),
    /** When the creator left the squad, disconnected, or let it disband while leading it. */
    abandoned_at: z.string().datetime().nullable(),
  })
  .strict();

/** A creator's crown: `grey` handed command to a squadmate, `red` abandoned a squad while leading it. */
export const squadCrownSchema = z
  .object({
    color: z.enum(['grey', 'red']),
    squads: z.array(squadCrownSquadSchema),
  })
  .strict();

export type SquadCrownHandoff = z.infer<typeof squadCrownHandoffSchema>;
export type SquadCrownSquad = z.infer<typeof squadCrownSquadSchema>;
export type SquadCrown = z.infer<typeof squadCrownSchema>;
```

In `packages/shared-types/src/index.ts`, add after `export * from './rcon-commands.js';`:

```ts
export * from './squad-crowns.js';
```

- [ ] **Step 4: Run the tests, the coverage floor, and build**

```bash
nice -n 10 pnpm --filter @squad/shared-types exec vitest run test/events.test.ts test/squad-crowns.test.ts test/index.test.ts
nice -n 10 pnpm --filter @squad/shared-types exec vitest run --coverage
nice -n 10 pnpm --filter @squad/shared-types build
nice -n 10 pnpm turbo run typecheck --filter=@squad/shared-types
nice -n 10 pnpm exec biome check packages/shared-types
```

Expected: all tests PASS. Coverage stays at 100/100/100/100. The build emits `dist/squad-crowns.d.ts`. Typecheck and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(shared-types): squad history event kinds, player actor and crown hash contract" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 2: RCON squad-creation broadcast parser

**Files:**
- Create: `apps/workers/rcon/src/squad-broadcast.ts`
- Modify: `apps/workers/rcon/src/chat.ts` — lines 28–41 (export the id-pair reader as `parseOnlineIds`) and line 56 (its one call site)
- Test (create): `apps/workers/rcon/test/squad-broadcast.test.ts`

**Interfaces:**
- Consumes: `parseOnlineIds` from `chat.ts` (renamed from the private `parseIds`).
- Produces:
  ```ts
  export function parseOnlineIds(block: string): { eosId: string | null; steamId64: string | null };
  export interface SquadCreatedBroadcast {
    creatorName: string; creatorEosId: string; creatorSteamId64: string | null;
    squadId: number; squadName: string; teamName: string; at: string;
  }
  export function parseSquadCreatedBroadcast(body: string, at: string): SquadCreatedBroadcast | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/workers/rcon/test/squad-broadcast.test.ts`. The first line is the real fixture from `test/chat.test.ts:113`.

```ts
import { describe, expect, it } from 'vitest';
import { parseSquadCreatedBroadcast } from '../src/squad-broadcast.js';

const EOS = '0002aaaa000000000000000000000001';
const STEAM = '76561199000000001';
const AT = '2026-09-27T21:04:00.000Z';

describe('parseSquadCreatedBroadcast', () => {
  it('parses the notice Squad sends when a squad is created', () => {
    expect(
      parseSquadCreatedBroadcast(
        `PanelAlpha (Online IDs: EOS: ${EOS} steam: ${STEAM}) has created Squad 1 (Squad Name: Panel Squad) on Western Private Military Contractors`,
        AT,
      ),
    ).toEqual({
      creatorName: 'PanelAlpha',
      creatorEosId: EOS,
      creatorSteamId64: STEAM,
      squadId: 1,
      squadName: 'Panel Squad',
      teamName: 'Western Private Military Contractors',
      at: AT,
    });
  });

  it('keeps parentheses inside the player and squad names', () => {
    expect(
      parseSquadCreatedBroadcast(
        `Ivan (RU) (Online IDs: EOS: ${EOS} steam: ${STEAM}) has created Squad 12 (Squad Name: Alpha (2)) on Russian Ground Forces`,
        AT,
      ),
    ).toMatchObject({
      creatorName: 'Ivan (RU)',
      squadId: 12,
      squadName: 'Alpha (2)',
      teamName: 'Russian Ground Forces',
    });
  });

  it('accepts an Epic account without Steam and upper-case hex', () => {
    expect(
      parseSquadCreatedBroadcast(
        `NoSteam (Online IDs: EOS: ${EOS.toUpperCase()}) has created Squad 4 (Squad Name: INF) on United States Army`,
        AT,
      ),
    ).toMatchObject({ creatorEosId: EOS, creatorSteamId64: null });
  });

  it('strips the packet framing', () => {
    expect(
      parseSquadCreatedBroadcast(
        `A (Online IDs: EOS: ${EOS}) has created Squad 2 (Squad Name: B) on C\0\n`,
        AT,
      )?.teamName,
    ).toBe('C');
  });

  it.each([
    `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] PanelAlpha : has created Squad 1 (Squad Name: x) on y`,
    `[Online Ids:EOS: ${EOS} steam: ${STEAM}] PanelAlpha has possessed admin camera.`,
    `PanelAlpha (Online IDs: steam: ${STEAM}) has created Squad 1 (Squad Name: Panel Squad) on USA`,
    'Kicked player 3. Steam: 76561199000000001 PanelAlpha',
    '',
  ])('returns null for a line that is not a creation notice with an EOS id %#', (line) => {
    expect(parseSquadCreatedBroadcast(line, AT)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-broadcast.test.ts
```

Expected: FAIL. `Failed to load url ../src/squad-broadcast.js` (the module does not exist).

- [ ] **Step 3: Implement**

In `apps/workers/rcon/src/chat.ts`, replace the private helper (lines 28–41) with an exported one and keep its body:

```ts
/**
 * Reads the `<platform>: <id>` pairs of an RCON identity block. Squad emits
 * them in no fixed order and may carry platforms beyond EOS and Steam, so they
 * are read as pairs rather than matched positionally (mirrors SquadJS's
 * id-parser). Shared by the chat and squad-creation parsers.
 *
 * @param block - The text between `Online IDs:` and the closing bracket.
 * @returns The lower-cased 32-hex EOS id and the 17-digit SteamID64, each `null` when absent.
 */
export function parseOnlineIds(block: string): { eosId: string | null; steamId64: string | null } {
  let eosId: string | null = null;
  let steamId64: string | null = null;
  for (const match of block.matchAll(ID_PAIR)) {
    const platform = match[1]?.toLowerCase();
    const value = match[2];
    if (!platform || !value) continue;
    if (platform === 'eos' && /^[0-9a-f]{32}$/i.test(value)) eosId = value.toLowerCase();
    else if (platform === 'steam' && /^\d{17}$/.test(value)) steamId64 = value;
  }
  return { eosId, steamId64 };
}
```

Change the call in `parseRconChatLine` (line 56) from `parseIds(groups.ids ?? '')` to `parseOnlineIds(groups.ids ?? '')`. In the module comment (lines 1–17), change "The same packet type also carries admin-camera, squad-creation and kick/warn notices" to "The same packet type also carries admin-camera, squad-creation (see `squad-broadcast.ts`) and kick/warn notices".

Create `apps/workers/rcon/src/squad-broadcast.ts`:

```ts
/**
 * Squad-creation notices from RCON.
 *
 * Squad pushes an unsolicited packet to every authenticated RCON client when a
 * player creates a squad:
 *
 *   <name> (Online IDs: EOS: <eos32> steam: <steam17>) has created Squad <n> (Squad Name: <name>) on <team faction>
 *
 * It is the only exact creation clock. The roster refresh that first lists the
 * squad can come up to one refresh interval later, so `PerServerSupervisor`
 * queues parsed notices for the next `diffSquads` call (see `squad-tracker.ts`).
 */
import { parseOnlineIds } from './chat.js';

export interface SquadCreatedBroadcast {
  creatorName: string;
  creatorEosId: string;
  creatorSteamId64: string | null;
  squadId: number;
  squadName: string;
  /** The faction as Squad names it (`on <team faction>`); the notice carries no team id. */
  teamName: string;
  /** ISO-8601 receive time; the notice carries no clock of its own. */
  at: string;
}

/**
 * The squad name is greedy so a name containing `)` backtracks to the last
 * `) on `; the player name is lazy so a name containing `(` stops at the
 * identity block.
 */
const SQUAD_CREATED =
  /^(?<name>.+?) \(Online IDs?:(?<ids>[^)]*)\) has created Squad (?<squadId>\d+) \(Squad Name: (?<squadName>.*)\) on (?<teamName>.+)$/i;

/**
 * Parse one RCON broadcast body as a squad-creation notice.
 *
 * @param body - Raw packet body as Squad sent it.
 * @param at - ISO-8601 receive timestamp.
 * @returns The notice, or `null` when the body is anything else or carries no
 *   EOS id (squad history is keyed by EOS id).
 */
export function parseSquadCreatedBroadcast(body: string, at: string): SquadCreatedBroadcast | null {
  const groups = SQUAD_CREATED.exec(body.replace(/[\0\r\n]+$/, ''))?.groups;
  if (!groups) return null;
  const { eosId, steamId64 } = parseOnlineIds(groups.ids ?? '');
  if (!eosId) return null;
  const creatorName = (groups.name ?? '').trim();
  if (creatorName === '') return null;
  return {
    creatorName,
    creatorEosId: eosId,
    creatorSteamId64: steamId64,
    squadId: Number(groups.squadId),
    squadName: (groups.squadName ?? '').trim(),
    teamName: (groups.teamName ?? '').trim(),
    at,
  };
}
```

- [ ] **Step 4: Run the new test and the chat parser's tests**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-broadcast.test.ts test/chat.test.ts
nice -n 10 pnpm turbo run typecheck --filter=@squad/worker-rcon
nice -n 10 pnpm exec biome check apps/workers/rcon/src/chat.ts apps/workers/rcon/src/squad-broadcast.ts apps/workers/rcon/test/squad-broadcast.test.ts
```

Expected: PASS (the chat suite is unchanged, including its `returns null for the non-chat broadcast` case). Typecheck and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/rcon/src/chat.ts apps/workers/rcon/src/squad-broadcast.ts apps/workers/rcon/test/squad-broadcast.test.ts
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(workers/rcon): parse the squad-creation RCON broadcast" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 3: Pure squad tracker — `buildSquadSnapshot` + `diffSquads`

**Files:**
- Create: `apps/workers/rcon/src/squad-tracker.ts`
- Test (create): `apps/workers/rcon/test/squad-tracker.test.ts`

**Interfaces:**
- Consumes: `RconPlayer` (`parse-list-players.ts`), `RconSquad` (`parse-list-squads.ts`), `SquadCreatedBroadcast` (Task 2), `SquadPlayerRef`, `SquadLeaderChangeReason`, `SquadCreatedPayload`, `SquadLeaderChangedPayload`, `SquadDisbandedPayload` (Task 1).
- Produces:
  ```ts
  export const MASS_VANISH_MIN_SQUADS = 3;
  export interface TrackedSquad { teamId: number; teamName: string; squadId: number; name: string; creator: SquadPlayerRef; leader: SquadPlayerRef | null; lastLeader: SquadPlayerRef | null }
  export interface PlayerPlacement { teamId: number | null; squadId: number | null }
  export interface SquadSnapshot { polledAt: string; squads: Map<string, TrackedSquad>; players: Map<string, PlayerPlacement> }
  export type SquadEvent =
    | { type: 'squad.created'; at: string; payload: SquadCreatedPayload }
    | { type: 'squad.leader_changed'; at: string; payload: SquadLeaderChangedPayload }
    | { type: 'squad.disbanded'; at: string; payload: SquadDisbandedPayload };
  export interface SquadDiff { events: SquadEvent[]; state: SquadSnapshot; pending: SquadCreatedBroadcast[]; reset: boolean }
  export function squadKey(teamId: number, squadId: number, creatorEosId: string): string;
  export function buildSquadSnapshot(squads: RconSquad[], players: RconPlayer[], polledAt: string): SquadSnapshot;
  export function diffSquads(prev: SquadSnapshot | null, next: SquadSnapshot, pendingCreated: SquadCreatedBroadcast[]): SquadDiff;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/workers/rcon/test/squad-tracker.test.ts`:

```ts
import type { SquadPlayerRef } from '@squad/shared-types';
import { describe, expect, it } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import type { RconSquad } from '../src/parse-list-squads.js';
import type { SquadCreatedBroadcast } from '../src/squad-broadcast.js';
import { buildSquadSnapshot, diffSquads, type SquadSnapshot } from '../src/squad-tracker.js';

const T0 = '2026-09-27T21:00:00.000Z';
const T1 = '2026-09-27T21:00:02.000Z';
const T2 = '2026-09-27T21:00:04.000Z';
const NAMES = ['', 'Anna', 'Boris', 'Clara', 'Dmitri', 'Egor'];

const eos = (n: number) => n.toString(16).padStart(32, '0');
const steam = (n: number) => `765611980000000${String(n).padStart(2, '0')}`;
const ref = (n: number): SquadPlayerRef => ({
  eos_id: eos(n),
  steam_id64: steam(n),
  name: NAMES[n] ?? '',
});
const ANNA = ref(1);
const BORIS = ref(2);
const CLARA = ref(3);
const ALPHA_BASE = {
  team_id: 1,
  team_name: 'United States Army',
  squad_id: 1,
  squad_name: 'Alpha',
  creator: ANNA,
};

function player(n: number, squadId: number | null, leader = false, teamId = 1): RconPlayer {
  return {
    rcon_id: n,
    eos_id: eos(n),
    steam_id64: steam(n),
    name: NAMES[n] ?? '',
    team_id: teamId,
    squad_id: squadId,
    is_leader: leader,
    role: 'USA_Rifleman_01',
  };
}

function squad(squadId: number, creator: number, name = 'Alpha', teamId = 1): RconSquad {
  return {
    team_id: teamId,
    team_name: teamId === 1 ? 'United States Army' : 'Russian Ground Forces',
    squad_id: squadId,
    name,
    size: 2,
    locked: false,
    creator_name: NAMES[creator] ?? '',
    creator_eos_id: eos(creator),
    creator_steam_id64: steam(creator),
    is_command_squad: false,
  };
}

function broadcast(squadId: number, creator: number, at: string): SquadCreatedBroadcast {
  return {
    creatorName: NAMES[creator] ?? '',
    creatorEosId: eos(creator),
    creatorSteamId64: steam(creator),
    squadId,
    squadName: 'Bravo',
    teamName: 'United States Army',
    at,
  };
}

/** Anna created and leads squad 1; Boris is in it. */
function annaLeads(at = T0): SquadSnapshot {
  return buildSquadSnapshot([squad(1, 1)], [player(1, 1, true), player(2, 1)], at);
}

describe('buildSquadSnapshot', () => {
  it('keys squads by team, number and creator and finds each leader', () => {
    const snap = annaLeads();
    expect(snap.squads.get(`1:1:${eos(1)}`)).toEqual({
      teamId: 1,
      teamName: 'United States Army',
      squadId: 1,
      name: 'Alpha',
      creator: ANNA,
      leader: ANNA,
      lastLeader: ANNA,
    });
    expect(snap.players.get(eos(2))).toEqual({ teamId: 1, squadId: 1 });
  });

  it('skips a squad whose creator has no EOS id', () => {
    expect(buildSquadSnapshot([{ ...squad(1, 1), creator_eos_id: null }], [], T0).squads.size).toBe(
      0,
    );
  });

  it('does not take the leader of the same squad number on the other team', () => {
    const snap = buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(3, 1, true, 2)], T0);
    expect(snap.squads.get(`1:1:${eos(1)}`)?.leader).toBeNull();
  });
});

describe('diffSquads', () => {
  it('treats the first snapshot as a baseline', () => {
    const result = diffSquads(null, annaLeads(), []);
    expect(result.events).toEqual([]);
    expect(result.reset).toBe(false);
    expect(result.state.squads.size).toBe(1);
  });

  it('keeps unmatched broadcasts pending on a baseline', () => {
    const pending = [broadcast(2, 3, T0)];
    expect(diffSquads(null, annaLeads(), pending).pending).toEqual(pending);
  });

  it('reports a new squad at poll time when no broadcast arrived', () => {
    const next = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(2, 1), player(3, 2, true)],
      T1,
    );
    expect(diffSquads(annaLeads(), next, []).events).toEqual([
      {
        type: 'squad.created',
        at: T1,
        payload: { ...ALPHA_BASE, squad_id: 2, squad_name: 'Bravo', creator: CLARA },
      },
    ]);
  });

  it('dates a new squad by its earliest broadcast and consumes every duplicate', () => {
    const early = broadcast(2, 3, '2026-09-27T21:00:01.000Z');
    const late = broadcast(2, 3, '2026-09-27T21:00:01.500Z');
    const other = broadcast(5, 4, '2026-09-27T21:00:01.200Z');
    const next = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(2, 1), player(3, 2, true)],
      T1,
    );
    const result = diffSquads(annaLeads(), next, [late, other, early]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.at).toBe(early.at);
    expect(result.pending).toEqual([other]);
  });

  it('fills a missing creator Steam id from the broadcast', () => {
    const next = buildSquadSnapshot(
      [squad(1, 1), { ...squad(2, 3, 'Bravo'), creator_steam_id64: null }],
      [player(1, 1, true), player(2, 1), { ...player(3, 2, true), steam_id64: null }],
      T1,
    );
    const [created] = diffSquads(annaLeads(), next, [broadcast(2, 3, T0)]).events;
    expect(created?.payload.creator.steam_id64).toBe(steam(3));
  });

  it('reports a handoff to a squadmate as passed', () => {
    const next = buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(2, 1, true)], T1);
    expect(diffSquads(annaLeads(), next, []).events).toEqual([
      {
        type: 'squad.leader_changed',
        at: T1,
        payload: { ...ALPHA_BASE, from: ANNA, to: BORIS, reason: 'passed' },
      },
    ]);
  });

  it('reports left_squad when the old leader moved to another squad', () => {
    const prev = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(2, 1), player(3, 2, true)],
      T0,
    );
    const next = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 2), player(2, 1, true), player(3, 2, true)],
      T1,
    );
    const change = diffSquads(prev, next, []).events.find((e) => e.type === 'squad.leader_changed');
    expect(change?.payload).toMatchObject({ reason: 'left_squad', from: ANNA, to: BORIS });
  });

  it('reports left_squad when the old leader is online without a squad', () => {
    const next = buildSquadSnapshot([squad(1, 1)], [player(1, null), player(2, 1, true)], T1);
    expect(diffSquads(annaLeads(), next, []).events[0]?.payload).toMatchObject({
      reason: 'left_squad',
    });
  });

  it('reports disconnected when the old leader is gone from ListPlayers', () => {
    const next = buildSquadSnapshot([squad(1, 1)], [player(2, 1, true)], T1);
    expect(diffSquads(annaLeads(), next, []).events[0]?.payload).toMatchObject({
      reason: 'disconnected',
    });
  });

  it('bridges a leaderless gap: A → nobody → B is one change from A', () => {
    const gap = diffSquads(
      annaLeads(),
      buildSquadSnapshot([squad(1, 1)], [player(1, null), player(2, 1)], T1),
      [],
    );
    expect(gap.events).toEqual([]);
    const after = diffSquads(
      gap.state,
      buildSquadSnapshot([squad(1, 1)], [player(1, null), player(2, 1, true)], T2),
      [],
    );
    expect(after.events).toHaveLength(1);
    expect(after.events[0]?.payload).toMatchObject({ from: ANNA, to: BORIS, reason: 'left_squad' });
  });

  it('reports nothing when the same leader reappears after a leaderless refresh', () => {
    const flicker = diffSquads(
      annaLeads(),
      buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(2, 1)], T1),
      [],
    );
    const back = diffSquads(
      flicker.state,
      buildSquadSnapshot([squad(1, 1)], [player(1, 1, true), player(2, 1)], T2),
      [],
    );
    expect([...flicker.events, ...back.events]).toEqual([]);
  });

  it('reports a reused squad number with another creator as a creation and a disband', () => {
    const next = buildSquadSnapshot(
      [squad(1, 3, 'Bravo')],
      [player(1, null), player(2, null), player(3, 1, true)],
      T1,
    );
    const { events } = diffSquads(annaLeads(), next, []);
    expect(events.map((e) => e.type)).toEqual(['squad.created', 'squad.disbanded']);
    expect(events[0]?.payload.creator).toEqual(CLARA);
    expect(events[1]?.payload.creator).toEqual(ANNA);
  });

  it('reports a disband and whether the creator was still leading', () => {
    const own = diffSquads(
      annaLeads(),
      buildSquadSnapshot([], [player(1, null), player(2, null)], T1),
      [],
    );
    expect(own.events).toEqual([
      {
        type: 'squad.disbanded',
        at: T1,
        payload: { ...ALPHA_BASE, last_leader: ANNA, creator_was_leader: true },
      },
    ]);
    const handedOff = diffSquads(
      annaLeads(),
      buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(2, 1, true)], T1),
      [],
    );
    const later = diffSquads(handedOff.state, buildSquadSnapshot([], [], T2), []);
    expect(later.events[0]?.payload).toMatchObject({
      last_leader: BORIS,
      creator_was_leader: false,
    });
  });

  it('treats every squad of a 3+ squad snapshot vanishing at once as a map change', () => {
    const three = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo'), squad(3, 4, 'Charlie')],
      [player(1, 1, true), player(3, 2, true), player(4, 3, true)],
      T0,
    );
    const result = diffSquads(
      three,
      buildSquadSnapshot([], [player(1, null), player(3, null), player(4, null)], T1),
      [broadcast(9, 5, T0)],
    );
    expect(result).toMatchObject({ events: [], reset: true, pending: [] });
    expect(result.state.squads.size).toBe(0);
  });

  it('still reports disbands when only two squads vanish', () => {
    const two = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(3, 2, true)],
      T0,
    );
    const result = diffSquads(two, buildSquadSnapshot([], [], T1), []);
    expect(result.reset).toBe(false);
    expect(result.events.map((e) => e.type)).toEqual(['squad.disbanded', 'squad.disbanded']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-tracker.test.ts
```

Expected: FAIL. `Failed to load url ../src/squad-tracker.js`.

- [ ] **Step 3: Implement**

Create `apps/workers/rcon/src/squad-tracker.ts`:

```ts
/**
 * Squad history from consecutive roster snapshots (spec:
 * docs/superpowers/specs/2026-09-27-squad-history-design.md §1).
 *
 * RCON reports only squad creation (`squad-broadcast.ts`). Leader changes and
 * disbands are inferred by diffing the `ListSquads` + `ListPlayers` rows of two
 * roster refreshes, so a change faster than one refresh (A → B → C) is seen as
 * A → C. Within a match a squad is `(team_id, squad_id, creator EOS id)`:
 * Squad reuses squad numbers, and a new creator on an old number is a new squad.
 *
 * Pure: `PerServerSupervisor.trackSquads` owns the state between calls, the
 * match-boundary resets, persistence and crowns.
 */
import type {
  SquadCreatedPayload,
  SquadDisbandedPayload,
  SquadLeaderChangedPayload,
  SquadLeaderChangeReason,
  SquadPlayerRef,
} from '@squad/shared-types';
import type { RconPlayer } from './parse-list-players.js';
import type { RconSquad } from './parse-list-squads.js';
import type { SquadCreatedBroadcast } from './squad-broadcast.js';

/**
 * When every squad of a snapshot holding at least this many vanishes in one
 * refresh, the map changed: the tracker resets instead of reporting disbands.
 */
export const MASS_VANISH_MIN_SQUADS = 3;

export interface TrackedSquad {
  teamId: number;
  teamName: string;
  squadId: number;
  name: string;
  creator: SquadPlayerRef;
  /** The player `ListPlayers` flags `Is Leader: True` in this squad, if any. */
  leader: SquadPlayerRef | null;
  /** The most recent non-null leader; bridges a refresh that caught the squad leaderless. */
  lastLeader: SquadPlayerRef | null;
}

export interface PlayerPlacement {
  teamId: number | null;
  squadId: number | null;
}

export interface SquadSnapshot {
  polledAt: string;
  /** Keyed by {@link squadKey}. */
  squads: Map<string, TrackedSquad>;
  /** Every online player by EOS id; used to explain why a leader changed. */
  players: Map<string, PlayerPlacement>;
}

export type SquadEvent =
  | { type: 'squad.created'; at: string; payload: SquadCreatedPayload }
  | { type: 'squad.leader_changed'; at: string; payload: SquadLeaderChangedPayload }
  | { type: 'squad.disbanded'; at: string; payload: SquadDisbandedPayload };

export interface SquadDiff {
  events: SquadEvent[];
  /** The snapshot to pass as `prev` next time. */
  state: SquadSnapshot;
  /** Creation broadcasts no new squad has claimed yet. */
  pending: SquadCreatedBroadcast[];
  /** True when a map change was detected; the caller clears the match's crowns. */
  reset: boolean;
}

/** Identity of a squad within a match. */
export function squadKey(teamId: number, squadId: number, creatorEosId: string): string {
  return `${teamId}:${squadId}:${creatorEosId}`;
}

function playerRef(player: RconPlayer): SquadPlayerRef {
  return { eos_id: player.eos_id, steam_id64: player.steam_id64, name: player.name };
}

/**
 * Builds one refresh's snapshot. A squad whose creator has no EOS id is not
 * tracked, because history and crowns are keyed by EOS id. The leader is the
 * player flagged `Is Leader` with the squad's own team and squad number.
 */
export function buildSquadSnapshot(
  squads: RconSquad[],
  players: RconPlayer[],
  polledAt: string,
): SquadSnapshot {
  const placements = new Map<string, PlayerPlacement>();
  const online = new Map<string, RconPlayer>();
  const leaders = new Map<string, SquadPlayerRef>();
  for (const player of players) {
    placements.set(player.eos_id, { teamId: player.team_id, squadId: player.squad_id });
    online.set(player.eos_id, player);
    if (player.is_leader && player.team_id !== null && player.squad_id !== null) {
      leaders.set(`${player.team_id}:${player.squad_id}`, playerRef(player));
    }
  }

  const tracked = new Map<string, TrackedSquad>();
  for (const squad of squads) {
    const creatorEosId = squad.creator_eos_id;
    if (!creatorEosId) continue;
    const leader = leaders.get(`${squad.team_id}:${squad.squad_id}`) ?? null;
    tracked.set(squadKey(squad.team_id, squad.squad_id, creatorEosId), {
      teamId: squad.team_id,
      teamName: squad.team_name,
      squadId: squad.squad_id,
      name: squad.name,
      creator: {
        eos_id: creatorEosId,
        steam_id64: squad.creator_steam_id64 ?? online.get(creatorEosId)?.steam_id64 ?? null,
        name: squad.creator_name,
      },
      leader,
      lastLeader: leader,
    });
  }
  return { polledAt, squads: tracked, players: placements };
}

function payloadBase(squad: TrackedSquad): SquadCreatedPayload {
  return {
    team_id: squad.teamId,
    team_name: squad.teamName,
    squad_id: squad.squadId,
    squad_name: squad.name,
    creator: squad.creator,
  };
}

function leaveReason(
  from: SquadPlayerRef,
  squad: TrackedSquad,
  next: SquadSnapshot,
): SquadLeaderChangeReason {
  const placement = next.players.get(from.eos_id);
  if (!placement) return 'disconnected';
  const stillHere = placement.teamId === squad.teamId && placement.squadId === squad.squadId;
  return stillHere ? 'passed' : 'left_squad';
}

/**
 * Compares two consecutive snapshots.
 *
 * - `prev === null` (worker start, RCON reconnect, match reset) is a baseline:
 *   `next` is stored and nothing is reported.
 * - Every squad of a `prev` holding {@link MASS_VANISH_MIN_SQUADS}+ squads gone
 *   at once is a map change: baseline, `reset: true`, pending broadcasts dropped.
 * - A new identity is `squad.created`, dated by the earliest matching broadcast
 *   (same squad number and creator EOS id). Every matching broadcast is
 *   consumed, so duplicates never date a later squad.
 * - A different non-null leader on the same identity is `squad.leader_changed`
 *   from the previous leader, or from `lastLeader` across a leaderless refresh.
 * - A vanished identity is `squad.disbanded`.
 *
 * Events come out as creations and leader changes in `next` order, then disbands.
 */
export function diffSquads(
  prev: SquadSnapshot | null,
  next: SquadSnapshot,
  pendingCreated: SquadCreatedBroadcast[],
): SquadDiff {
  if (prev === null) {
    return { events: [], state: next, pending: pendingCreated, reset: false };
  }
  const everySquadVanished = [...prev.squads.keys()].every((key) => !next.squads.has(key));
  if (prev.squads.size >= MASS_VANISH_MIN_SQUADS && everySquadVanished) {
    return { events: [], state: next, pending: [], reset: true };
  }

  const events: SquadEvent[] = [];
  let pending = pendingCreated;
  const squads = new Map<string, TrackedSquad>();

  for (const [key, squad] of next.squads) {
    const before = prev.squads.get(key);
    if (!before) {
      const matching = pending.filter(
        (broadcast) =>
          broadcast.squadId === squad.squadId && broadcast.creatorEosId === squad.creator.eos_id,
      );
      pending = pending.filter((broadcast) => !matching.includes(broadcast));
      const earliest = matching.reduce<SquadCreatedBroadcast | undefined>(
        (first, broadcast) => (!first || broadcast.at < first.at ? broadcast : first),
        undefined,
      );
      const created: TrackedSquad = {
        ...squad,
        creator: {
          ...squad.creator,
          steam_id64: squad.creator.steam_id64 ?? earliest?.creatorSteamId64 ?? null,
        },
      };
      squads.set(key, created);
      events.push({
        type: 'squad.created',
        at: earliest?.at ?? next.polledAt,
        payload: payloadBase(created),
      });
      continue;
    }

    const previousLeader = before.leader ?? before.lastLeader;
    squads.set(key, { ...squad, lastLeader: squad.leader ?? previousLeader });
    if (!squad.leader || !previousLeader || squad.leader.eos_id === previousLeader.eos_id) continue;
    events.push({
      type: 'squad.leader_changed',
      at: next.polledAt,
      payload: {
        ...payloadBase(squad),
        from: previousLeader,
        to: squad.leader,
        reason: leaveReason(previousLeader, squad, next),
      },
    });
  }

  for (const [key, squad] of prev.squads) {
    if (next.squads.has(key)) continue;
    const lastLeader = squad.leader ?? squad.lastLeader;
    events.push({
      type: 'squad.disbanded',
      at: next.polledAt,
      payload: {
        ...payloadBase(squad),
        last_leader: lastLeader,
        creator_was_leader: lastLeader !== null && lastLeader.eos_id === squad.creator.eos_id,
      },
    });
  }

  return { events, state: { ...next, squads }, pending, reset: false };
}
```

- [ ] **Step 4: Run it**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-tracker.test.ts
nice -n 10 pnpm turbo run typecheck --filter=@squad/worker-rcon
nice -n 10 pnpm exec biome check apps/workers/rcon/src/squad-tracker.ts apps/workers/rcon/test/squad-tracker.test.ts
```

Expected: 18 tests PASS. Typecheck and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/rcon/src/squad-tracker.ts apps/workers/rcon/test/squad-tracker.test.ts
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(workers/rcon): infer squad creations, leader changes and disbands from roster diffs" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 4: Pure crown rule — `applySquadEvent` / `crownOf` / `crownBookFromHash`

**Files:**
- Create: `apps/workers/rcon/src/squad-crowns.ts`
- Test (create): `apps/workers/rcon/test/squad-crowns.test.ts`

**Interfaces:**
- Consumes: `SquadEvent` (Task 3), `SquadCrown`, `SquadCrownSquad`, `squadCrownSchema` (Task 1).
- Produces:
  ```ts
  export interface CreatorHistory { color: 'grey' | 'red' | null; squads: SquadCrownSquad[] }
  export type CrownBook = Map<string, CreatorHistory>;
  export function applySquadEvent(book: CrownBook, event: SquadEvent): string | null;
  export function crownOf(history: CreatorHistory): SquadCrown | null;
  export function crownBookFromHash(raw: Record<string, string>): CrownBook;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/workers/rcon/test/squad-crowns.test.ts`:

```ts
import type { SquadLeaderChangeReason, SquadPlayerRef } from '@squad/shared-types';
import { describe, expect, it } from 'vitest';
import {
  applySquadEvent,
  type CrownBook,
  crownBookFromHash,
  crownOf,
} from '../src/squad-crowns.js';
import type { SquadEvent } from '../src/squad-tracker.js';

const ANNA: SquadPlayerRef = { eos_id: 'a'.repeat(32), steam_id64: '76561198000000001', name: 'Anna' };
const IVAN: SquadPlayerRef = { eos_id: 'b'.repeat(32), steam_id64: null, name: 'Ivan' };
const BASE = {
  team_id: 1,
  team_name: 'United States Army',
  squad_id: 1,
  squad_name: 'Alpha',
  creator: ANNA,
};
const AT_0404 = '2026-09-27T21:04:00.000Z';
const AT_0410 = '2026-09-27T21:10:00.000Z';
const AT_0412 = '2026-09-27T21:12:00.000Z';
const AT_0415 = '2026-09-27T21:15:00.000Z';

const created = (at: string): SquadEvent => ({ type: 'squad.created', at, payload: BASE });
const changed = (
  from: SquadPlayerRef,
  to: SquadPlayerRef,
  reason: SquadLeaderChangeReason,
  at: string,
): SquadEvent => ({ type: 'squad.leader_changed', at, payload: { ...BASE, from, to, reason } });
const disbanded = (lastLeader: SquadPlayerRef | null, at: string): SquadEvent => ({
  type: 'squad.disbanded',
  at,
  payload: {
    ...BASE,
    last_leader: lastLeader,
    creator_was_leader: lastLeader?.eos_id === ANNA.eos_id,
  },
});

function fold(events: SquadEvent[]): CrownBook {
  const book: CrownBook = new Map();
  for (const event of events) applySquadEvent(book, event);
  return book;
}

function annasCrown(book: CrownBook) {
  const history = book.get(ANNA.eos_id);
  return history ? crownOf(history) : null;
}

describe('crown rule', () => {
  it('gives no crown to a creator who never gave up command', () => {
    const book = fold([created(AT_0404)]);
    expect(annasCrown(book)).toBeNull();
    expect(book.get(ANNA.eos_id)?.squads).toHaveLength(1);
  });

  it('turns grey after handing command to a squadmate', () => {
    expect(annasCrown(fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410)]))).toEqual({
      color: 'grey',
      squads: [
        {
          squad_name: 'Alpha',
          team_id: 1,
          squad_id: 1,
          created_at: AT_0404,
          handoffs: [{ to_name: 'Ivan', reason: 'passed', at: AT_0410 }],
          disbanded_at: null,
          abandoned_at: null,
        },
      ],
    });
  });

  it.each(['left_squad', 'disconnected'] as const)(
    'turns red when the creator gives up command by %s',
    (reason) => {
      const crown = annasCrown(fold([created(AT_0404), changed(ANNA, IVAN, reason, AT_0412)]));
      expect(crown?.color).toBe('red');
      expect(crown?.squads[0]?.abandoned_at).toBe(AT_0412);
    },
  );

  it('turns red when the squad disbands under its creator', () => {
    const crown = annasCrown(fold([created(AT_0404), disbanded(ANNA, AT_0412)]));
    expect(crown).toMatchObject({
      color: 'red',
      squads: [{ disbanded_at: AT_0412, abandoned_at: AT_0412 }],
    });
  });

  it('keeps grey when the squad disbands under someone else, and dates the disband', () => {
    const crown = annasCrown(
      fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410), disbanded(IVAN, AT_0412)]),
    );
    expect(crown).toMatchObject({
      color: 'grey',
      squads: [{ disbanded_at: AT_0412, abandoned_at: null }],
    });
  });

  it('lets red override grey', () => {
    const crown = annasCrown(
      fold([
        created(AT_0404),
        changed(ANNA, IVAN, 'passed', AT_0410),
        changed(IVAN, ANNA, 'passed', AT_0412),
        disbanded(ANNA, AT_0415),
      ]),
    );
    expect(crown?.color).toBe('red');
  });

  it('keeps grey when the creator gets command back', () => {
    const book = fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410)]);
    expect(applySquadEvent(book, changed(IVAN, ANNA, 'passed', AT_0412))).toBeNull();
    expect(annasCrown(book)?.color).toBe('grey');
  });

  it('ignores a change of command that does not start at the creator', () => {
    const book: CrownBook = new Map();
    expect(applySquadEvent(book, changed(IVAN, ANNA, 'passed', AT_0410))).toBeNull();
    expect(book.size).toBe(0);
  });

  it('tells the caller which creator changed', () => {
    expect(applySquadEvent(new Map(), created(AT_0404))).toBe(ANNA.eos_id);
  });

  it('opens a record without a creation time for a squad created before tracking started', () => {
    const crown = annasCrown(fold([changed(ANNA, IVAN, 'passed', AT_0410)]));
    expect(crown?.squads[0]).toMatchObject({ squad_name: 'Alpha', created_at: null });
  });

  it('restores the book from the Redis hash and skips unreadable fields', () => {
    const stored = annasCrown(fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410)]));
    const book = crownBookFromHash({
      [ANNA.eos_id]: JSON.stringify(stored),
      broken: '{',
      wrong: JSON.stringify({ color: 'gold', squads: [] }),
    });
    expect([...book.keys()]).toEqual([ANNA.eos_id]);
    expect(annasCrown(book)).toEqual(stored);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-crowns.test.ts
```

Expected: FAIL. `Failed to load url ../src/squad-crowns.js`.

- [ ] **Step 3: Implement**

Create `apps/workers/rcon/src/squad-crowns.ts`:

```ts
/**
 * Creator crowns for the live roster (spec:
 * docs/superpowers/specs/2026-09-27-squad-history-design.md §1 "Crown rule").
 *
 * Folds `squad.*` events into one history per squad creator (EOS id) for the
 * current match:
 * - grey: the creator handed command to someone while staying in the squad;
 * - red: the creator left the squad or disconnected while leading it, or the
 *   squad disbanded under them.
 * Red overrides grey. Getting command back never clears a crown, and a creator
 * who never gave up command has no crown.
 *
 * The book is in-memory in `PerServerSupervisor` and mirrored into
 * `rcon:squad-crowns:{serverId}` (only creators with a crown).
 */
import {
  type SquadCrown,
  type SquadCrownSquad,
  squadCrownSchema,
} from '@squad/shared-types';
import type { SquadEvent } from './squad-tracker.js';

export interface CreatorHistory {
  color: SquadCrown['color'] | null;
  squads: SquadCrownSquad[];
}

/** Creator EOS id → history, for the current match. */
export type CrownBook = Map<string, CreatorHistory>;

function historyFor(book: CrownBook, eosId: string): CreatorHistory {
  const existing = book.get(eosId);
  if (existing) return existing;
  const history: CreatorHistory = { color: null, squads: [] };
  book.set(eosId, history);
  return history;
}

/**
 * The creator's live record of the squad an event is about. A squad that
 * already existed when tracking started (worker restart, baseline) gets its
 * record on first use, with an unknown creation time.
 */
function squadRecord(
  history: CreatorHistory,
  squad: { team_id: number; squad_id: number; squad_name: string },
): SquadCrownSquad {
  const existing = history.squads.findLast(
    (record) =>
      record.team_id === squad.team_id &&
      record.squad_id === squad.squad_id &&
      record.disbanded_at === null,
  );
  if (existing) {
    existing.squad_name = squad.squad_name;
    return existing;
  }
  const record: SquadCrownSquad = {
    squad_name: squad.squad_name,
    team_id: squad.team_id,
    squad_id: squad.squad_id,
    created_at: null,
    handoffs: [],
    disbanded_at: null,
    abandoned_at: null,
  };
  history.squads.push(record);
  return record;
}

/**
 * Applies one event to the book in place.
 *
 * @returns The EOS id of the creator whose history changed, or `null` when the
 *   event is a change of command that did not start at the squad's creator.
 */
export function applySquadEvent(book: CrownBook, event: SquadEvent): string | null {
  const creatorEosId = event.payload.creator.eos_id;
  switch (event.type) {
    case 'squad.created': {
      historyFor(book, creatorEosId).squads.push({
        squad_name: event.payload.squad_name,
        team_id: event.payload.team_id,
        squad_id: event.payload.squad_id,
        created_at: event.at,
        handoffs: [],
        disbanded_at: null,
        abandoned_at: null,
      });
      return creatorEosId;
    }
    case 'squad.leader_changed': {
      if (event.payload.from.eos_id !== creatorEosId) return null;
      const history = historyFor(book, creatorEosId);
      const record = squadRecord(history, event.payload);
      record.handoffs.push({ to_name: event.payload.to.name, reason: event.payload.reason, at: event.at });
      if (event.payload.reason === 'passed') {
        history.color = history.color ?? 'grey';
      } else {
        history.color = 'red';
        record.abandoned_at = event.at;
      }
      return creatorEosId;
    }
    case 'squad.disbanded': {
      const history = historyFor(book, creatorEosId);
      const record = squadRecord(history, event.payload);
      record.disbanded_at = event.at;
      if (event.payload.creator_was_leader) {
        history.color = 'red';
        record.abandoned_at = event.at;
      }
      return creatorEosId;
    }
  }
}

/** The crown to publish for a creator, or `null` while they have none. */
export function crownOf(history: CreatorHistory): SquadCrown | null {
  if (history.color === null) return null;
  return { color: history.color, squads: history.squads };
}

/**
 * Rebuilds the book from `HGETALL rcon:squad-crowns:{serverId}` after a worker
 * restart. A field that is not valid JSON or does not match the contract is
 * dropped, and that creator starts over.
 */
export function crownBookFromHash(raw: Record<string, string>): CrownBook {
  const book: CrownBook = new Map();
  for (const [eosId, value] of Object.entries(raw)) {
    try {
      const parsed = squadCrownSchema.safeParse(JSON.parse(value));
      if (parsed.success) book.set(eosId, { color: parsed.data.color, squads: parsed.data.squads });
    } catch {
      // unreadable field: the creator's history restarts empty
    }
  }
  return book;
}
```

- [ ] **Step 4: Run it**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-crowns.test.ts
nice -n 10 pnpm turbo run typecheck --filter=@squad/worker-rcon
nice -n 10 pnpm exec biome check --write apps/workers/rcon/src/squad-crowns.ts apps/workers/rcon/test/squad-crowns.test.ts
```

Expected: 12 tests PASS. Typecheck and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/rcon/src/squad-crowns.ts apps/workers/rcon/test/squad-crowns.test.ts
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(workers/rcon): grey and red creator crowns from squad events" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 5: Wire squad history into `PerServerSupervisor`

**Files:**
- Modify: `apps/workers/rcon/src/supervisor.ts`:
  - line 14 (shared-types import) and after line 34 (new imports)
  - after line 51 (broadcast TTL constant)
  - lines 191–201 (`RconSupervisor.hint`)
  - after line 252 (fields)
  - lines 261–269 (`start`) and after line 284 (`loadPriorCrowns`)
  - after line 603 (new methods `trackSquads`, `emitSquadEvent`, `writeCrowns`, `clearCrowns`)
  - lines 605–621 (`ingestBroadcast`)
  - line 683 (reconnect baseline)
  - lines 844–861 (`requestRefresh`)
  - lines 887–895 (doc comment) and line 913 (`refreshRoster`)
  - line 1003 (full poll)
- Modify: `apps/workers/rcon/src/index.ts` — line 94
- Test (create): `apps/workers/rcon/test/squad-history.integration.test.ts`

**Interfaces:**
- Consumes: `parseSquadCreatedBroadcast`, `SquadCreatedBroadcast` (Task 2); `buildSquadSnapshot`, `diffSquads`, `SquadEvent`, `SquadSnapshot` (Task 3); `applySquadEvent`, `crownOf`, `crownBookFromHash`, `CrownBook` (Task 4); `squadCrownsKey`, `SQUAD_CROWNS_TTL_SECONDS`, `STREAM_NAME`, `EventEnvelope` (Task 1); `events` table from `@squad/db`.
- Produces:
  ```ts
  RconSupervisor.hint(serverId: string, scopes: RconRefreshScope[], reason?: string): boolean;
  PerServerSupervisor.requestRefresh(scopes: RconRefreshScope[], reason?: string): void;
  // Redis: HSET rcon:squad-crowns:{serverId} <creatorEos> <SquadCrown JSON>, EXPIRE 21600; DEL on match reset
  // Stream: XADD events:server:{id} MAXLEN ~ 10000 * envelope <EventEnvelope{type: 'squad.*', actor: {kind: 'player', id: eos}}>
  // Postgres: events rows kind='squad.*', actor_kind='player', actor_id=<eos>
  ```

- [ ] **Step 1: Write the failing integration test**

Create `apps/workers/rcon/test/squad-history.integration.test.ts`:

```ts
/**
 * Squad history end to end: a fake Squad server whose roster the test
 * rewrites, a real supervisor, and real Redis and Postgres. It proves the
 * tracker is wired into the roster refresh (events land in `events` and the
 * server stream, crowns land in `rcon:squad-crowns:{id}`) and that the
 * no-false-event rules hold across a worker restart and a round end.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { events, servers } from '@squad/db/schema';
import {
  type EventEnvelope,
  eventEnvelope,
  STREAM_NAME,
  squadCrownsKey,
  validatePayload,
} from '@squad/shared-types';
import { and, asc, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_CHAT_VALUE,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';
import { RconSupervisor, type Target } from '../src/supervisor.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const describeIfInfra = DATABASE_URL && REDIS_URL ? describe : describe.skip;

interface GamePlayer {
  eos: string;
  steam: string;
  name: string;
  team: number;
  squad: number | null;
  leader: boolean;
}

interface GameSquad {
  team: number;
  id: number;
  name: string;
  creator: GamePlayer;
}

function gamePlayer(name: string, squad: number | null, leader = false): GamePlayer {
  const steamTail = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return {
    eos: randomBytes(16).toString('hex'),
    steam: `7656119${steamTail}`,
    name,
    team: 1,
    squad,
    leader,
  };
}

const game: { players: GamePlayer[]; squads: GameSquad[] } = { players: [], squads: [] };
const commands: string[] = [];
const sockets: Socket[] = [];

function listPlayers(): string {
  return [
    '----- Active Players -----',
    ...game.players.map(
      (p, i) =>
        `ID: ${i} | Online IDs: EOS: ${p.eos} steam: ${p.steam} | Name: ${p.name} | Team ID: ${p.team} | Squad ID: ${p.squad ?? 'N/A'} | Is Leader: ${p.leader ? 'True' : 'False'} | Role: USA_Rifleman_01`,
    ),
    '----- Recently Disconnected Players [Max of 15] -----',
  ].join('\n');
}

function listSquads(): string {
  const lines: string[] = [];
  const teams = [
    [1, 'United States Army'],
    [2, 'Russian Ground Forces'],
  ] as const;
  for (const [team, teamName] of teams) {
    lines.push(`Team ID: ${team} (${teamName})`);
    for (const s of game.squads.filter((squad) => squad.team === team)) {
      lines.push(
        `ID: ${s.id} | Name: ${s.name} | Size: 1 | Locked: False | Creator Name: ${s.creator.name} | Creator Online IDs: EOS: ${s.creator.eos} steam: ${s.creator.steam}`,
      );
    }
  }
  return lines.join('\n');
}

function startGameServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      const stream = new RconPacketStream();
      const reply = (id: number, body: string, type = SERVERDATA_RESPONSE_VALUE) => {
        if (!sock.destroyed) sock.write(encodePacket({ id, type, body }));
      };
      sock.on('error', () => undefined);
      sock.on('data', (chunk) => {
        for (const packet of stream.push(chunk)) {
          if (packet.type === SERVERDATA_AUTH) {
            reply(packet.id, '');
            reply(packet.id, '', SERVERDATA_AUTH_RESPONSE);
            sockets.push(sock);
            continue;
          }
          if (packet.type !== SERVERDATA_EXECCOMMAND) continue;
          if (packet.body !== '') commands.push(packet.body);
          if (packet.body === 'ListPlayers') reply(packet.id, listPlayers());
          else if (packet.body === 'ListSquads') reply(packet.id, listSquads());
          else reply(packet.id, '');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function broadcast(body: string): void {
  for (const sock of sockets) {
    if (!sock.destroyed) sock.write(encodePacket({ id: 0, type: SERVERDATA_CHAT_VALUE, body }));
  }
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

const count = (command: string) => commands.filter((c) => c === command).length;

async function waitFor(probe: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;
let redis: Redis;
let server: Server;
let target: Target;
let supervisor: RconSupervisor;
const serverId = randomUUID();

const anna = gamePlayer('Anna', 1, true);
const boris = gamePlayer('Boris', 1);
const clara = gamePlayer('Clara', 2, true);
const dana = gamePlayer('Dana', 1, true);

/**
 * Starts a supervisor and waits until its connect-time refresh finished: the
 * worker reads server info only after the roster (and squad tracking) is done.
 */
async function connect(): Promise<void> {
  const before = count('ShowServerInfo');
  supervisor = new RconSupervisor({
    db,
    redis,
    log: makeLogger(),
    pollIntervalMs: 600_000,
    rosterIntervalMs: 600_000,
    infoIntervalMs: 600_000,
    hintDebounceMs: 5,
    hintFollowUpMs: 600_000,
  });
  await supervisor.reconcile([target]);
  await waitFor(() => count('ShowServerInfo') > before);
}

/** One hinted roster refresh, finished (tracking included) when server info is read. */
async function refresh(reason?: string): Promise<void> {
  const before = count('ShowServerInfo');
  expect(supervisor.hint(serverId, ['roster', 'info'], reason)).toBe(true);
  await waitFor(() => count('ShowServerInfo') > before);
}

function squadEvents() {
  return db
    .select()
    .from(events)
    .where(and(eq(events.serverId, serverId), like(events.kind, 'squad.%')))
    .orderBy(asc(events.occurredAt));
}

async function crown(eosId: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.hget(squadCrownsKey(serverId), eosId);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  sql = postgres(DATABASE_URL, { max: 4, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await db.insert(servers).values({
    id: serverId,
    displayName: 'Squad History Test Server',
    slug: `squad-history-${randomBytes(4).toString('hex')}`,
  });
  const started = await startGameServer();
  server = started.server;
  target = {
    serverId,
    host: '127.0.0.1',
    port: started.port,
    queryPort: started.port + 1000,
    password: 'pw',
  };
});

afterAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  await supervisor?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await redis.del(
    `rcon:status:${serverId}`,
    `rcon:roster:${serverId}`,
    `rcon:squads:${serverId}`,
    `rcon:commands:${serverId}`,
    squadCrownsKey(serverId),
    STREAM_NAME.eventsServer(serverId),
  );
  await db.delete(servers).where(eq(servers.id, serverId));
  await redis.quit();
  await sql.end();
});

describeIfInfra('squad history through the RCON supervisor', () => {
  it('records the first roster as a baseline without events', async () => {
    game.players = [anna, boris];
    game.squads = [{ team: 1, id: 1, name: 'Alpha', creator: anna }];
    await connect();
    expect(await squadEvents()).toEqual([]);
  });

  it('records a handoff to a squadmate and gives the creator a grey crown', async () => {
    anna.leader = false;
    boris.leader = true;
    await refresh();

    const rows = await squadEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'squad.leader_changed',
      actorKind: 'player',
      actorId: anna.eos,
      payload: {
        squad_name: 'Alpha',
        reason: 'passed',
        from: { eos_id: anna.eos },
        to: { eos_id: boris.eos },
      },
    });
    expect(await crown(anna.eos)).toMatchObject({
      color: 'grey',
      squads: [{ squad_name: 'Alpha', handoffs: [{ to_name: 'Boris', reason: 'passed' }] }],
    });
    expect(await redis.ttl(squadCrownsKey(serverId))).toBeGreaterThan(0);
  });

  it('dates a new squad by its RCON creation broadcast', async () => {
    broadcast(
      `Clara (Online IDs: EOS: ${clara.eos} steam: ${clara.steam}) has created Squad 2 (Squad Name: Bravo) on United States Army`,
    );
    await sleep(200);
    const hintedAt = new Date();
    game.players.push(clara);
    game.squads.push({ team: 1, id: 2, name: 'Bravo', creator: clara });
    await refresh();

    const created = (await squadEvents()).find((row) => row.kind === 'squad.created');
    expect(created).toMatchObject({
      actorId: clara.eos,
      payload: { squad_name: 'Bravo', squad_id: 2, creator: { eos_id: clara.eos, steam_id64: clara.steam } },
    });
    expect(created?.occurredAt.getTime()).toBeLessThan(hintedAt.getTime());
    expect(await crown(clara.eos)).toBeNull();
  });

  it('turns the crown red when the creator disconnects while leading and the squad disbands', async () => {
    game.players = game.players.filter((p) => p !== clara);
    game.squads = game.squads.filter((s) => s.creator !== clara);
    await refresh();

    const disband = (await squadEvents()).find((row) => row.kind === 'squad.disbanded');
    expect(disband).toMatchObject({
      actorId: clara.eos,
      payload: { creator_was_leader: true, last_leader: { eos_id: clara.eos } },
    });
    const claraCrown = await crown(clara.eos);
    expect(claraCrown?.color).toBe('red');
    expect(claraCrown).toMatchObject({
      squads: [{ disbanded_at: expect.any(String), abandoned_at: expect.any(String) }],
    });
  });

  it('publishes envelopes every stream consumer accepts', async () => {
    const entries = (await redis.xrange(STREAM_NAME.eventsServer(serverId), '-', '+')) as Array<
      [string, string[]]
    >;
    const envelopes = entries
      .map(([, fields]) => JSON.parse(fields[fields.indexOf('envelope') + 1] ?? 'null') as EventEnvelope)
      .filter((envelope) => envelope.type.startsWith('squad.'));
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      'squad.leader_changed',
      'squad.created',
      'squad.disbanded',
    ]);
    for (const envelope of envelopes) {
      expect(eventEnvelope.safeParse(envelope).success).toBe(true);
      expect(validatePayload(envelope.type, envelope.payload)).toMatchObject({ ok: true });
    }
  });

  it('starts from a baseline after a restart and extends the restored crowns', async () => {
    await supervisor.stop();
    const before = (await squadEvents()).length;
    await connect();
    expect(await squadEvents()).toHaveLength(before);

    boris.leader = false;
    anna.leader = true;
    await refresh();
    game.players = game.players.filter((p) => p !== anna);
    boris.leader = true;
    await refresh();

    const last = (await squadEvents()).at(-1);
    expect(last).toMatchObject({
      kind: 'squad.leader_changed',
      actorId: anna.eos,
      payload: { reason: 'disconnected' },
    });
    const annaCrown = (await crown(anna.eos)) as {
      color: string;
      squads: Array<{ handoffs: Array<{ reason: string }> }>;
    } | null;
    expect(annaCrown?.color).toBe('red');
    expect(annaCrown?.squads[0]?.handoffs.map((h) => h.reason)).toEqual(['passed', 'disconnected']);
  });

  it("clears crowns at round end and reports no disbands when the old map's squads vanish", async () => {
    await refresh('match.ended');
    expect(await redis.exists(squadCrownsKey(serverId))).toBe(0);
    const disbands = async () =>
      (await squadEvents()).filter((row) => row.kind === 'squad.disbanded').length;
    const disbandsBefore = await disbands();

    game.squads = [];
    for (const p of game.players) {
      p.squad = null;
      p.leader = false;
    }
    await refresh();
    expect(await disbands()).toBe(disbandsBefore);

    game.players.push(dana);
    game.squads.push({ team: 1, id: 1, name: 'Charlie', creator: dana });
    await refresh();
    expect(
      (await squadEvents()).some((row) => row.kind === 'squad.created' && row.actorId === dana.eos),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-history.integration.test.ts
```

Expected: FAIL. The baseline case passes. `records a handoff…` fails with `expected [] to have a length of 1`, because the supervisor does not track squads yet. The later cases fail the same way.

- [ ] **Step 3: Implement the supervisor wiring**

In `apps/workers/rcon/src/supervisor.ts`:

(a) Replace line 14 with:

```ts
import {
  CONSUMER_GROUP,
  type EventEnvelope,
  SQUAD_CROWNS_TTL_SECONDS,
  STREAM_NAME,
  squadCrownsKey,
} from '@squad/shared-types';
```

Add these imports after `import { computeSeedingTick, isSeedLayer, type SeedingState } from './seeding.js';`:

```ts
import { parseSquadCreatedBroadcast, type SquadCreatedBroadcast } from './squad-broadcast.js';
import { applySquadEvent, type CrownBook, crownBookFromHash, crownOf } from './squad-crowns.js';
import {
  buildSquadSnapshot,
  diffSquads,
  type SquadEvent,
  type SquadSnapshot,
} from './squad-tracker.js';
```

(b) After `const DEFAULT_HINT_FOLLOW_UP_MS = 1_500;` add:

```ts
/** A squad-creation broadcast waits this long for the roster refresh that first lists its squad. */
const SQUAD_BROADCAST_TTL_MS = 10_000;
```

(c) Replace `RconSupervisor.hint` (lines 191–201):

```ts
  /**
   * Routes a refresh hint (see `RCON_REFRESH_CHANNEL`) to the server's
   * supervisor. `reason` is the log event that caused it; `match.started` and
   * `match.ended` also reset the server's squad history. Returns false when
   * this worker does not poll that server (it is stopped, or its hint raced a
   * reconcile) and the hint is dropped.
   */
  hint(serverId: string, scopes: RconRefreshScope[], reason?: string): boolean {
    const sup = this.supervisors.get(serverId);
    if (!sup) return false;
    sup.requestRefresh(scopes, reason);
    return true;
  }
```

(d) After `private readonly layerIsSeedCache = new Map<string, boolean | null>();` add:

```ts
  /**
   * Squad history (see `squad-tracker.ts`). `squadState` is the previous
   * refresh's snapshot; `null` makes the next refresh a baseline (worker start,
   * RCON reconnect, match reset).
   */
  private squadState: SquadSnapshot | null = null;
  /** Set by a `match.started`/`match.ended` hint; consumed by the next {@link trackSquads}. */
  private squadResetPending = false;
  /**
   * Set by `match.ended`: every snapshot stays a baseline until one lists no
   * squads (the next map loaded) or `match.started` arrives, so the old map's
   * squads vanishing is never reported as disbands.
   */
  private squadHoldUntilEmpty = false;
  /** Parsed creation broadcasts waiting for the refresh that lists their squad. */
  private pendingSquadBroadcasts: SquadCreatedBroadcast[] = [];
  /** Current match's creator histories, mirrored into `rcon:squad-crowns:{id}`. */
  private crownBook: CrownBook = new Map();
```

(e) In `start()`, after `await this.loadPriorSeedingState();` add `await this.loadPriorCrowns();`. After the `loadPriorSeedingState` method add:

```ts
  /**
   * Restores the current match's crowns after a worker restart so a creator's
   * later handoffs extend the stored entry instead of replacing it.
   * Best-effort: a missing or unreadable hash starts the match history empty.
   */
  private async loadPriorCrowns(): Promise<void> {
    try {
      this.crownBook = crownBookFromHash(
        await this.opts.redis.hgetall(squadCrownsKey(this.target.serverId)),
      );
    } catch {
      this.crownBook = new Map();
    }
  }
```

(f) Insert these methods before the doc comment `Handle one unsolicited RCON packet.` (right after `tickSeeding`):

```ts
  /**
   * Turns this refresh's `ListSquads` + `ListPlayers` into squad history:
   * persists each `squad.*` event and keeps `rcon:squad-crowns:{id}` current.
   * Never throws: squad history is a moderation aid and must not cost the
   * roster its refresh.
   *
   * A `match.started`/`match.ended` hint clears the crowns and makes this
   * snapshot a baseline; after `match.ended` snapshots stay baselines until one
   * lists no squads (see {@link squadHoldUntilEmpty}). The broadcast queue is
   * filtered, diffed and replaced without an `await` in between, so a
   * broadcast arriving meanwhile is never lost.
   */
  private async trackSquads(
    squads: RconSquad[],
    players: RconPlayer[],
    polledAt: string,
  ): Promise<void> {
    try {
      if (this.squadResetPending) {
        this.squadResetPending = false;
        this.squadState = null;
        this.pendingSquadBroadcasts = [];
        await this.clearCrowns();
      }
      if (this.squadHoldUntilEmpty) {
        this.squadState = null;
        if (squads.length === 0) this.squadHoldUntilEmpty = false;
      }
      const cutoff = Date.parse(polledAt) - SQUAD_BROADCAST_TTL_MS;
      const fresh = this.pendingSquadBroadcasts.filter(
        (broadcast) => Date.parse(broadcast.at) >= cutoff,
      );
      const diff = diffSquads(this.squadState, buildSquadSnapshot(squads, players, polledAt), fresh);
      this.squadState = diff.state;
      this.pendingSquadBroadcasts = diff.pending;
      if (diff.reset) {
        await this.clearCrowns();
        return;
      }
      const changedCreators = new Set<string>();
      for (const event of diff.events) {
        await this.emitSquadEvent(event);
        const creator = applySquadEvent(this.crownBook, event);
        if (creator) changedCreators.add(creator);
      }
      await this.writeCrowns(changedCreators);
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, serverId: this.target.serverId },
        'squad tracking failed',
      );
    }
  }

  /**
   * Publishes one squad lifecycle event the way {@link emitSeedingTransition}
   * does: XADD to the server stream and a direct `events` insert, because
   * stream events are otherwise never persisted. `actor_id` is the EOS id of
   * the player the event is about (the creator, or the leader who gave up
   * command), so `events_actor_occurred_idx` serves per-player lookups.
   */
  private async emitSquadEvent(event: SquadEvent): Promise<void> {
    const eventId = uuidv7();
    const actorId =
      event.type === 'squad.leader_changed'
        ? event.payload.from.eos_id
        : event.payload.creator.eos_id;
    const envelope: EventEnvelope = {
      event_id: eventId,
      version: 1,
      type: event.type,
      server_id: this.target.serverId,
      ts: event.at,
      actor: { kind: 'player', id: actorId },
      correlation_id: null,
      payload: event.payload,
    };
    try {
      await this.opts.redis.xadd(
        STREAM_NAME.eventsServer(this.target.serverId),
        'MAXLEN',
        '~',
        '10000',
        '*',
        'envelope',
        JSON.stringify(envelope),
      );
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message, type: event.type }, 'event publish failed');
    }
    try {
      await this.opts.db
        .insert(events)
        .values({
          eventId,
          serverId: this.target.serverId,
          occurredAt: new Date(event.at),
          kind: event.type,
          version: 1,
          actorKind: 'player',
          actorId,
          correlationId: null,
          payload: event.payload,
        })
        .onConflictDoNothing({ target: [events.eventId, events.occurredAt] });
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, type: event.type },
        'squad event persist failed',
      );
    }
  }

  /** Writes the crowns of `creators` that have one and refreshes the hash TTL. */
  private async writeCrowns(creators: ReadonlySet<string>): Promise<void> {
    const fields: Record<string, string> = {};
    for (const eosId of creators) {
      const history = this.crownBook.get(eosId);
      const crown = history ? crownOf(history) : null;
      if (crown) fields[eosId] = JSON.stringify(crown);
    }
    if (Object.keys(fields).length === 0) return;
    const key = squadCrownsKey(this.target.serverId);
    await this.opts.redis.hset(key, fields);
    await this.opts.redis.expire(key, SQUAD_CROWNS_TTL_SECONDS);
  }

  /** Forgets the match's crowns, in memory and in Redis. */
  private async clearCrowns(): Promise<void> {
    this.crownBook = new Map();
    await this.opts.redis.del(squadCrownsKey(this.target.serverId));
  }
```

(g) Replace the start of `ingestBroadcast` and its comment (lines 605–621) as follows. The chat-queue body from `this.chatQueue = this.chatQueue` onward stays unchanged:

```ts
  /**
   * Handle one unsolicited RCON packet.
   *
   * A squad-creation notice is queued for the next roster refresh, which dates
   * the new squad by it (see {@link trackSquads}). Squad delivers in-game chat
   * only this way (it is not in SquadGame.log), so this is the sole live-chat
   * producer for a running server. Other broadcasts (admin camera, kicks)
   * parse to null and are ignored.
   *
   * Chat ingestion is queued rather than fired off per packet: each message
   * costs several identity queries plus an insert, and a chat flood would
   * otherwise open them all at once and let the archive rows land out of
   * order. The queue is per server and never awaited by the caller, so a slow
   * database cannot stall the socket's read loop or the poll timers.
   */
  private ingestBroadcast(body: string): void {
    const receivedAt = new Date().toISOString();
    const squadCreated = parseSquadCreatedBroadcast(body, receivedAt);
    if (squadCreated) {
      this.pendingSquadBroadcasts.push(squadCreated);
      return;
    }
    const chat = parseRconChatLine(body, receivedAt);
    if (!chat) return;
```

(h) In `connectLoop`, replace `this.lastKitAccrualAt = null;` (line 683) with:

```ts
        this.lastKitAccrualAt = null;
        // Squads may have changed while the connection was down: the first
        // refresh on this connection is a baseline, never a burst of events.
        this.squadState = null;
```

(i) Replace `requestRefresh` (doc and signature, lines 844–861):

```ts
  /**
   * Asks for an out-of-band refresh because something just changed: a log
   * line announced a join, a leave or a new match, or the connection just
   * came up. Hints inside `hintDebounceMs` share one RCON round-trip; if a
   * timer holds the client, the hint waits for it rather than being dropped.
   * A roster hint is repeated once after `hintFollowUpMs` (see
   * {@link DEFAULT_HINT_FOLLOW_UP_MS}). `reason` `match.ended` /
   * `match.started` also resets squad history (see {@link trackSquads}), even
   * while disconnected. Otherwise a no-op while disconnected: the connect path
   * requests a full refresh itself.
   */
  requestRefresh(scopes: RconRefreshScope[], reason?: string): void {
    if (reason === 'match.ended') {
      this.squadResetPending = true;
      this.squadHoldUntilEmpty = true;
    } else if (reason === 'match.started') {
      this.squadResetPending = true;
      this.squadHoldUntilEmpty = false;
    }
    if (!this.client || this.stopped) return;
    for (const scope of scopes) this.pendingHints.add(scope);
    if (this.hintTimer) return;
    this.hintTimer = setTimeout(
      () => void this.drainHints(),
      this.opts.hintDebounceMs ?? DEFAULT_HINT_DEBOUNCE_MS,
    );
  }
```

(j) In the `scheduleRosterRefresh` doc comment, replace "It deliberately does NOT touch the database, kit time, seeding or A2S:" with "Apart from the rare squad lifecycle event ({@link trackSquads}) it deliberately does NOT touch the database, kit time, seeding or A2S:". In `refreshRoster`, replace:

```ts
      await this.writeSquads(squads, polledAt);
      if (this.client && !this.stopped) {
```

with:

```ts
      await this.writeSquads(squads, polledAt);
      await this.trackSquads(squads, players, polledAt);
      if (this.client && !this.stopped) {
```

(k) In `schedulePoll`, replace:

```ts
        await this.writeSquads(squads, polledAt);
        const pollMs = Date.now() - start;
```

with:

```ts
        await this.writeSquads(squads, polledAt);
        await this.trackSquads(squads, players, polledAt);
        const pollMs = Date.now() - start;
```

In `apps/workers/rcon/src/index.ts`, replace line 94 with `supervisor.hint(hint.server_id, hint.scopes, hint.reason);`.

- [ ] **Step 4: Run the integration test and every supervisor suite**

```bash
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/squad-history.integration.test.ts
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run test/supervisor.test.ts test/supervisor-live.test.ts test/supervisor-diag.test.ts test/supervisor-sessions.integration.test.ts test/chat-broadcast.integration.test.ts test/index-import.test.ts test/kit-time.integration.test.ts
nice -n 10 pnpm turbo run typecheck --filter=@squad/worker-rcon
nice -n 10 pnpm exec biome check --write apps/workers/rcon/src/supervisor.ts apps/workers/rcon/src/index.ts apps/workers/rcon/test/squad-history.integration.test.ts
```

Expected: all 7 integration cases PASS. The existing suites PASS unchanged: their Redis mocks have no `hgetall`/`hset`/`del`, so crown I/O fails inside the `try` blocks and is swallowed. Typecheck and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/rcon/src/supervisor.ts apps/workers/rcon/src/index.ts apps/workers/rcon/test/squad-history.integration.test.ts
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(workers/rcon): persist squad history events and creator crowns from roster refreshes" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 6: Roster API — `squad_crown` per player

**Files:**
- Modify: `apps/api/src/lib/roster.ts` — line 1 (imports), lines 45–56 (`RosterApiEntry`), after line 103 (`parseStoredCrowns`), lines 149–184 (`buildRosterResponse`)
- Modify: `apps/api/src/routes/server-roster.ts` — lines 1–11 (imports), lines 24–52 (handler)
- Test: `apps/api/test/roster-lib.test.ts` (extend the import at lines 2–12, add a describe and two `it`s)
- Test: `apps/api/test/integration/server-roster.test.ts` (extend the imports, add two `it`s)

**Interfaces:**
- Consumes: `squadCrownSchema`, `SquadCrown`, `squadCrownsKey` (Task 1); `rcon:squad-crowns:{id}` written by Task 5.
- Produces:
  ```ts
  export interface RosterApiEntry { /* existing fields */ squad_crown: SquadCrown | null }
  export function parseStoredCrowns(raw: Record<string, string> | null): Map<string, SquadCrown>;
  export function buildRosterResponse(stored: StoredRoster | null, identities: PlayerIdentity[], storedSquads?: StoredSquads | null, crowns?: ReadonlyMap<string, SquadCrown>): RosterApiResponse;
  // GET /api/v1/servers/:id/roster → players[].squad_crown: null | { color: 'grey' | 'red'; squads: SquadCrownSquad[] }
  ```

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/roster-lib.test.ts`, add `parseStoredCrowns` to the import from `'../src/lib/roster.js'` and add `import type { SquadCrown } from '@squad/shared-types';`. Add a fixture after the constants:

```ts
const CROWN: SquadCrown = {
  color: 'grey',
  squads: [
    {
      squad_name: 'INF',
      team_id: 1,
      squad_id: 2,
      created_at: '2026-07-05T09:40:00.000Z',
      handoffs: [{ to_name: 'Stranger', reason: 'passed', at: '2026-07-05T09:50:00.000Z' }],
      disbanded_at: null,
      abandoned_at: null,
    },
  ],
};
```

Add this describe:

```ts
describe('parseStoredCrowns', () => {
  it('returns an empty map without a hash', () => {
    expect(parseStoredCrowns(null).size).toBe(0);
    expect(parseStoredCrowns({}).size).toBe(0);
  });

  it('keeps valid fields and drops malformed ones', () => {
    const crowns = parseStoredCrowns({
      [LINKED_EOS]: JSON.stringify(CROWN),
      [EOS_ONLY]: '{not json',
      [UNKNOWN_EOS]: JSON.stringify({ color: 'gold', squads: [] }),
    });
    expect([...crowns.keys()]).toEqual([LINKED_EOS]);
    expect(crowns.get(LINKED_EOS)).toEqual(CROWN);
  });
});
```

Inside `describe('buildRosterResponse', …)` add:

```ts
  it("attaches each player's crown by EOS id and null to everyone else", () => {
    const stored = storedRoster([
      entry({ eos_id: LINKED_EOS }),
      entry({ eos_id: EOS_ONLY, steam_id64: null }),
    ]);
    const response = buildRosterResponse(stored, [], null, new Map([[LINKED_EOS, CROWN]]));
    expect(response.players[0]?.squad_crown).toEqual(CROWN);
    expect(response.players[1]?.squad_crown).toBeNull();
  });

  it('defaults every crown to null', () => {
    expect(buildRosterResponse(storedRoster([entry({})]), []).players[0]?.squad_crown).toBeNull();
  });
```

In `apps/api/test/integration/server-roster.test.ts`, add `import { squadCrownsKey } from '@squad/shared-types';` and inside `describeIfDb(…)` add:

```ts
  it('attaches the creator crown from rcon:squad-crowns to the matching player', async () => {
    const cookie = await loginAsOwner(h);
    const serverId = uuidv7();
    const crown = {
      color: 'red',
      squads: [
        {
          squad_name: 'INF',
          team_id: 1,
          squad_id: 2,
          created_at: '2026-07-05T09:40:00.000Z',
          handoffs: [{ to_name: 'Stranger', reason: 'disconnected', at: '2026-07-05T09:50:00.000Z' }],
          disbanded_at: null,
          abandoned_at: '2026-07-05T09:50:00.000Z',
        },
      ],
    };
    await h.redis.set(`rcon:roster:${serverId}`, storedRoster(serverId));
    await h.redis.hset(squadCrownsKey(serverId), {
      [LINKED_EOS]: JSON.stringify(crown),
      [EOS_ONLY]: '{not json',
    });

    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/roster`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ players: Array<{ eos_id: string; squad_crown: unknown }> }>();
    const byEos = new Map(body.players.map((player) => [player.eos_id, player.squad_crown]));
    expect(byEos.get(LINKED_EOS)).toEqual(crown);
    expect(byEos.get(EOS_ONLY)).toBeNull();
    expect(byEos.get(UNKNOWN_EOS)).toBeNull();
  });

  it('returns squad_crown null for every player when no crowns are stored', async () => {
    const cookie = await loginAsOwner(h);
    const serverId = uuidv7();
    await h.redis.set(`rcon:roster:${serverId}`, storedRoster(serverId));
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/roster`,
      headers: { cookie },
    });
    const body = resp.json<{ players: Array<{ squad_crown: unknown }> }>();
    expect(body.players.map((player) => player.squad_crown)).toEqual([null, null, null]);
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
nice -n 10 pnpm --filter @squad/api exec vitest run test/roster-lib.test.ts test/integration/server-roster.test.ts
```

Expected: FAIL. `parseStoredCrowns is not a function`, and `squad_crown` is `undefined` (`expected undefined to be null` / `to deeply equal { color: 'red', … }`).

- [ ] **Step 3: Implement**

In `apps/api/src/lib/roster.ts`, add at the top:

```ts
import { type SquadCrown, squadCrownSchema } from '@squad/shared-types';
```

Add to `RosterApiEntry`, after `first_seen_at: string | null;`:

```ts
  /**
   * The player's squad-creator crown for the current match, from worker-rcon's
   * `rcon:squad-crowns:{id}` hash; `null` for a player without one.
   */
  squad_crown: SquadCrown | null;
```

After `parseStoredSquads` add:

```ts
/**
 * Parses `HGETALL rcon:squad-crowns:{serverId}` into crowns keyed by creator
 * EOS id. A field that is not valid JSON or does not match the contract is
 * dropped on its own, so one corrupt entry never hides the rest of the roster.
 */
export function parseStoredCrowns(raw: Record<string, string> | null): Map<string, SquadCrown> {
  const crowns = new Map<string, SquadCrown>();
  for (const [eosId, value] of Object.entries(raw ?? {})) {
    try {
      const parsed = squadCrownSchema.safeParse(JSON.parse(value));
      if (parsed.success) crowns.set(eosId, parsed.data);
    } catch {
      // malformed field: this player simply shows no crown
    }
  }
  return crowns;
}
```

Change `buildRosterResponse`'s signature and player mapping:

```ts
export function buildRosterResponse(
  stored: StoredRoster | null,
  identities: PlayerIdentity[],
  storedSquads: StoredSquads | null = null,
  crowns: ReadonlyMap<string, SquadCrown> = new Map(),
): RosterApiResponse {
```

In `players: entries.map((entry) => ({ … }))`, add after `first_seen_at: entry.first_seen_at ?? null,`:

```ts
      squad_crown: crowns.get(entry.eos_id) ?? null,
```

In `apps/api/src/routes/server-roster.ts`, add `import { squadCrownsKey } from '@squad/shared-types';` and `parseStoredCrowns` to the `../lib/roster.js` import. Replace the start of the handler through the early return:

```ts
    async (req) => {
      // MGET cannot read a hash; both reads go out together on the one connection.
      const [[rawRoster, rawSquads], rawCrowns] = await Promise.all([
        app.redis.mget(`rcon:roster:${req.params.id}`, `rcon:squads:${req.params.id}`),
        app.redis.hgetall(squadCrownsKey(req.params.id)),
      ]);
      const stored = parseStoredRoster(rawRoster ?? null);
      const storedSquads = parseStoredSquads(rawSquads ?? null);
      const crowns = parseStoredCrowns(rawCrowns);
      if (!stored || stored.players.length === 0) {
        return buildRosterResponse(stored, [], storedSquads, crowns);
      }
```

Change the last line of the handler to `return buildRosterResponse(stored, identities, storedSquads, crowns);`.

- [ ] **Step 4: Run them, plus the route-parity and isolation guards**

```bash
nice -n 10 pnpm --filter @squad/api exec vitest run test/roster-lib.test.ts test/integration/server-roster.test.ts test/test-isolation.regression.test.ts
nice -n 10 pnpm turbo run typecheck --filter=@squad/api
nice -n 10 pnpm exec biome check --write apps/api/src/lib/roster.ts apps/api/src/routes/server-roster.ts apps/api/test/roster-lib.test.ts apps/api/test/integration/server-roster.test.ts
```

Expected: PASS. The existing `returns an empty roster when no RCON poll has run` case still gets `{ polled_at: null, players: [], teams: [], squads: [] }`. Typecheck and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/roster.ts apps/api/src/routes/server-roster.ts apps/api/test/roster-lib.test.ts apps/api/test/integration/server-roster.test.ts
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(api): expose squad creator crowns on the live roster" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 7: Web — `SquadCrown` next to the leader star

**Files:**
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/roster-format.ts` — lines 1–12 (`RosterPlayer`), and append `formatClock` + `crownTooltipLines` after `formatTimeOnServer` (line 56)
- Create: `apps/web/src/app/(dashboard)/servers/[id]/squad-crown.tsx`
- Modify: `apps/web/src/app/(dashboard)/servers/[id]/live-players.tsx` — lines 31–43 (import) and lines 754–758 (render after the star)
- Test: `apps/web/src/app/(dashboard)/servers/[id]/roster-format.test.ts` (new describe)
- Test (create): `apps/web/src/app/(dashboard)/servers/[id]/squad-crown.test.tsx`
- Test: `apps/web/src/app/(dashboard)/servers/[id]/live-players.test.tsx` (new describe)

**Interfaces:**
- Consumes: `SquadCrown` type (Task 1); `players[].squad_crown` from Task 6.
- Produces:
  ```ts
  // roster-format.ts
  export interface RosterPlayer { /* existing */ squad_crown?: SquadCrown | null }
  export function formatClock(iso: string): string;
  export function crownTooltipLines(crown: SquadCrown, formatTime?: (iso: string) => string): string[];
  // squad-crown.tsx
  export function SquadCrown(props: { crown: SquadCrownData }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `roster-format.test.ts` and add `crownTooltipLines` and `formatClock` to its import from `'./roster-format'`:

```ts
describe('crownTooltipLines', () => {
  const utc = (iso: string) => iso.slice(11, 16);
  const base = {
    squad_name: 'Alpha',
    team_id: 1,
    squad_id: 1,
    created_at: '2026-09-27T21:04:00.000Z',
    handoffs: [],
    disbanded_at: null,
    abandoned_at: null,
  };

  it('describes a handoff to a squadmate', () => {
    expect(
      crownTooltipLines(
        {
          color: 'grey',
          squads: [
            {
              ...base,
              handoffs: [{ to_name: 'Ivan', reason: 'passed', at: '2026-09-27T21:10:00.000Z' }],
            },
          ],
        },
        utc,
      ),
    ).toEqual(['Создал отряд "Alpha" в 21:04, передал командование: Ivan (21:10)']);
  });

  it('describes leaving the squad while leading it', () => {
    expect(
      crownTooltipLines(
        {
          color: 'red',
          squads: [
            {
              ...base,
              handoffs: [
                { to_name: 'Ivan', reason: 'disconnected', at: '2026-09-27T21:12:00.000Z' },
              ],
              abandoned_at: '2026-09-27T21:12:00.000Z',
            },
          ],
        },
        utc,
      ),
    ).toEqual(['Создал отряд "Alpha" в 21:04 и покинул его, будучи командиром (21:12)']);
  });

  it('writes one line per squad, handoffs before the abandonment', () => {
    expect(
      crownTooltipLines(
        {
          color: 'red',
          squads: [
            {
              ...base,
              handoffs: [
                { to_name: 'Ivan', reason: 'passed', at: '2026-09-27T21:10:00.000Z' },
                { to_name: 'Oleg', reason: 'passed', at: '2026-09-27T21:11:00.000Z' },
              ],
              abandoned_at: '2026-09-27T21:20:00.000Z',
            },
            { ...base, squad_name: 'Bravo', squad_id: 2, created_at: '2026-09-27T21:30:00.000Z' },
          ],
        },
        utc,
      ),
    ).toEqual([
      'Создал отряд "Alpha" в 21:04, передал командование: Ivan (21:10), Oleg (21:11) и покинул его, будучи командиром (21:20)',
      'Создал отряд "Bravo" в 21:30',
    ]);
  });

  it('omits the creation time when the worker never saw the squad being created', () => {
    expect(
      crownTooltipLines(
        {
          color: 'grey',
          squads: [
            {
              ...base,
              created_at: null,
              handoffs: [{ to_name: 'Ivan', reason: 'passed', at: '2026-09-27T21:10:00.000Z' }],
            },
          ],
        },
        utc,
      ),
    ).toEqual(['Создал отряд "Alpha", передал командование: Ivan (21:10)']);
  });

  it('formats wall-clock time as HH:MM by default', () => {
    expect(formatClock('2026-09-27T21:04:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
  });
});
```

Create `apps/web/src/app/(dashboard)/servers/[id]/squad-crown.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { SquadCrown as SquadCrownData } from '@squad/shared-types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SquadCrown } from './squad-crown';

const squad = {
  squad_name: 'Alpha',
  team_id: 1,
  squad_id: 1,
  created_at: '2026-09-27T21:04:00.000Z',
  handoffs: [{ to_name: 'Ivan', reason: 'passed' as const, at: '2026-09-27T21:10:00.000Z' }],
  disbanded_at: null,
  abandoned_at: null,
};

afterEach(() => cleanup());

describe('SquadCrown', () => {
  it('draws a muted crown whose label names the handoff', () => {
    const crown: SquadCrownData = { color: 'grey', squads: [squad] };
    render(<SquadCrown crown={crown} />);
    const icon = screen.getByRole('img', {
      name: /^Создал отряд "Alpha" в \d{2}:\d{2}, передал командование: Ivan \(\d{2}:\d{2}\)$/,
    });
    expect(icon).toHaveClass('text-ink-3');
    expect(icon.getAttribute('title')).toBe(icon.getAttribute('aria-label'));
  });

  it('draws a danger-tone crown for an abandoned squad', () => {
    const crown: SquadCrownData = {
      color: 'red',
      squads: [{ ...squad, handoffs: [], abandoned_at: '2026-09-27T21:12:00.000Z' }],
    };
    render(<SquadCrown crown={crown} />);
    const icon = screen.getByRole('img', { name: /покинул его, будучи командиром/ });
    expect(icon).toHaveClass('text-crit');
  });
});
```

In `live-players.test.tsx`, append:

```tsx
describe('LivePlayers — корона создателя отряда', () => {
  it(
    'shows the crown after the leader star only for a player who has one',
    async () => {
      const [leader, ...rest] = ROSTER.players;
      stubRosterFetch(undefined, {
        ...ROSTER,
        players: [
          {
            ...leader,
            squad_crown: {
              color: 'grey',
              squads: [
                {
                  squad_name: 'INF',
                  team_id: 1,
                  squad_id: 2,
                  created_at: '2026-07-09T09:55:00.000Z',
                  handoffs: [{ to_name: 'Mate', reason: 'passed', at: '2026-07-09T09:58:00.000Z' }],
                  disbanded_at: null,
                  abandoned_at: null,
                },
              ],
            },
          },
          ...rest.map((player) => ({ ...player, squad_crown: null })),
        ],
      });
      render(<LivePlayers serverId="srv-1" />);
      await screen.findByText('Leader');
      const crowns = screen.getAllByRole('img', { name: /Создал отряд/ });
      expect(crowns).toHaveLength(1);
      expect(crowns[0]).toHaveAccessibleName(/передал командование: Mate/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows no crown when the roster carries none',
    async () => {
      render(<LivePlayers serverId="srv-1" />);
      await screen.findByText('Leader');
      expect(screen.queryAllByRole('img', { name: /Создал отряд/ })).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
nice -n 10 pnpm --filter @squad/web exec vitest run roster-format squad-crown live-players
```

Expected: FAIL. `crownTooltipLines is not a function`. `squad-crown.test.tsx` cannot resolve `./squad-crown`. The live-players crown case finds 0 crowns (`expected [] to have a length of 1`).

- [ ] **Step 3: Implement**

In `roster-format.ts`, add at the top `import type { SquadCrown } from '@squad/shared-types';` and extend `RosterPlayer`:

```ts
  first_seen_at: string | null;
  /**
   * Корона создателя отряда в текущем матче (история отрядов). Отсутствует в
   * ответе API, собранного до этой возможности.
   */
  squad_crown?: SquadCrown | null;
}
```

Append after `formatTimeOnServer`:

```ts
/** «21:04» по местному времени зрителя. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Подсказка короны: одна строка на каждый отряд, созданный игроком в этом
 * матче. Сначала время создания (если воркер его видел), затем передачи
 * командования товарищам по отряду, в конце уход с поста командира.
 *
 * @param formatTime - Форматирует ISO-время; в тестах подставляется UTC.
 */
export function crownTooltipLines(
  crown: SquadCrown,
  formatTime: (iso: string) => string = formatClock,
): string[] {
  return crown.squads.map((squad) => {
    let line = `Создал отряд "${squad.squad_name}"`;
    if (squad.created_at) line += ` в ${formatTime(squad.created_at)}`;
    const passed = squad.handoffs.filter((handoff) => handoff.reason === 'passed');
    if (passed.length > 0) {
      const list = passed.map((handoff) => `${handoff.to_name} (${formatTime(handoff.at)})`);
      line += `, передал командование: ${list.join(', ')}`;
    }
    if (squad.abandoned_at) {
      line += ` и покинул его, будучи командиром (${formatTime(squad.abandoned_at)})`;
    }
    return line;
  });
}
```

Create `squad-crown.tsx`:

```tsx
import type { SquadCrown as SquadCrownData } from '@squad/shared-types';
import { crownTooltipLines } from './roster-format';

/** Серая корона — приглушённый текст, красная — тон опасности; оба токена есть в каждой теме. */
const CROWN_TONE: Record<SquadCrownData['color'], string> = {
  grey: 'text-ink-3',
  red: 'text-crit',
};

/**
 * Корона создателя отряда в строке ростера: серая — передал командование и
 * остался в отряде, красная — ушёл из отряда или вышел с сервера, будучи
 * командиром. Подсказка и `aria-label` перечисляют отряды построчно.
 */
export function SquadCrown({ crown }: { crown: SquadCrownData }) {
  const label = crownTooltipLines(crown).join('\n');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 ${CROWN_TONE[crown.color]}`}
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M1.5 5.5 4.5 8 8 2.5 11.5 8l3-2.5-1.25 7.5H2.75z" />
      </svg>
    </span>
  );
}
```

In `live-players.tsx`, add `import { SquadCrown } from './squad-crown';` after the `./roster-format` import, and insert right after the leader-star block (after the `) : null}` that closes `{player.is_leader ? (…`):

```tsx
          {player.squad_crown ? <SquadCrown crown={player.squad_crown} /> : null}
```

- [ ] **Step 4: Run them**

```bash
nice -n 10 pnpm --filter @squad/web exec vitest run roster-format squad-crown live-players
nice -n 10 pnpm turbo run typecheck --filter=@squad/web
nice -n 10 pnpm exec biome check --write "apps/web/src/app/(dashboard)/servers/[id]/roster-format.ts" "apps/web/src/app/(dashboard)/servers/[id]/roster-format.test.ts" "apps/web/src/app/(dashboard)/servers/[id]/squad-crown.tsx" "apps/web/src/app/(dashboard)/servers/[id]/squad-crown.test.tsx" "apps/web/src/app/(dashboard)/servers/[id]/live-players.tsx" "apps/web/src/app/(dashboard)/servers/[id]/live-players.test.tsx"
```

Expected: PASS. The existing live-players suite is unchanged, and the new cases pass. Typecheck and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(dashboard)/servers/[id]"
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(web/servers): grey and red squad creator crowns in the live roster" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 8: Events journal — Russian labels for the squad kinds

**Files:**
- Modify: `apps/web/src/app/(dashboard)/events/helpers.ts` — lines 68–85 (`KNOWN_EVENT_KINDS`)
- Test: `apps/web/src/app/(dashboard)/events/helpers.test.ts` (new `it` next to the `kindLabel` cases at lines 159–167)

**Interfaces:**
- Consumes: event kinds from Task 1.
- Produces: `kindLabel('squad.created') === 'Отряд создан'`, `kindLabel('squad.leader_changed') === 'Смена командира отряда'`, `kindLabel('squad.disbanded') === 'Отряд распущен'`. All three appear in `kindOptionsFromEvents([])`.

- [ ] **Step 1: Write the failing test**

Add to `helpers.test.ts`, in the describe that holds the `kindLabel` cases:

```ts
  it('labels the squad history kinds in Russian and offers them as filters', () => {
    expect(kindLabel('squad.created')).toBe('Отряд создан');
    expect(kindLabel('squad.leader_changed')).toBe('Смена командира отряда');
    expect(kindLabel('squad.disbanded')).toBe('Отряд распущен');
    expect(kindOptionsFromEvents([]).map((option) => option.value)).toEqual(
      expect.arrayContaining(['squad.created', 'squad.leader_changed', 'squad.disbanded']),
    );
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
nice -n 10 pnpm --filter @squad/web exec vitest run events/helpers
```

Expected: FAIL. `expected 'squad.created' to be 'Отряд создан'`.

- [ ] **Step 3: Implement**

In `KNOWN_EVENT_KINDS`, after `{ value: 'banname.matched', label: 'Совпадение по запрещённому нику' },` add:

```ts
  { value: 'squad.created', label: 'Отряд создан' },
  { value: 'squad.leader_changed', label: 'Смена командира отряда' },
  { value: 'squad.disbanded', label: 'Отряд распущен' },
```

- [ ] **Step 4: Run it and the journal suites**

```bash
nice -n 10 pnpm --filter @squad/web exec vitest run events/helpers events/EventsBrowser events/page
nice -n 10 pnpm exec biome check "apps/web/src/app/(dashboard)/events/helpers.ts" "apps/web/src/app/(dashboard)/events/helpers.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(dashboard)/events/helpers.ts" "apps/web/src/app/(dashboard)/events/helpers.test.ts"
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "feat(web/events): Russian labels for squad history events" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 9: Fix `match_players.squad_name` — read worker-rcon's Redis snapshots at match close

**Files:**
- Modify: `apps/workers/log-ingest/src/match-roster/store.ts` — lines 1–17 (imports, `POLL_KIND`), lines 113–185 (`PollPlayer`, `loadTeamSquadByPlayer`), lines 254–316 (`computeMatchRoster`, `computeOpenMatchRoster`, `handleMatchClose` signatures)
- Modify: `apps/workers/log-ingest/src/index.ts` — line 153
- Test (rewrite): `apps/workers/log-ingest/test/match-roster-store.test.ts`
- Test: `apps/workers/log-ingest/test/match-combat.test.ts` (line 13 import, 7 call sites)
- Test: `apps/workers/log-ingest/test/ghost-match-roster.regression.test.ts` (line 12 import, line 95 call)

**Interfaces:**
- Consumes: `rcon:roster:{id}` (`{ server_id, polled_at, players: RosterEntry[] }`) and `rcon:squads:{id}` (`{ server_id, polled_at, squads: RconSquad[] }`), written by worker-rcon.
- Produces:
  ```ts
  export interface RosterSnapshotReader { mget(...keys: string[]): Promise<Array<string | null>> }
  export const ROSTER_SNAPSHOT_SLACK_MS = 120_000;
  export function computeMatchRoster(db: DatabaseClient, redis: RosterSnapshotReader, params: { serverId: string; matchStart: Date; matchEnd: Date }): Promise<MatchRosterEntry[]>;
  export function computeOpenMatchRoster(db: DatabaseClient, redis: RosterSnapshotReader, params: { matchId: string; now: Date }): Promise<MatchRosterEntry[]>;
  export function handleMatchClose(db: DatabaseClient, redis: RosterSnapshotReader, command: MatchCommand): Promise<{ written: number } | null>;
  ```

- [ ] **Step 1: Thread the Redis reader through without changing behaviour**

In `store.ts`, add after the imports:

```ts
/** The one Redis call match assembly makes; an ioredis client satisfies it. */
export interface RosterSnapshotReader {
  mget(...keys: string[]): Promise<Array<string | null>>;
}
```

Add `redis: RosterSnapshotReader` as the second parameter of `loadTeamSquadByPlayer`, `computeMatchRoster`, `computeOpenMatchRoster` and `handleMatchClose`, and pass it down at each internal call: `loadTeamSquadByPlayer(db, redis, …)`, `computeMatchRoster(db, redis, …)`. In `apps/workers/log-ingest/src/index.ts` line 153, change `await handleMatchClose(db, command);` to `await handleMatchClose(db, redis, command);`. If `tsc` later reports TS2345 there, pass `{ mget: (...keys: string[]) => redis.mget(...keys) }` instead.

In `match-combat.test.ts`, change line 13 to `import { handleMatchClose, type RosterSnapshotReader } from '../src/match-roster/store.js';` and add below the `db` constant:

```ts
/** These tests are about combat folding; no roster snapshot is cached. */
const NO_ROSTER_SNAPSHOT: RosterSnapshotReader = { mget: async () => [null, null] };
```

Replace every `handleMatchClose(db, closeCommand)` with `handleMatchClose(db, NO_ROSTER_SNAPSHOT, closeCommand)` (Edit with `replace_all`). Make the same two changes in `ghost-match-roster.regression.test.ts`, where the call at line 95 becomes `return handleMatchClose(db, NO_ROSTER_SNAPSHOT, {`.

In `match-roster-store.test.ts`, change the existing calls to `handleMatchClose(db, redis, …)` and `computeOpenMatchRoster(db, redis, …)`, and add at the top:

```ts
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
});
```

Add `await redis.quit();` to `afterAll`.

```bash
nice -n 10 pnpm --filter @squad/worker-log-ingest exec vitest run test/match-roster-store.test.ts test/match-combat.test.ts test/ghost-match-roster.regression.test.ts
```

Expected: PASS (behaviour is unchanged; `redis` is not read yet). Do not commit: `tsc` flags `redis` as unused in `loadTeamSquadByPlayer` until Step 3.

- [ ] **Step 2: Rewrite the roster test around the Redis snapshots (regression test)**

Replace the whole of `apps/workers/log-ingest/test/match-roster-store.test.ts` with:

```ts
import {
  createDatabaseClient,
  matches,
  matchPlayers,
  playerSessions,
  players,
  servers,
} from '@squad/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  computeOpenMatchRoster,
  handleMatchClose,
  type RosterSnapshotReader,
} from '../src/match-roster/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the match2 test database');

const db = createDatabaseClient(DATABASE_URL);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
});

const SERVER_ID = uuidv7();
const PLAYER_A = uuidv7();
const PLAYER_B = uuidv7();
const PLAYER_C = uuidv7();
const PLAYER_D = uuidv7();

const STEAM_A = 76561198000600001n;
const STEAM_B = 76561198000600002n;
const STEAM_D = 76561198000600004n;
const EOS_A = '0006aaaa0006aaaa0006aaaa0006aaaa';
const EOS_B = '0006bbbb0006bbbb0006bbbb0006bbbb';
const EOS_C = '0006cccc0006cccc0006cccc0006cccc';
const EOS_D = '0006dddd0006dddd0006dddd0006dddd';

const START = new Date('2026-07-05T18:00:00.000Z');
const END = new Date(START.getTime() + 3600_000);
const at = (offsetSeconds: number) => new Date(START.getTime() + offsetSeconds * 1000);

const MATCH_ID = uuidv7();
const ROSTER_KEY = `rcon:roster:${SERVER_ID}`;
const SQUADS_KEY = `rcon:squads:${SERVER_ID}`;

interface SnapshotEntry {
  steam: bigint | null;
  eos: string;
  team: number | null;
  squad: number | null;
}

/** Writes what worker-rcon caches after a roster refresh at `polledAt`. */
async function writeRosterSnapshot(
  polledAt: Date,
  entries: SnapshotEntry[],
  squads: Array<{ team: number; squad: number; name: string }>,
) {
  const polled_at = polledAt.toISOString();
  await redis.set(
    ROSTER_KEY,
    JSON.stringify({
      server_id: SERVER_ID,
      polled_at,
      players: entries.map((entry, index) => ({
        rcon_id: index,
        eos_id: entry.eos,
        steam_id64: entry.steam?.toString() ?? null,
        name: 'player',
        team_id: entry.team,
        squad_id: entry.squad,
        is_leader: false,
        role: null,
        first_seen_at: polled_at,
      })),
    }),
  );
  await redis.set(
    SQUADS_KEY,
    JSON.stringify({
      server_id: SERVER_ID,
      polled_at,
      squads: squads.map((squad) => ({
        team_id: squad.team,
        team_name: squad.team === 1 ? 'Russian Ground Forces' : 'United States Army',
        squad_id: squad.squad,
        name: squad.name,
        size: 1,
        locked: false,
        creator_name: 'player',
        creator_eos_id: null,
        creator_steam_id64: null,
        is_command_squad: false,
      })),
    }),
  );
}

function rosterRows(matchId: string) {
  return db
    .select()
    .from(matchPlayers)
    .where(eq(matchPlayers.matchId, matchId))
    .orderBy(asc(matchPlayers.playSeconds));
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Match2 Test Server',
    slug: `match2-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    { id: PLAYER_A, steamId64: STEAM_A, eosId: EOS_A, canonicalName: 'Alpha', canonicalNameNormalized: 'alpha' },
    { id: PLAYER_B, steamId64: STEAM_B, eosId: EOS_B, canonicalName: 'Bravo', canonicalNameNormalized: 'bravo' },
    { id: PLAYER_C, steamId64: null, eosId: EOS_C, canonicalName: 'Charlie', canonicalNameNormalized: 'charlie' },
    { id: PLAYER_D, steamId64: STEAM_D, eosId: EOS_D, canonicalName: 'Delta', canonicalNameNormalized: 'delta' },
  ]);
});

afterAll(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, MATCH_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_A));
  await db.delete(players).where(eq(players.id, PLAYER_B));
  await db.delete(players).where(eq(players.id, PLAYER_C));
  await db.delete(players).where(eq(players.id, PLAYER_D));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await redis.del(ROSTER_KEY, SQUADS_KEY);
  await redis.quit();
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, MATCH_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await redis.del(ROSTER_KEY, SQUADS_KEY);
});

/**
 * A left at 1800 s, B reconnected and is online at close, C left at 3500 s,
 * D is in the snapshot but never had a session. The snapshot is the roster
 * five seconds before the match ended, as worker-rcon would have cached it.
 */
async function seedClosedMatchScenario(snapshotAt: Date = new Date(END.getTime() - 5_000)) {
  await db.insert(matches).values({
    id: MATCH_ID,
    serverId: SERVER_ID,
    layer: 'Harju_RAAS_v1',
    startedAt: START,
    endedAt: END,
    endReason: 'ended',
    durationSeconds: 3600,
  });
  await db.insert(playerSessions).values([
    { playerId: PLAYER_A, serverId: SERVER_ID, connectedAt: at(-100), disconnectedAt: at(1800) },
    { playerId: PLAYER_B, serverId: SERVER_ID, connectedAt: at(0), disconnectedAt: at(600) },
    { playerId: PLAYER_B, serverId: SERVER_ID, connectedAt: at(900), disconnectedAt: null },
    { playerId: PLAYER_C, serverId: SERVER_ID, connectedAt: at(100), disconnectedAt: at(3500) },
  ]);
  await writeRosterSnapshot(
    snapshotAt,
    [
      { steam: STEAM_B, eos: EOS_B, team: 2, squad: 5 },
      { steam: STEAM_D, eos: EOS_D, team: 1, squad: 3 },
    ],
    [
      { team: 2, squad: 5, name: 'Bravo Squad' },
      { team: 1, squad: 3, name: 'Delta Squad' },
    ],
  );
}

const closeCommand = {
  kind: 'close' as const,
  serverId: SERVER_ID,
  startedAt: START.toISOString(),
  endedAt: END.toISOString(),
  team1Faction: 'Russian Ground Forces',
  team2Faction: 'United States Army',
  team1Tickets: 250,
  team2Tickets: 0,
  winner: 'team1' as const,
};

describe('handleMatchClose', () => {
  it('names each squad from the Redis snapshots (regression: squad_name was always null)', async () => {
    await seedClosedMatchScenario();
    const result = await handleMatchClose(db, redis, closeCommand);
    expect(result).toEqual({ written: 3 });

    const rows = await rosterRows(MATCH_ID);
    const byId = new Map(rows.map((row) => [row.playerId, row]));
    expect(rows).toHaveLength(3);
    expect(byId.has(PLAYER_D)).toBe(false);

    const b = byId.get(PLAYER_B);
    expect(b?.team).toBe(2);
    expect(b?.squadName).toBe('Bravo Squad');
    expect(b?.playSeconds).toBe(3300);
    expect(b?.leftAt).toBeNull();

    // A and C left before the close, so the final roster cannot place them.
    const a = byId.get(PLAYER_A);
    expect(a?.team).toBeNull();
    expect(a?.squadName).toBeNull();
    expect(a?.playSeconds).toBe(1800);
    expect(a?.joinedAt.toISOString()).toBe(START.toISOString());
    expect(a?.leftAt?.toISOString()).toBe(at(1800).toISOString());

    const c = byId.get(PLAYER_C);
    expect(c?.team).toBeNull();
    expect(c?.squadName).toBeNull();
    expect(c?.playSeconds).toBe(3400);
  });

  it('keeps the team but no squad name when the squads snapshot is missing', async () => {
    await seedClosedMatchScenario();
    await redis.del(SQUADS_KEY);
    await handleMatchClose(db, redis, closeCommand);
    const [b] = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_B)));
    expect(b?.team).toBe(2);
    expect(b?.squadName).toBeNull();
  });

  it('ignores a roster snapshot polled after the match window', async () => {
    await seedClosedMatchScenario(new Date(END.getTime() + 10 * 60_000));
    await handleMatchClose(db, redis, closeCommand);
    const rows = await rosterRows(MATCH_ID);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.team === null && row.squadName === null)).toBe(true);
  });

  it('still writes the roster when Redis is unavailable', async () => {
    await seedClosedMatchScenario();
    const down: RosterSnapshotReader = {
      mget: async () => {
        throw new Error('redis down');
      },
    };
    expect(await handleMatchClose(db, down, closeCommand)).toEqual({ written: 3 });
    const rows = await rosterRows(MATCH_ID);
    expect(rows.every((row) => row.squadName === null)).toBe(true);
  });

  it('collapses a reconnect into a single row with summed play_seconds', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);
    const rows = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_B)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playSeconds).toBe(3300);
  });

  it('includes an EOS-only player (no steam_id64) in the roster', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);
    const rows = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_C)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.team).toBeNull();
  });

  it('reconciles SUM(play_seconds) with the intersected session intervals', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);

    const [{ total }] = await db
      .select({ total: sql<number>`COALESCE(SUM(${matchPlayers.playSeconds}), 0)::int` })
      .from(matchPlayers)
      .where(eq(matchPlayers.matchId, MATCH_ID));

    const startMs = START.getTime();
    const endMs = END.getTime();
    const sessionRows = await db
      .select({
        connectedAt: playerSessions.connectedAt,
        disconnectedAt: playerSessions.disconnectedAt,
      })
      .from(playerSessions)
      .where(eq(playerSessions.serverId, SERVER_ID));
    const expected = sessionRows.reduce((sum, row) => {
      const pieceStart = Math.max(row.connectedAt.getTime(), startMs);
      const pieceEnd = Math.min(row.disconnectedAt?.getTime() ?? endMs, endMs);
      return pieceEnd > pieceStart ? sum + Math.floor((pieceEnd - pieceStart) / 1000) : sum;
    }, 0);

    expect(total).toBe(expected);
    expect(total).toBe(1800 + 3300 + 3400);
  });

  it('is idempotent when the close replays', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);
    const second = await handleMatchClose(db, redis, closeCommand);
    expect(second).toEqual({ written: 3 });
    expect(await rosterRows(MATCH_ID)).toHaveLength(3);
  });

  it('ignores non-close commands', async () => {
    const result = await handleMatchClose(db, redis, {
      kind: 'open',
      serverId: SERVER_ID,
      startedAt: START.toISOString(),
      layer: 'Harju_RAAS_v1',
    });
    expect(result).toBeNull();
  });
});

describe('computeOpenMatchRoster', () => {
  it('computes the live roster on the fly without writing match_players', async () => {
    await db.insert(matches).values({
      id: MATCH_ID,
      serverId: SERVER_ID,
      layer: 'Yehorivka_RAAS_v1',
      startedAt: START,
      endedAt: null,
    });
    await db.insert(playerSessions).values([
      { playerId: PLAYER_A, serverId: SERVER_ID, connectedAt: at(0), disconnectedAt: null },
      { playerId: PLAYER_B, serverId: SERVER_ID, connectedAt: at(600), disconnectedAt: null },
    ]);
    await writeRosterSnapshot(
      at(700),
      [
        { steam: STEAM_A, eos: EOS_A, team: 1, squad: 4 },
        { steam: STEAM_B, eos: EOS_B, team: 2, squad: 1 },
      ],
      [
        { team: 1, squad: 4, name: 'Alpha Squad' },
        { team: 2, squad: 1, name: 'Bravo Squad' },
      ],
    );

    const roster = await computeOpenMatchRoster(db, redis, { matchId: MATCH_ID, now: at(1200) });
    const byId = new Map(roster.map((entry) => [entry.playerId, entry]));

    expect(roster).toHaveLength(2);
    expect(byId.get(PLAYER_A)?.playSeconds).toBe(1200);
    expect(byId.get(PLAYER_A)?.team).toBe(1);
    expect(byId.get(PLAYER_A)?.leftAt).toBeNull();
    expect(byId.get(PLAYER_B)?.playSeconds).toBe(600);
    expect(byId.get(PLAYER_B)?.squadName).toBe('Bravo Squad');
    expect(await rosterRows(MATCH_ID)).toHaveLength(0);
  });
});
```

Run it to watch the regression fail:

```bash
nice -n 10 pnpm --filter @squad/worker-log-ingest exec vitest run test/match-roster-store.test.ts
```

Expected: FAIL. `names each squad from the Redis snapshots…` fails with `expected null to be 2` (B's team, because the old lookup reads `rcon.players_polled` rows that no longer exist). `keeps the team but no squad name…` and `computeOpenMatchRoster` fail the same way. The window, Redis-down and other cases pass, because the old path already writes `null`. Record this red output as the regression evidence.

- [ ] **Step 3: Implement the snapshot lookup**

In `store.ts`, remove `events` from the `@squad/db` import, remove `gte` and `lte` from the `drizzle-orm` import, and delete `const POLL_KIND = 'rcon.players_polled';`. Replace `interface PollPlayer` and `loadTeamSquadByPlayer` (lines 113–185) with:

```ts
/**
 * How far past the match end worker-rcon's last roster snapshot may be and
 * still describe that match: the close is handled a moment after its log line,
 * and the snapshot keeps refreshing every 2 s.
 */
export const ROSTER_SNAPSHOT_SLACK_MS = 120_000;

interface SnapshotPlayer {
  eos_id: string | null;
  steam_id64: string | null;
  team_id: number | null;
  squad_id: number | null;
}

interface SnapshotSquad {
  team_id: number;
  squad_id: number;
  name: string;
}

function parseSnapshot<Row>(
  raw: string | null,
  field: 'players' | 'squads',
): { polledAtMs: number; rows: Row[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rows = parsed[field];
    const polledAtMs =
      typeof parsed.polled_at === 'string' ? Date.parse(parsed.polled_at) : Number.NaN;
    if (!Array.isArray(rows) || Number.isNaN(polledAtMs)) return null;
    return { polledAtMs, rows: rows as Row[] };
  } catch {
    return null;
  }
}

async function readRosterSnapshot(
  redis: RosterSnapshotReader,
  serverId: string,
): Promise<[string | null, string | null]> {
  try {
    const [roster, squads] = await redis.mget(`rcon:roster:${serverId}`, `rcon:squads:${serverId}`);
    return [roster ?? null, squads ?? null];
  } catch {
    // Team and squad decorate the roster; Redis being down must not cost the
    // match its match_players rows.
    return [null, null];
  }
}

/**
 * Team and squad name per panel player, from the last roster worker-rcon
 * cached for the server (`rcon:roster:{id}` + `rcon:squads:{id}`, kept 90 s
 * after the last refresh). Only players online in that snapshot are placed;
 * anyone who left earlier keeps `null`. A snapshot polled outside
 * [matchStart, matchEnd + {@link ROSTER_SNAPSHOT_SLACK_MS}] belongs to another
 * match (a replayed log, a late close) and is ignored. A squad missing from
 * `rcon:squads` leaves the player's team set and the squad name `null`.
 */
async function loadTeamSquadByPlayer(
  db: DatabaseClient,
  redis: RosterSnapshotReader,
  serverId: string,
  matchStart: Date,
  matchEnd: Date,
): Promise<Map<string, TeamSquad>> {
  const result = new Map<string, TeamSquad>();
  const [rawRoster, rawSquads] = await readRosterSnapshot(redis, serverId);
  const roster = parseSnapshot<SnapshotPlayer>(rawRoster, 'players');
  if (!roster) return result;
  const windowEndMs = matchEnd.getTime() + ROSTER_SNAPSHOT_SLACK_MS;
  if (roster.polledAtMs < matchStart.getTime() || roster.polledAtMs > windowEndMs) return result;

  const squadNames = new Map<string, string>();
  for (const squad of parseSnapshot<SnapshotSquad>(rawSquads, 'squads')?.rows ?? []) {
    squadNames.set(`${squad.team_id}:${squad.squad_id}`, squad.name);
  }

  const snapshotPlayers = roster.rows.filter(
    (entry) => entry.steam_id64 !== null || entry.eos_id !== null,
  );
  if (snapshotPlayers.length === 0) return result;

  const steamIds = snapshotPlayers
    .map((entry) => entry.steam_id64)
    .filter((value): value is string => value !== null)
    .map((value) => BigInt(value));
  const eosIds = snapshotPlayers
    .map((entry) => entry.eos_id)
    .filter((value): value is string => value !== null);

  const conditions = [];
  if (steamIds.length > 0) conditions.push(inArray(players.steamId64, steamIds));
  if (eosIds.length > 0) conditions.push(inArray(players.eosId, eosIds));
  if (conditions.length === 0) return result;

  const resolved = await db
    .select({ id: players.id, steamId64: players.steamId64, eosId: players.eosId })
    .from(players)
    .where(or(...conditions));

  const playerBySteam = new Map<string, string>();
  const playerByEos = new Map<string, string>();
  for (const player of resolved) {
    if (player.steamId64 !== null) playerBySteam.set(player.steamId64.toString(), player.id);
    if (player.eosId !== null) playerByEos.set(player.eosId, player.id);
  }

  for (const entry of snapshotPlayers) {
    const playerId =
      (entry.steam_id64 !== null ? playerBySteam.get(entry.steam_id64) : undefined) ??
      (entry.eos_id !== null ? playerByEos.get(entry.eos_id) : undefined);
    if (!playerId) continue;
    result.set(playerId, {
      team: entry.team_id,
      squadName:
        entry.squad_id === null
          ? null
          : (squadNames.get(`${entry.team_id}:${entry.squad_id}`) ?? null),
    });
  }
  return result;
}
```

Add a docstring to `handleMatchClose` above its signature:

```ts
/**
 * Writes `match_players` for a closed match: play time from `player_sessions`
 * overlap, team and squad name from worker-rcon's last Redis roster snapshot
 * (see `loadTeamSquadByPlayer`), combat totals from `events`. Idempotent.
 *
 * @returns `null` for a non-close command or an unknown/open match, otherwise the number of rows written.
 */
```

- [ ] **Step 4: Run the log-ingest roster suites**

```bash
nice -n 10 pnpm --filter @squad/worker-log-ingest exec vitest run test/match-roster-store.test.ts test/match-combat.test.ts test/ghost-match-roster.regression.test.ts test/match-roster.test.ts test/index-import.test.ts
nice -n 10 pnpm turbo run typecheck --filter=@squad/worker-log-ingest
nice -n 10 pnpm exec biome check --write apps/workers/log-ingest/src/match-roster/store.ts apps/workers/log-ingest/src/index.ts apps/workers/log-ingest/test/match-roster-store.test.ts apps/workers/log-ingest/test/match-combat.test.ts apps/workers/log-ingest/test/ghost-match-roster.regression.test.ts
```

Expected: PASS. The regression case that was red in Step 2 is now green. Typecheck (including `redis` in `index.ts`) and Biome are clean.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/log-ingest
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "fix(workers/log-ingest): fill match_players team and squad name from the RCON roster snapshot" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/components/workers/rcon/flows.md` (new section after "Live refresh", before "Poll cycle")
- Modify: `docs/components/workers/rcon/data-model.md` (new `events` subsection under "Postgres tables written"; one row in "Redis keys")
- Modify: `docs/components/workers/rcon/api.md` (new hash section before "Redis stream: `events:server:{serverId}`"; three event subsections; intro sentence)
- Modify: `docs/components/workers/rcon/changelog.md` (new top entry)
- Modify: `docs/components/workers/log-ingest/flows.md` (new "Match close" section before "Squad fatal detection patterns")
- Modify: `docs/components/workers/log-ingest/changelog.md` (new top entry)
- Modify: `docs/components/api/api.md` (the `GET /api/v1/servers/:id/roster` row, line 148)
- Modify: `docs/components/shared-types/data-model.md` (`actor.kind` in the envelope, three rows in the `EventType` table)
- Modify: `docs/components/shared-types/README.md` (file list)
- Modify: `docs/components/web/changelog.md` (new top entry)
- Modify: `docs/architecture/map.md` (§9.3 Redis keyspace: correct the `rcon:squads:<id>` row, add `rcon:squad-crowns:<id>`)

**Interfaces:**
- Consumes: the final behaviour of Tasks 1–9.
- Produces: documentation only.

- [ ] **Step 1: Write the rcon worker docs**

`docs/components/workers/rcon/flows.md`: insert before `## Poll cycle (every 30 s)`:

```markdown
## Squad history (every roster refresh)

Both the 2 s roster refresh and the 30 s full poll pass their `ListSquads` + `ListPlayers` rows to `trackSquads` (`supervisor.ts`), right after writing `rcon:squads:{id}`:

1. `buildSquadSnapshot()` keys each squad by `(team_id, squad_id, creator EOS id)`. Squad reuses squad numbers, and squads whose creator has no EOS id are skipped. It finds each squad's leader (`Is Leader: True` in the same team and squad).
2. `diffSquads()` (`squad-tracker.ts`) compares the snapshot with the previous one. A new identity is `squad.created`. It is dated by the unsolicited RCON notice `… has created Squad <n> (Squad Name: …) on <faction>` when one arrived in the last 10 s (parsed by `squad-broadcast.ts` in `ingestBroadcast`), otherwise by the refresh time. A different leader is `squad.leader_changed`, with `reason` `passed` (old leader still in the squad), `left_squad` (online elsewhere) or `disconnected` (not in `ListPlayers`). A vanished identity is `squad.disbanded`, with `creator_was_leader`. A change faster than one refresh (A → B → C) is recorded as A → C.
3. Each event is XADDed to `events:server:{id}` and inserted into `events` (`actor_kind = 'player'`, `actor_id` = EOS id of the creator, or of `from` for a leader change).
4. `applySquadEvent()` (`squad-crowns.ts`) folds the event into the creator's history. Creators with a crown are written to `rcon:squad-crowns:{id}`, and the TTL is refreshed to 6 h.

No false events:

- The first snapshot after worker start or an RCON (re)connect is a baseline. Crowns survive: they are reloaded from Redis on start.
- A `match.started` / `match.ended` refresh hint (its `reason`) deletes the crown hash and makes the next snapshot a baseline. After `match.ended`, snapshots stay baselines until one lists no squads or `match.started` arrives, so squads vanishing with the old map are never disbands.
- If every squad of a snapshot with at least 3 squads vanishes in one refresh (a map change without a hint), crowns are cleared and nothing is reported.

Squad tracking never throws. A Redis or database failure is logged (`squad tracking failed`, `squad event persist failed`) and the roster refresh goes on.
```

`docs/components/workers/rcon/data-model.md`: under `## Postgres tables written`, after the `player_sessions` subsection, add:

```markdown
### `events` (squad history)

`squad.created`, `squad.leader_changed` and `squad.disbanded` rows are inserted directly by `PerServerSupervisor.emitSquadEvent`, the same way as the seeding transitions (`onConflictDoNothing` on `(event_id, occurred_at)`). `actor_kind = 'player'`, `actor_id` = the EOS id of the squad's creator (`created`, `disbanded`) or of the leader who gave up command (`leader_changed`), so `events_actor_occurred_idx` serves per-player lookups. Payload schemas: `packages/shared-types/src/events.ts` (`squadCreatedPayload`, `squadLeaderChangedPayload`, `squadDisbandedPayload`). Retention follows the `events` partitions (24 months).
```

In the `## Redis keys` table, add after the `rcon:squads:{serverId}` row:

```markdown
| `rcon:squad-crowns:{serverId}` | 6 h, refreshed on write | Hash: creator EOS id → `SquadCrown` JSON for the current match; deleted on match reset |
```

`docs/components/workers/rcon/api.md`: replace `Three event types are published by this worker.` with `The event types below are published by this worker.` Insert before `## Redis stream: \`events:server:{serverId}\``:

````markdown
## Redis hash: `rcon:squad-crowns:{serverId}`

One field per squad creator (EOS id) who gave up command of a squad they created in the current match. Written by `trackSquads` whenever that creator's history changes. The TTL (`SQUAD_CROWNS_TTL_SECONDS`, 6 h) is refreshed on every write, and the hash is deleted on a match reset. Contract: `packages/shared-types/src/squad-crowns.ts` (`squadCrownSchema`). Read by `GET /api/v1/servers/:id/roster` (`squad_crown`).

```json
{
  "color": "grey",
  "squads": [
    {
      "squad_name": "Alpha",
      "team_id": 1,
      "squad_id": 3,
      "created_at": "2026-09-27T21:04:00.000Z",
      "handoffs": [{ "to_name": "Ivan", "reason": "passed", "at": "2026-09-27T21:10:00.000Z" }],
      "disbanded_at": null,
      "abandoned_at": null
    }
  ]
}
```

`grey`: the creator handed command to a squadmate. `red`: the creator left the squad or disconnected while leading it, or it disbanded under them (red overrides grey). `created_at` is `null` for a squad that already existed when tracking started. `abandoned_at` is when the creator gave up command by leaving.
````

After the `### rcon.players_polled` subsection, add:

````markdown
### `squad.created` / `squad.leader_changed` / `squad.disbanded`

Emitted by squad history (see `flows.md`) and also inserted into `events`. `actor` is `{ "kind": "player", "id": "<eos>" }`.

```json
{ "payload": { "team_id": 1, "team_name": "United States Army", "squad_id": 3, "squad_name": "Alpha",
  "creator": { "eos_id": "<eos>", "steam_id64": "76561198012345678", "name": "Anna" } } }
```

`squad.leader_changed` adds `from`, `to` (same shape as `creator`) and `reason` (`passed` | `left_squad` | `disconnected`). `squad.disbanded` adds `last_leader` (or `null`) and `creator_was_leader`.
````

`docs/components/workers/rcon/changelog.md`: insert after `# Changelog — worker-rcon`:

```markdown
## 2026-09-27 — История отрядов и короны создателей

### Added

- Воркер записывает создание отрядов, смену командира и роспуск отрядов в `events` (`squad.created`, `squad.leader_changed`, `squad.disbanded`) и в поток `events:server:{id}`. Создание отряда датируется RCON-сообщением `has created Squad`, которое раньше отбрасывалось. Смена командира и роспуск вычисляются сравнением соседних снимков состава (раз в 2 с).
- Хэш `rcon:squad-crowns:{id}` хранит короны создателей текущего матча: серую (передал командование товарищу) и красную (ушёл из отряда или с сервера, будучи командиром). Хэш удаляется на смене матча, TTL 6 ч.
- Подсказка `rcon:refresh` теперь передаёт супервизору `reason`: `match.started` / `match.ended` сбрасывают историю отрядов без ложных «роспусков».
```

- [ ] **Step 2: Write the log-ingest, API, shared-types, web and architecture docs**

`docs/components/workers/log-ingest/flows.md`: insert before `## Squad fatal detection patterns`:

```markdown
## Match close (`match_players`)

On a `close` / `close_server_down` match command, `handleMatchClose` (`src/match-roster/store.ts`) writes one `match_players` row per player with at least 60 s of play:

- `joined_at`, `left_at`, `play_seconds` come from `player_sessions` overlapping the match window.
- `team` and `squad_name` come from worker-rcon's last Redis roster: `rcon:roster:{id}` (team and squad number) and `rcon:squads:{id}` (squad name). Only players in that snapshot, meaning online at close, are placed. Anyone who left earlier keeps `null`, and so does a squad missing from `rcon:squads`. A snapshot polled outside `[started_at, ended_at + 120 s]` is ignored as belonging to another match. If Redis is unreachable, the rows are still written with `null` placements.
- Kills, deaths and the rest come from combat `events` (`applyMatchCombatStats`).
```

`docs/components/workers/log-ingest/changelog.md`: insert after `# Changelog — worker-log-ingest`:

```markdown
## 2026-09-27

### Fixed

- `match_players.squad_name` (and `team`) were always `null`: `handleMatchClose` looked them up in `rcon.players_polled` rows of `events`, but worker-rcon only XADDs that event and nothing persists it. Match close now reads worker-rcon's `rcon:roster:{id}` + `rcon:squads:{id}` snapshots and stores the squad's name (not its number). Players who left before the close keep `null`. Snapshots outside the match window (+120 s) are ignored, and a Redis outage no longer affects whether the roster is written. `handleMatchClose` / `computeMatchRoster` / `computeOpenMatchRoster` take the Redis client as their second argument. Regression test: `test/match-roster-store.test.ts`.
```

`docs/components/api/api.md` line 148: in the roster row's description, after the sentence ending `…the UI renders the roster from \`players\` alone in that case.`, insert:

```markdown
Each player also carries `squad_crown`: `null`, or `{ color: 'grey' | 'red', squads: [{ squad_name, team_id, squad_id, created_at, handoffs: [{ to_name, reason, at }], disbanded_at, abandoned_at }] }` from worker-rcon's `rcon:squad-crowns:{id}` hash (matched by `eos_id`; a malformed field yields `null` for that player only).
```

`docs/components/shared-types/data-model.md`: in the `EventEnvelope` block, change `actor: { kind: 'user' | 'system' | 'external'; id: string | null } | null;` to `actor: { kind: 'user' | 'system' | 'external' | 'player'; id: string | null } | null;  // 'player': id is an in-game EOS id`. In the `EventType` table, add after the `rcon.players_polled` row:

```markdown
| `squad.created` / `squad.leader_changed` / `squad.disbanded` | `worker-rcon` (squad history; also inserted into `events`) | events journal, per-player lookups by `actor_id` |
```

`docs/components/shared-types/README.md`: add to `## Files` after the `events.ts` line:

```markdown
- [`packages/shared-types/src/squad-crowns.ts`](../../../packages/shared-types/src/squad-crowns.ts) — `rcon:squad-crowns:{serverId}` key helper, TTL and `squadCrownSchema`.
```

`docs/components/web/changelog.md`: insert after `# Changelog`:

```markdown
## 2026-09-27 — Короны создателей отрядов

### Added

- В «Игроки онлайн» после звезды командира появляется корона создателя отряда. Серая: игрок создал отряд и передал командование, оставшись в нём. Красная: ушёл из отряда или с сервера, будучи командиром (красная важнее серой). Подсказка перечисляет отряды построчно, например «Создал отряд "Alpha" в 21:04, передал командование: Ivan (21:10)».
- Журнал событий подписывает `squad.created`, `squad.leader_changed` и `squad.disbanded` как «Отряд создан», «Смена командира отряда», «Отряд распущен».
```

`docs/architecture/map.md` §9.3: replace the `rcon:squads:<id>` row with:

```markdown
| `rcon:squads:<id>` | string(JSON) | `supervisor.ts` (`writeSquads`) | `routes/server-roster.ts` (team/squad metadata); log-ingest `match-roster/store.ts` (squad names at match close) | `EX 90` | yes | Roster loses team/squad names; `match_players.squad_name` stays `null` |
| `rcon:squad-crowns:<id>` | hash | `supervisor.ts` (`trackSquads`) | `routes/server-roster.ts` (`squad_crown`); re-read on worker start | `EX 21600`, refreshed on write; `DEL` on match reset | yes (current match) | Crowns vanish for the rest of the match; `squad.*` events in `events` are unaffected |
```

- [ ] **Step 3: Check the docs render and nothing else moved**

```bash
git diff --stat
grep -n "squad-crowns" docs/components/workers/rcon/api.md docs/components/workers/rcon/data-model.md docs/architecture/map.md docs/components/shared-types/README.md
```

Expected: only the eleven doc files above changed, and each grep target contains the new key.

- [ ] **Step 4: Full affected-package gate before the final commit**

```bash
nice -n 10 pnpm turbo run typecheck --filter=@squad/shared-types --filter=@squad/worker-rcon --filter=@squad/worker-log-ingest --filter=@squad/api --filter=@squad/web
nice -n 10 pnpm exec biome check .
nice -n 10 pnpm --filter @squad/worker-rcon exec vitest run
nice -n 10 pnpm --filter @squad/worker-log-ingest exec vitest run test/match-roster-store.test.ts test/match-combat.test.ts test/ghost-match-roster.regression.test.ts
nice -n 10 pnpm --filter @squad/api exec vitest run test/roster-lib.test.ts test/integration/server-roster.test.ts test/test-isolation.regression.test.ts test/route-registration-parity.test.ts
nice -n 10 pnpm --filter @squad/web exec vitest run roster-format squad-crown live-players events/helpers
nice -n 10 pnpm --filter @squad/shared-types exec vitest run --coverage
```

Expected: all green. shared-types coverage stays at 100 %.

- [ ] **Step 5: Commit**

```bash
git add docs
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "docs(squads): document squad history events, crowns and the match_players squad fix" -m "Claude-Session: https://claude.ai/code/session_01TmGpcJH4esb1uLbxrL5Tyt"
```

---

## Resolved spec ambiguities

Where the spec was silent or its wording did not survive contact with the code, this plan made the following choices. Reviewers should confirm them.

1. **`actor_kind = 'player'` was not a legal envelope actor.** `eventEnvelope.actor.kind` is `z.enum(['user', 'system', 'external'])`, and the automation and discord consumers drop envelopes that fail it. Task 1 adds `'player'` to the enum.
2. **`actor_id` is an EOS id, but the journal's nickname join is `players.id::text = actor_id`.** The journal therefore shows no actor nickname for `squad.*` rows. Kept as specified. The payload carries names, and a per-player lookup by EOS id uses `events_actor_occurred_idx`.
3. **Crown JSON is extended.** `squad_id` is added so later events can find the squad record. `abandoned_at` is added because the red tooltip line needs the time the creator left. `created_at` is nullable, for squads that existed before tracking started (baseline, worker restart).
4. **`diffSquads` returns `{ events, state, pending, reset }`.** `pending` holds the unconsumed broadcasts. `reset` flags a mass vanish so the supervisor clears crowns. `SquadSnapshot` also carries player placements, which the leader-change `reason` needs, so the spec's 3-argument signature stays.
5. **Broadcast matching.** The notice names the faction, not the team id. A broadcast is matched on `(squad_id, creator EOS id)`, the earliest matching broadcast dates the squad, and every duplicate is consumed.
6. **Squads whose creator has no EOS id are not tracked.** History and crowns are keyed by EOS id.
7. **Round end on a small server.** `match.ended` holds the tracker in baseline mode until a snapshot lists no squads or `match.started` arrives. Without this, the 1–2 squads of a seeding round would be reported as disbanded at every map change, because the mass-vanish rule needs 3.
8. **Hint reason plumbing.** `RconSupervisor.hint` and `requestRefresh` gain an optional `reason`, which `index.ts` passes from the existing `RconRefreshHint.reason`. No wire change.
9. **Restart semantics.** Crowns are reloaded from Redis into memory on supervisor start, so later handoffs extend the stored entry. An RCON reconnect is a baseline and does not clear crowns. Only a match reset or a mass vanish does.
10. **"Same MGET/pipeline".** MGET cannot read a hash, so the route issues `MGET` and `HGETALL` concurrently with `Promise.all` on the one connection.
11. **`match_players` fix details.** `squad_name` becomes the squad's name from `rcon:squads` (not its number), and it is `null` when the squad row is missing. `team` also comes from the snapshot, so players who left before close now have `null` team too; the old events path never produced values anyway. A snapshot is accepted only when `polled_at ∈ [matchStart, matchEnd + 120 s]`. A Redis failure yields `null` placements rather than failing the close. `computeOpenMatchRoster` uses the same source.
12. **Tooltip and colour.** The tooltip uses the native `title` plus `aria-label` on a `role="img"` span, following the roster's existing star/identity pattern (there is no tooltip component). Times are the viewer's local `HH:MM` (`ru-RU`). The panel defines one theme token set, so grey is `text-ink-3` and red is `text-crit`.
13. **Task split.** The crown rule got its own task (Task 4), so the suggested 9 steps became 10 tasks.
14. **Journal.** Only labels were added (spec). No `kindTone` colour change.
