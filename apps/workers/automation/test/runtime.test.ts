import { randomUUID } from 'node:crypto';
import {
  auditLog,
  automationRules,
  automationRuns,
  createDatabaseClient,
  type DatabaseClient,
} from '@squad/db';
import type { AutomationRuleInput, EventEnvelope } from '@squad/shared-types';
import { rconCommandStream, runMatch } from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import {
  createRunMatchDeps,
  loadEnabledAutomationRules,
  resolvePlayerFlags,
} from '../src/rules/deps.js';
import { type AutomationRuntimeDeps, processAutomationEnvelope } from '../src/rules/runtime.js';

function envelope(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    event_id: randomUUID(),
    version: 1,
    type: 'rcon.players_polled',
    server_id: randomUUID(),
    ts: new Date().toISOString(),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: {},
    ...overrides,
  };
}

function playerCountRule(): AutomationRuleInput {
  return {
    id: randomUUID(),
    serverId: null,
    name: 'full server broadcast',
    conditionType: 'player_count',
    condition: { operator: 'gte', threshold: 2 },
    actionType: 'rcon_command',
    action: { command: 'AdminBroadcast', args: ['full'] },
    enabled: true,
  };
}

describe('processAutomationEnvelope — mapping & cooldown (mocked deps)', () => {
  function makeDeps(overrides: Partial<AutomationRuntimeDeps> = {}): {
    deps: AutomationRuntimeDeps;
    fired: unknown[];
    setCalls: unknown[][];
  } {
    const fired: unknown[] = [];
    const setCalls: unknown[][] = [];
    const deps: AutomationRuntimeDeps = {
      loadRules: async () => [playerCountRule()],
      resolvePlayerFlags: async () => [],
      runMatch: async (match) => {
        fired.push(match);
        return {
          ruleId: match.ruleId,
          serverId: match.serverId,
          matched: {},
          actionResult: {},
          dryRun: false,
          status: 'executed',
        };
      },
      redis: {
        set: vi.fn(async (...args: unknown[]) => {
          setCalls.push(args);
          return 'OK';
        }),
        del: vi.fn(async () => 0),
        expire: vi.fn(async () => 1),
      } as never,
      ...overrides,
    };
    return { deps, fired, setCalls };
  }

  it('fires a player_count rule from an rcon.players_polled tick', async () => {
    const { deps, fired } = makeDeps();
    await processAutomationEnvelope(
      deps,
      envelope({ type: 'rcon.players_polled', payload: { players: [{}, {}, {}] } }),
    );
    expect(fired).toHaveLength(1);
  });

  it('does not fire player_count when the count is under threshold', async () => {
    const { deps, fired } = makeDeps();
    await processAutomationEnvelope(
      deps,
      envelope({ type: 'rcon.players_polled', payload: { players: [{}] } }),
    );
    expect(fired).toHaveLength(0);
  });

  it('resolves player flags for a player.connected event', async () => {
    const resolvePlayerFlags = vi.fn(async () => ['watched']);
    const flagRule: AutomationRuleInput = {
      id: randomUUID(),
      serverId: null,
      name: 'watch',
      conditionType: 'player_flag',
      condition: { flag: 'watched', present: true },
      actionType: 'warn',
      action: { message: 'you are watched' },
      enabled: true,
    };
    const { deps, fired } = makeDeps({ loadRules: async () => [flagRule], resolvePlayerFlags });
    await processAutomationEnvelope(
      deps,
      envelope({
        type: 'player.connected',
        payload: { steam_id64: '76561190000000001', eos_id: null, name: 'Bob', ip: null },
      }),
    );
    expect(resolvePlayerFlags).toHaveBeenCalledWith({
      steamId64: '76561190000000001',
      eosId: null,
    });
    expect(fired).toHaveLength(1);
  });

  it('skips the players lookup when no enabled rule matches on player flags', async () => {
    const resolvePlayerFlags = vi.fn(async () => ['watched']);
    const { deps } = makeDeps({ resolvePlayerFlags });
    await processAutomationEnvelope(
      deps,
      envelope({
        type: 'player.connected',
        payload: { steam_id64: '76561190000000001', eos_id: null, name: 'Bob', ip: null },
      }),
    );
    expect(resolvePlayerFlags).not.toHaveBeenCalled();
  });

  it('gates a time_of_day rule behind the per-rule cooldown', async () => {
    const todRule: AutomationRuleInput = {
      id: randomUUID(),
      serverId: null,
      name: 'nightly',
      conditionType: 'time_of_day',
      condition: { startMinute: 0, endMinute: 1439, timezone: 'UTC' },
      actionType: 'rcon_command',
      action: { command: 'AdminBroadcast', args: ['night'] },
      enabled: true,
    };
    // First tick claims the cooldown (set → 'OK') and fires; second is gated (set → null).
    const setImpl = vi
      .fn<(...a: unknown[]) => Promise<string | null>>()
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null);
    const { deps, fired } = makeDeps({
      loadRules: async () => [todRule],
      redis: { set: setImpl } as never,
    });
    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', payload: {} }));
    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', payload: {} }));
    expect(setImpl).toHaveBeenCalledTimes(2);
    expect(fired).toHaveLength(1);
  });

  function globalTimeOfDayRule(
    actionType: AutomationRuleInput['actionType'] = 'rcon_command',
  ): AutomationRuleInput {
    return {
      id: randomUUID(),
      serverId: null,
      name: 'nightly everywhere',
      conditionType: 'time_of_day',
      condition: { startMinute: 0, endMinute: 1439, timezone: 'UTC' },
      actionType,
      action:
        actionType === 'notify_admin'
          ? { message: 'night', channels: [] }
          : { command: 'AdminBroadcast', args: ['night'] },
      enabled: true,
    };
  }

  /** A Redis `SET NX` / `DEL` fake that honours key existence, like the real cooldown. */
  function cooldownRedis() {
    const keys = new Set<string>();
    return {
      keys,
      redis: {
        set: vi.fn(async (key: string) => {
          if (keys.has(key)) return null;
          keys.add(key);
          return 'OK';
        }),
        del: vi.fn(async (key: string) => (keys.delete(key) ? 1 : 0)),
      },
    };
  }

  it('keeps a separate time_of_day cooldown per server for a global rule (#842)', async () => {
    const rule = globalTimeOfDayRule();
    const { redis } = cooldownRedis();
    const { deps, fired } = makeDeps({ loadRules: async () => [rule], redis: redis as never });
    const serverA = randomUUID();
    const serverB = randomUUID();

    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: serverA }));
    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: serverB }));
    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: serverA }));

    expect(fired.map((m) => (m as { serverId: string }).serverId)).toEqual([serverA, serverB]);
  });

  it('never spends a server-bound time_of_day cooldown on a serverless events:global envelope (#842)', async () => {
    const rule = globalTimeOfDayRule();
    const { redis, keys } = cooldownRedis();
    const { deps, fired } = makeDeps({ loadRules: async () => [rule], redis: redis as never });
    const serverId = randomUUID();

    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: null }));
    expect(fired).toHaveLength(0);
    expect(keys.size).toBe(0);

    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: serverId }));
    expect(fired).toHaveLength(1);
  });

  it('still fires a serverless notify_admin time_of_day rule once per window', async () => {
    const rule = globalTimeOfDayRule('notify_admin');
    const { redis } = cooldownRedis();
    const { deps, fired } = makeDeps({ loadRules: async () => [rule], redis: redis as never });

    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: null }));
    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: null }));

    expect(fired).toHaveLength(1);
  });

  it('releases the time_of_day cooldown when the firing fails so the next event retries (#842)', async () => {
    const rule = globalTimeOfDayRule();
    const { redis, keys } = cooldownRedis();
    const runMatch = vi
      .fn<AutomationRuntimeDeps['runMatch']>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockImplementation(async (match) => ({
        ruleId: match.ruleId,
        serverId: match.serverId,
        matched: {},
        actionResult: { error: 'rcon offline' },
        dryRun: false,
        status: 'failed',
      }));
    const { deps } = makeDeps({
      loadRules: async () => [rule],
      redis: redis as never,
      runMatch,
      log: { error: vi.fn() },
    });
    const serverId = randomUUID();

    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: serverId }));
    expect(keys.size).toBe(0);
    await processAutomationEnvelope(deps, envelope({ type: 'server.ready', server_id: serverId }));
    expect(keys.size).toBe(0);
    expect(runMatch).toHaveBeenCalledTimes(2);
  });

  it('rejects when the rules cannot be loaded so the dispatcher leaves the entry pending (#841)', async () => {
    const { deps } = makeDeps({
      loadRules: async () => {
        throw new Error('database unavailable');
      },
    });

    await expect(
      processAutomationEnvelope(deps, envelope({ type: 'server.ready', payload: {} })),
    ).rejects.toThrow('database unavailable');
  });
});

