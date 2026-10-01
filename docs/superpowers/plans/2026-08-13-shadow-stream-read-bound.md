# Bounded reads of RNSquadJS shadow streams — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the size of every `XRANGE` in the manual RNSquadJS check and reject invalid parameters before connecting to Redis.

**Architecture:** The script stays a single CLI file. Input parameters are normalized before the client is created, `readStream` requests `limit + 1`, hands the comparison at most `limit` records, and raises a shared overflow flag. When the flag is set, a dedicated gate ends the check fail-closed.

**Tech Stack:** Node.js 22, ESM, Redis Streams via ioredis, the built-in `node:test`, Biome.

## Global Constraints

- `MAX_STREAM_RECORDS` defaults to `100000`; the allowed range is `1..1000000`.
- `sinceMs` and `minEvents` are safe integers that are at least zero.
- A parameter error exits with `2` before the Redis client is created.
- Overflow of either stream yields the gate `input-limit-exceeded` and exit `1`.
- A partial sample can never yield `pass`.
- The envelope semantics, the list of sidecar events, and the parity/extras thresholds do not change.

---

### Task 1: Strict validation of numeric parameters

**Files:**
- Modify: `scripts/rnsquadjs-shadow-diff.test.ts`
- Modify: `scripts/rnsquadjs-shadow-diff.mjs`

**Interfaces:**
- Consumes: the positional `sinceMsRaw` and `minEventsRaw`, and `process.env.MAX_STREAM_RECORDS`.
- Produces: normalized `sinceMs`, `minEvents`, `maxStreamRecords`; CLI errors with exit `2`.

- [ ] **Step 1: Add red checks for the window and the limit**

Extend the test runner with an explicit environment:

```ts
function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, REDIS_URL, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
```

Add two independent scenarios:

```ts
it('rejects non-integer, negative, and non-numeric lookback windows with exit 2', () => {
  for (const window of ['-1', '1.5', 'not-a-number']) {
    const result = runCli([SERVER_ID, window, '0'], {
      REDIS_URL: 'redis://127.0.0.1:notaport',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`invalid sinceMs: ${window}`));
    assert.equal(result.stdout, '');
  }
});

it('rejects unsafe stream record limits with exit 2', () => {
  for (const limit of ['0', '-1', '1.5', 'not-a-number', '1000001']) {
    const result = runCli([SERVER_ID, '60000', '0'], {
      MAX_STREAM_RECORDS: limit,
      REDIS_URL: 'redis://127.0.0.1:notaport',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`invalid MAX_STREAM_RECORDS: ${limit}`));
    assert.equal(result.stdout, '');
  }
});
```

- [ ] **Step 2: Run only the new scenarios and confirm the red state**

Run:

```bash
pnpm --filter panel-bridge build
pnpm exec tsx --test --test-name-pattern='lookback windows|stream record limits' scripts/rnsquadjs-shadow-diff.test.ts
```

Expected: FAIL — the current CLI does not reject `sinceMs` before Redis and ignores `MAX_STREAM_RECORDS`.

- [ ] **Step 3: Add minimal normalization before the Redis client is created**

In `scripts/rnsquadjs-shadow-diff.mjs`, replace the lenient window computation and add the limit:

```js
const sinceMs = Number(sinceMsRaw ?? 24 * 3600 * 1000);
if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
  console.error(`invalid sinceMs: ${sinceMsRaw}`);
  process.exit(2);
}
const minEvents = Number(minEventsRaw ?? process.env.MIN_EVENTS ?? 100);
if (!Number.isSafeInteger(minEvents) || minEvents < 0) {
  console.error(`invalid minEvents: ${minEventsRaw ?? process.env.MIN_EVENTS}`);
  process.exit(2);
}
const maxStreamRecords = Number(process.env.MAX_STREAM_RECORDS ?? 100_000);
if (
  !Number.isSafeInteger(maxStreamRecords) ||
  maxStreamRecords < 1 ||
  maxStreamRecords > 1_000_000
) {
  console.error(`invalid MAX_STREAM_RECORDS: ${process.env.MAX_STREAM_RECORDS}`);
  process.exit(2);
}
const since = Math.max(0, Date.now() - sinceMs);
```

- [ ] **Step 4: Confirm the green state of the new and existing parameter checks**

Run:

```bash
pnpm exec tsx --test --test-name-pattern='minimums|lookback windows|stream record limits' scripts/rnsquadjs-shadow-diff.test.ts
```

Expected: 3 scenarios PASS, 0 FAIL.

- [ ] **Step 5: Commit the cycle**

```bash
git add scripts/rnsquadjs-shadow-diff.mjs scripts/rnsquadjs-shadow-diff.test.ts
git commit -m 'fix(ops): валидировать параметры shadow-diff (#282)'
```

### Task 2: Bounded `XRANGE` and the fail-closed gate

**Files:**
- Modify: `scripts/rnsquadjs-shadow-diff.test.ts`
- Modify: `scripts/rnsquadjs-shadow-diff.mjs`

