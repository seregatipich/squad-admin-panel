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
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

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