describe('processAutomationEnvelope — player_count is edge-triggered (real Redis, #34)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(
      process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/13',
    );
  });

  afterAll(async () => {
    await redis?.quit().catch(() => undefined);
  });

  function edgeDeps(rule: AutomationRuleInput): { deps: AutomationRuntimeDeps; fired: string[] } {
    const fired: string[] = [];
    const deps: AutomationRuntimeDeps = {
      loadRules: async () => [rule],
      resolvePlayerFlags: async () => [],
      runMatch: async (match) => {
        fired.push(match.serverId ?? 'global');
        return {
          ruleId: match.ruleId,
          serverId: match.serverId,
          matched: {},
          actionResult: {},
          dryRun: false,
          status: 'executed',
        };
      },
      redis,
    };
    return { deps, fired };
  }

  const poll = (serverId: string, count: number) =>
    envelope({
      type: 'rcon.players_polled',
      server_id: serverId,
      payload: { players: Array.from({ length: count }, () => ({})) },
    });

  it('fires once while the count stays above the threshold, again only after it drops', async () => {
    const rule = playerCountRule();
    const serverId = randomUUID();
    const { deps, fired } = edgeDeps(rule);

    await processAutomationEnvelope(deps, poll(serverId, 3));
    await processAutomationEnvelope(deps, poll(serverId, 3));
    await processAutomationEnvelope(deps, poll(serverId, 4));
    expect(fired).toHaveLength(1);

    await processAutomationEnvelope(deps, poll(serverId, 1));
    await processAutomationEnvelope(deps, poll(serverId, 3));
    expect(fired).toHaveLength(2);

    await redis.del(`automation:pc:${rule.id}:${serverId}`);
  });

  it('tracks the edge per server for a global rule', async () => {
    const rule = playerCountRule();
    const [serverA, serverB] = [randomUUID(), randomUUID()];
    const { deps, fired } = edgeDeps(rule);

    await processAutomationEnvelope(deps, poll(serverA, 3));
    await processAutomationEnvelope(deps, poll(serverB, 3));
    await processAutomationEnvelope(deps, poll(serverA, 3));
    expect(fired).toEqual([serverA, serverB]);

    await redis.del(`automation:pc:${rule.id}:${serverA}`, `automation:pc:${rule.id}:${serverB}`);
  });

  it('a player.connected event carries no count and never re-arms the latch', async () => {
    const rule = playerCountRule();
    const serverId = randomUUID();
    const { deps, fired } = edgeDeps(rule);

    await processAutomationEnvelope(deps, poll(serverId, 3));
    await processAutomationEnvelope(
      deps,
      envelope({ type: 'player.connected', server_id: serverId, payload: {} }),
    );
    await processAutomationEnvelope(deps, poll(serverId, 3));
    expect(fired).toHaveLength(1);

    await redis.del(`automation:pc:${rule.id}:${serverId}`);
  });
});