**Interfaces:**
- Consumes: `maxStreamRecords` from Task 1.
- Produces: `maxStreamRecords` and `inputLimitExceeded` in the JSON verdict, and the gate `input-limit-exceeded`.

- [ ] **Step 1: Add a red boundary check**

Add two matching records to both streams, run the CLI with a limit of `2` and
check for a normal `pass`; then add a third pair and check the truncated
counters and the fail-closed result:

```ts
it('fails closed after a bounded number of records', async () => {
  const now = new Date().toISOString();
  for (let index = 0; index < 2; index += 1) {
    const event = { type: 'player.connected', ts: now, payload: { steamId: `p-${index}` } };
    await appendEnvelope(PROD_STREAM, event);
    await appendEnvelope(SHADOW_STREAM, event);
  }

  const boundary = runCli([SERVER_ID, '60000', '2'], { MAX_STREAM_RECORDS: '2' });
  assert.equal(boundary.status, 0, boundary.stderr);
  assert.equal(verdict(boundary).inputLimitExceeded, false);
  assert.equal(verdict(boundary).prod, 2);

  const extra = { type: 'player.connected', ts: now, payload: { steamId: 'p-2' } };
  await appendEnvelope(PROD_STREAM, extra);
  await appendEnvelope(SHADOW_STREAM, extra);
  const exceeded = runCli([SERVER_ID, '60000', '2'], { MAX_STREAM_RECORDS: '2' });
  assert.equal(exceeded.status, 1);
  assert.equal(verdict(exceeded).gate, 'input-limit-exceeded');
  assert.equal(verdict(exceeded).inputLimitExceeded, true);
  assert.equal(verdict(exceeded).maxStreamRecords, 2);
  assert.equal(verdict(exceeded).prod, 2);
  assert.equal(verdict(exceeded).shadow, 2);
});
```

Add these literals to all full expected JSON objects:

```ts
maxStreamRecords: 100_000,
inputLimitExceeded: false,
```

- [ ] **Step 2: Run the boundary scenario and confirm the red state**

Run:

```bash
pnpm exec tsx --test --test-name-pattern='bounded number of records' scripts/rnsquadjs-shadow-diff.test.ts
```

Expected: FAIL — the current CLI reads the third record and does not return `inputLimitExceeded`.

- [ ] **Step 3: Implement one bounded request per stream**

Add a shared flag and bound `readStream`:

```js
let badRecords = 0;
let inputLimitExceeded = false;
async function readStream(name) {
  const raw = await redis.xrange(name, String(since), '+', 'COUNT', maxStreamRecords + 1);
  if (raw.length > maxStreamRecords) inputLimitExceeded = true;
  const events = [];
  for (const [, fields] of raw.slice(0, maxStreamRecords)) {
    // existing semantic envelope check, unchanged
  }
  return events;
}
```

Put this before the other failure reasons:

```js
if (inputLimitExceeded) {
  gate = 'input-limit-exceeded';
} else if (badRecords > 0) {
  // current gate branches, unchanged
}
```

Add `maxStreamRecords` and `inputLimitExceeded` to the JSON verdict.

- [ ] **Step 4: Run the whole relevant suite**

Run:

```bash
pnpm test:scripts
```

Expected: 10 scenarios PASS, 0 FAIL.

- [ ] **Step 5: Check formatting and the diff**

Run:

```bash
pnpm exec biome check scripts/rnsquadjs-shadow-diff.mjs scripts/rnsquadjs-shadow-diff.test.ts
git diff --check
git diff origin/dev...HEAD
```

Expected: Biome and `diff --check` PASS; the diff is limited to #282 and the docs.

- [ ] **Step 6: Commit the implementation**

```bash
git add scripts/rnsquadjs-shadow-diff.mjs scripts/rnsquadjs-shadow-diff.test.ts
git commit -m 'fix(ops): ограничить чтение shadow-потоков (#282)'
```

### Task 3: Full acceptance of the working branch

**Files:**
- Verify only: the whole repository

**Interfaces:**
- Consumes: the two green cycles of Tasks 1–2.
- Produces: a clean pushed branch, ready for independent acceptance and a subsequent merge into `dev`.

- [ ] **Step 1: Run the full local gate**

Run:

```bash
bash scripts/pre-push-checklist.sh
```

Expected: all available mandatory steps PASS; no tests skipped because of a missing database.

- [ ] **Step 2: Check the mechanical state**

Run:

```bash
git status --short --branch
git log --oneline origin/dev..HEAD
git diff --check origin/dev...HEAD
```

Expected: the tree is clean, only #282 commits, no diff errors.

- [ ] **Step 3: Push the branch and run the feature check**

Run:

```bash
git push -u origin fix/282-shadow-stream-bound
bash scripts/verify-done.sh --feature
```

Expected: the exact `HEAD` equals the remote branch, and the origin from `dev` is confirmed.

- [ ] **Step 4: Leave the evidence in #282**

List the red and green commands, the exact SHA, the full local gate,
the independent verdict and the external blocker, `dev` CI #281. Move the task to Review,
but do not merge the branch until the self-hosted runner is restored.
