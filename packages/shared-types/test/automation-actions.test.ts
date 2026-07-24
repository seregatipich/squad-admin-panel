import { describe, expect, it, vi } from 'vitest';
import {
  type AutomationRunDraft,
  type NotifyDispatch,
  type RconDispatch,
  type RunMatchDeps,
  runMatch,
} from '../src/automation-actions.js';
import type { AutomationMatch } from '../src/automation-engine.js';

const SERVER = '00000000-0000-0000-0000-0000000000aa';

function match(overrides: Partial<AutomationMatch>): AutomationMatch {
  return {
    ruleId: 'rule-1',
    ruleName: 'r',
    serverId: SERVER,
    conditionType: 'chat_keyword',
    actionType: 'warn',
    action: { message: 'hi' },
    matched: { keyword: 'hello' },
    player: { playerId: 'p1', steamId64: '76561190000000001', eosId: null, name: 'Alice' },
    ...overrides,
  };
}

function makeDeps() {
  const enqueued: RconDispatch[] = [];
  const notified: NotifyDispatch[] = [];
  const runs: AutomationRunDraft[] = [];
  const audits: unknown[] = [];
  const deps: RunMatchDeps = {
    enqueueRcon: vi.fn(async (d: RconDispatch) => {
      enqueued.push(d);
    }),
    notifyAdmin: vi.fn(async (_m, d: NotifyDispatch) => {
      notified.push(d);
      return { delivered: true, detail: { channels: d.channels } };
    }),
    recordRun: vi.fn(async (d: AutomationRunDraft) => {
      runs.push(d);
    }),
    writeAudit: vi.fn(async (d) => {
      audits.push(d);
    }),
  };
  return { deps, enqueued, notified, runs, audits };
}

