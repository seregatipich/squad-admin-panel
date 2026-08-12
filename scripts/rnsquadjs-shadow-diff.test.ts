import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Redis from 'ioredis';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'scripts/rnsquadjs-shadow-diff.mjs');
const REDIS_URL =
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const SERVER_ID = randomUUID();
const PROD_STREAM = `events:server:${SERVER_ID}`;
const SHADOW_STREAM = `${PROD_STREAM}:shadow`;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let redis: Redis;

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

function verdict(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function appendEnvelope(
  stream: string,
  input: { type: string; ts: string; payload: unknown },
): Promise<void> {
  await redis.xadd(
    stream,
    '*',
    'envelope',
    JSON.stringify({
      event_id: randomUUID(),
      version: 1,
      server_id: SERVER_ID,
      actor: { kind: 'system', id: null },
      correlation_id: null,
      ...input,
    }),
  );
}

describe('rnsquadjs-shadow-diff CLI', () => {
  before(async () => {
    redis = new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
  });

  beforeEach(async () => {
    await redis.del(PROD_STREAM, SHADOW_STREAM);
  });

  after(async () => {
    await redis.del(PROD_STREAM, SHADOW_STREAM);
    await redis.quit();
  });

  it('returns 0 for equivalent owned events and ignores rcon events', async () => {
    const now = new Date().toISOString();
    const events = [
      { type: 'player.connected', ts: now, payload: { steamId: 'one' } },
      { type: 'match.started', ts: now, payload: { layer: 'Yehorivka' } },
    ];
    for (const event of events) {
      await appendEnvelope(PROD_STREAM, event);
      await appendEnvelope(SHADOW_STREAM, {
        ...event,
        ts: new Date(Date.now() + 2_000).toISOString(),
      });
    }
    await appendEnvelope(PROD_STREAM, { type: 'rcon.response', ts: now, payload: { id: 1 } });
    await appendEnvelope(SHADOW_STREAM, { type: 'rcon.response', ts: now, payload: { id: 2 } });

    const result = runCli([SERVER_ID, '60000', '2']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(verdict(result), {
      serverId: SERVER_ID,
      minEvents: 2,
      prod: 2,
      shadow: 2,
      badRecords: 0,
      extraAllowed: 5,
      gate: 'pass',
      verdict: 'pass',
      parityPct: 100,
      matched: 2,
      missingInShadow: [],
      extraInShadow: [],
      missingTypes: [],
    });
    assert.equal(result.stderr, '');
  });

  it('returns 1 with parity-failed for a payload mismatch and reports the missing type', async () => {
    const now = new Date().toISOString();
    await appendEnvelope(PROD_STREAM, {
      type: 'player.connected',
      ts: now,
      payload: { steamId: 'expected' },
    });
    await appendEnvelope(SHADOW_STREAM, {
      type: 'player.connected',
      ts: now,
      payload: { steamId: 'different' },
    });

    const result = runCli([SERVER_ID, '60000', '1']);
    assert.equal(result.status, 1);
    assert.deepEqual(verdict(result), {
      serverId: SERVER_ID,
      minEvents: 1,
      prod: 1,
      shadow: 1,
      badRecords: 0,
      extraAllowed: 5,
      gate: 'parity-failed',
      verdict: 'fail',
      parityPct: 0,
      matched: 0,
      missingInShadow: [{ type: 'player.connected', ts: now, payload: { steamId: 'expected' } }],
      extraInShadow: [{ type: 'player.connected', ts: now, payload: { steamId: 'different' } }],
      missingTypes: ['player.connected'],
    });
  });

  it('classifies malformed and missing envelopes as corrupt data', async () => {
    await redis.xadd(PROD_STREAM, '*', 'envelope', '{not-json');
    await redis.xadd(PROD_STREAM, '*', 'other-field', 'not-an-envelope');

    const result = runCli([SERVER_ID, '60000', '0']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /warning: skipped 2 malformed stream record\(s\)/);
    assert.deepEqual(verdict(result), {
      serverId: SERVER_ID,
      minEvents: 0,
      prod: 0,
      shadow: 0,
      badRecords: 2,
      extraAllowed: 5,
      gate: 'corrupt-data',
      verdict: 'fail',
      parityPct: 100,
      matched: 0,
      missingInShadow: [],
      extraInShadow: [],
      missingTypes: [],
    });
  });

  it('fails closed when semantically invalid envelopes accompany a valid comparison', async () => {
    // Regression: before the fix, the corrupt-data gate only tripped when
    // `prod.length === 0`, so a handful of corrupted records mixed in with
    // otherwise-valid production events passed silently (gate stayed 'pass').
    const now = new Date().toISOString();
    const valid = { type: 'player.connected', ts: now, payload: { steamId: 'valid' } };
    await appendEnvelope(PROD_STREAM, valid);
    await appendEnvelope(SHADOW_STREAM, valid);

    const base = {
      event_id: randomUUID(),
      version: 1,
      type: 'player.connected',
      server_id: SERVER_ID,
      ts: now,
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload: { steamId: 'invalid' },
    };
    const missingPayload = { ...base } as Record<string, unknown>;
    delete missingPayload.payload;
    const invalidEnvelopes = [
      { ...base, event_id: 'not-a-uuid' },
      { ...base, version: 0 },
      { ...base, type: '' },
      { ...base, server_id: randomUUID() },
      { ...base, ts: 'not-a-timestamp' },
      missingPayload,
    ];
    for (const envelope of invalidEnvelopes) {
      await redis.xadd(PROD_STREAM, '*', 'envelope', JSON.stringify(envelope));
    }

    const result = runCli([SERVER_ID, '60000', '1']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /warning: skipped 6 malformed stream record\(s\)/);
    assert.deepEqual(verdict(result), {
      serverId: SERVER_ID,
      minEvents: 1,
      prod: 1,
      shadow: 1,
      badRecords: 6,
      extraAllowed: 5,
      gate: 'corrupt-data',
      verdict: 'fail',
      parityPct: 100,
      matched: 1,
      missingInShadow: [],
      extraInShadow: [],
      missingTypes: [],
    });
  });

  it('uses exact missing-input exit codes for absent arguments and empty streams', () => {
    const missingArgument = runCli([]);
    assert.equal(missingArgument.status, 2);
    assert.match(missingArgument.stderr, /^usage: rnsquadjs-shadow-diff\.mjs/);
    assert.equal(missingArgument.stdout, '');

    const emptyStreams = runCli([SERVER_ID, '60000', '1']);
    assert.equal(emptyStreams.status, 1);
    assert.equal(verdict(emptyStreams).gate, 'insufficient-data');
  });

  it('enforces the five-extra boundary before returning extras-exceeded', async () => {
    const now = new Date().toISOString();
    const expected = { type: 'match.ended', ts: now, payload: { match: 'expected' } };
    await appendEnvelope(PROD_STREAM, expected);
    await appendEnvelope(SHADOW_STREAM, expected);
    for (let index = 0; index < 5; index += 1) {
      await appendEnvelope(SHADOW_STREAM, {
        type: 'match.ended',
        ts: now,
        payload: { match: `extra-${index}` },
      });
    }

    const boundary = runCli([SERVER_ID, '60000', '1']);
    assert.equal(boundary.status, 0, boundary.stderr);
    assert.equal(verdict(boundary).gate, 'pass');
    assert.equal((verdict(boundary).extraInShadow as unknown[]).length, 5);

    await appendEnvelope(SHADOW_STREAM, {
      type: 'match.ended',
      ts: now,
      payload: { match: 'extra-5' },
    });
    const exceeded = runCli([SERVER_ID, '60000', '1']);
    assert.equal(exceeded.status, 1);
    assert.equal(verdict(exceeded).gate, 'extras-exceeded');
    assert.equal((verdict(exceeded).extraInShadow as unknown[]).length, 6);
  });

  it('rejects non-integer, negative, and non-numeric minimums with exit 2', () => {
    for (const minimum of ['-1', '1.5', 'not-a-number']) {
      const result = runCli([SERVER_ID, '60000', minimum]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, new RegExp(`invalid minEvents: ${minimum}`));
      assert.equal(result.stdout, '');
    }
  });

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
});