describeIfDb('processAutomationEnvelope — real DB + Redis firing', () => {
  let db: DatabaseClient;
  let redis: Redis;
  let ruleId: string;

  beforeAll(async () => {
    db = createDatabaseClient(process.env.DATABASE_URL as string);
    redis = new Redis(
      process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/13',
    );
    const [row] = await db
      .insert(automationRules)
      .values({
        serverId: null,
        name: `rt-fire-${Date.now()}`,
        conditionType: 'player_count',
        condition: { operator: 'gte', threshold: 2 },
        actionType: 'rcon_command',
        action: { command: 'AdminBroadcast', args: ['full server'] },
        enabled: true,
      })
      .returning({ id: automationRules.id });
    ruleId = row?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (ruleId) await db.delete(automationRules).where(eq(automationRules.id, ruleId));
    await redis?.quit().catch(() => undefined);
  });

  it('an enabled player_count rule fires: RCON enqueued + run + audit rows', async () => {
    const serverId = randomUUID();
    const streamKey = rconCommandStream(serverId);
    const before = await redis.xlen(streamKey);

    const deps: AutomationRuntimeDeps = {
      loadRules: () => loadEnabledAutomationRules(db),
      resolvePlayerFlags: (ref) => resolvePlayerFlags(db, ref),
      runMatch: (match, opts) =>
        runMatch(createRunMatchDeps(db, redis, pino({ level: 'silent' })), match, opts),
      redis,
    };

    const drafts = await processAutomationEnvelope(
      deps,
      envelope({
        type: 'rcon.players_polled',
        server_id: serverId,
        payload: { players: [{}, {}, {}], polled_at: new Date().toISOString(), latency_ms: 5 },
      }),
    );

    expect(drafts.some((d) => d.ruleId === ruleId && d.status === 'executed')).toBe(true);

    const after = await redis.xlen(streamKey);
    expect(after).toBe(before + 1);

    const runs = await db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.ruleId, ruleId), eq(automationRuns.dryRun, false)));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.some((r) => r.status === 'executed')).toBe(true);

    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, ruleId));
    expect(audits.some((a) => a.actionType === 'automation_rule.fire')).toBe(true);

    await redis.del(streamKey).catch(() => undefined);
  }, 30_000);
});

describe('resolvePlayerFlags — lookup keys (fake db)', () => {
  function fakeDb(rowsBySelect: Array<Array<Record<string, unknown>>>) {
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => rowsBySelect.shift() ?? [] }) }),
    }));
    return { db: { select } as unknown as DatabaseClient, select };
  }

  it('ignores a non-numeric steam id instead of throwing', async () => {
    const { db, select } = fakeDb([]);
    await expect(
      resolvePlayerFlags(db, { steamId64: 'not-a-steam-id', eosId: null }),
    ).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('prefers the steam match over the eos match', async () => {
    const { db, select } = fakeDb([
      [{ steamEosConflict: false, roleId: 'r1', roleExpiresAt: null }],
    ]);
    const flags = await resolvePlayerFlags(db, { steamId64: '76561190000000001', eosId: 'eos1' });
    expect(flags).toEqual(['has_role']);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('falls back to the eos id when the steam id matches no player', async () => {
    const { db } = fakeDb([[], [{ steamEosConflict: true, roleId: null, roleExpiresAt: null }]]);
    const flags = await resolvePlayerFlags(db, { steamId64: '76561190000000001', eosId: 'eos1' });
    expect(flags).toEqual(['steam_eos_conflict']);
  });
});