describe('runMatch — real firing', () => {
  it('warn builds an AdminWarn for the resolved target and records executed', async () => {
    const { deps, enqueued, runs, audits } = makeDeps();
    const draft = await runMatch(deps, match({ actionType: 'warn', action: { message: 'stop' } }), {
      dryRun: false,
    });
    expect(enqueued).toEqual([
      { serverId: SERVER, command: 'AdminWarn', args: ['76561190000000001', 'stop'] },
    ]);
    expect(draft.status).toBe('executed');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.dryRun).toBe(false);
    expect(audits).toHaveLength(1);
  });

  it('kick builds an AdminKick with the reason', async () => {
    const { deps, enqueued } = makeDeps();
    await runMatch(deps, match({ actionType: 'kick', action: { reason: 'afk' } }), {
      dryRun: false,
    });
    expect(enqueued).toEqual([
      { serverId: SERVER, command: 'AdminKick', args: ['76561190000000001', 'afk'] },
    ]);
  });

  it('rcon_command enqueues the configured command verbatim', async () => {
    const { deps, enqueued } = makeDeps();
    await runMatch(
      deps,
      match({
        actionType: 'rcon_command',
        action: { command: 'AdminBroadcast', args: ['seeding now'] },
        player: null,
      }),
      { dryRun: false },
    );
    expect(enqueued).toEqual([
      { serverId: SERVER, command: 'AdminBroadcast', args: ['seeding now'] },
    ]);
  });

  it('notify_admin routes to the sink, not RCON', async () => {
    const { deps, enqueued, notified, runs } = makeDeps();
    const draft = await runMatch(
      deps,
      match({ actionType: 'notify_admin', action: { message: 'wake up', channels: ['email'] } }),
      { dryRun: false },
    );
    expect(enqueued).toHaveLength(0);
    expect(notified).toEqual([{ message: 'wake up', channels: ['email'] }]);
    expect(draft.status).toBe('executed');
    expect(runs[0]?.actionResult).toMatchObject({ delivered: true });
  });

  it('records skipped when a kick has no resolvable target', async () => {
    const { deps, enqueued, runs } = makeDeps();
    const draft = await runMatch(
      deps,
      match({ actionType: 'kick', action: { reason: '' }, player: null }),
      {
        dryRun: false,
      },
    );
    expect(enqueued).toHaveLength(0);
    expect(draft.status).toBe('skipped');
    expect(runs[0]?.actionResult).toMatchObject({ reason: 'no_target' });
  });

  it('records skipped when a warn has no resolvable target', async () => {
    const { deps, enqueued, runs } = makeDeps();
    const draft = await runMatch(
      deps,
      match({ actionType: 'warn', action: { message: 'x' }, player: null }),
      { dryRun: false },
    );
    expect(enqueued).toHaveLength(0);
    expect(draft.status).toBe('skipped');
    expect(runs[0]?.actionResult).toMatchObject({ reason: 'no_target' });
  });

  it('records skipped/no_server when the match has no server', async () => {
    const { deps, enqueued, runs } = makeDeps();
    const draft = await runMatch(
      deps,
      // biome-ignore lint/suspicious/noExplicitAny: serverId is non-null in the AutomationMatch type; exercise the defensive no-server guard
      match({ serverId: null as any, actionType: 'warn', action: { message: 'x' } }),
      { dryRun: false },
    );
    expect(enqueued).toHaveLength(0);
    expect(draft.status).toBe('skipped');
    expect(runs[0]?.actionResult).toMatchObject({ reason: 'no_server' });
  });

  it('resolves the RCON target by steamId64, then eosId, then name', async () => {
    const { deps, enqueued } = makeDeps();
    await runMatch(
      deps,
      match({
        actionType: 'warn',
        action: { message: 'hi' },
        player: { playerId: 'p2', steamId64: null, eosId: 'eos-xyz', name: 'Bob' },
      }),
      { dryRun: false },
    );
    expect(enqueued[0]?.args?.[0]).toBe('eos-xyz');
  });

  it('falls back to the player name when steamId64 and eosId are absent', async () => {
    const { deps, enqueued } = makeDeps();
    await runMatch(
      deps,
      match({
        actionType: 'warn',
        action: { message: 'hi' },
        player: { playerId: 'p3', steamId64: null, eosId: null, name: 'Carol' },
      }),
      { dryRun: false },
    );
    expect(enqueued[0]?.args?.[0]).toBe('Carol');
  });

  it('records skipped when the player has no resolvable identifier at all', async () => {
    const { deps, enqueued, runs } = makeDeps();
    const draft = await runMatch(
      deps,
      match({
        actionType: 'warn',
        action: { message: 'hi' },
        player: { playerId: 'p4', steamId64: null, eosId: null, name: null },
      }),
      { dryRun: false },
    );
    expect(enqueued).toHaveLength(0);
    expect(draft.status).toBe('skipped');
    expect(runs[0]?.actionResult).toMatchObject({ reason: 'no_target' });
  });

  it('records failed when the enqueue throws', async () => {
    const { deps, runs } = makeDeps();
    (deps.enqueueRcon as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis down'));
    const draft = await runMatch(deps, match({ actionType: 'warn', action: { message: 'x' } }), {
      dryRun: false,
    });
    expect(draft.status).toBe('failed');
    expect(runs[0]?.actionResult).toMatchObject({ error: 'redis down' });
  });

  it('records skipped/unbuildable for an unrecognized action type', async () => {
    const { deps, enqueued, runs } = makeDeps();
    const draft = await runMatch(
      deps,
      // biome-ignore lint/suspicious/noExplicitAny: exercising the defensive fallthrough for an out-of-enum action type
      match({ actionType: 'teleport' as any, action: {} }),
      { dryRun: false },
    );
    expect(enqueued).toHaveLength(0);
    expect(draft.status).toBe('skipped');
    expect(runs[0]?.actionResult).toMatchObject({ reason: 'unbuildable' });
  });

  it('records failed when notify_admin throws', async () => {
    const { deps, runs } = makeDeps();
    (deps.notifyAdmin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('smtp down'));
    const draft = await runMatch(
      deps,
      match({ actionType: 'notify_admin', action: { message: 'x', channels: [] } }),
      { dryRun: false },
    );
    expect(draft.status).toBe('failed');
    expect(runs[0]?.actionResult).toMatchObject({ error: 'smtp down' });
  });
});

describe('runMatch — dry-run guard', () => {
  it('NEVER enqueues or notifies, but records a run with dry_run=true', async () => {
    const { deps, enqueued, notified, runs, audits } = makeDeps();
    const warnDraft = await runMatch(
      deps,
      match({ actionType: 'warn', action: { message: 'x' } }),
      {
        dryRun: true,
      },
    );
    const kickDraft = await runMatch(deps, match({ actionType: 'kick', action: { reason: 'x' } }), {
      dryRun: true,
    });
    const notifyDraft = await runMatch(
      deps,
      match({ actionType: 'notify_admin', action: { message: 'x', channels: [] } }),
      { dryRun: true },
    );

    expect(enqueued).toHaveLength(0);
    expect(notified).toHaveLength(0);
    for (const draft of [warnDraft, kickDraft, notifyDraft]) {
      expect(draft.dryRun).toBe(true);
      expect(draft.status).toBe('matched');
      expect(draft.actionResult).toMatchObject({ skipped: true, dryRun: true });
    }
    expect(runs).toHaveLength(3);
    expect(audits).toHaveLength(3);
    expect(runs.every((r) => r.dryRun === true)).toBe(true);
  });

  it('a dry-run intent still previews the command that would run', async () => {
    const { deps, runs } = makeDeps();
    await runMatch(deps, match({ actionType: 'kick', action: { reason: 'afk' } }), {
      dryRun: true,
    });
    expect(runs[0]?.actionResult).toMatchObject({
      intent: { kind: 'rcon', command: 'AdminKick', args: ['76561190000000001', 'afk'] },
    });
  });
});
