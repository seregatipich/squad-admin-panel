import type {
  AutomationNotifyChannel,
  AutomationRunStatus,
  KickAction,
  NotifyAdminAction,
  RconCommandAction,
  WarnAction,
} from './automation.js';
import type { AutomationMatch } from './automation-engine.js';
import type { RconOperatorCommandName } from './rcon-commands.js';

/**
 * Action execution for AUTO-1 (#72). Turns an {@link AutomationMatch} into a
 * side effect — an RCON command enqueued onto worker-rcon's stream, or an admin
 * notification through the AUTO-3 sink — and records the outcome as one
 * `automation_runs` row plus one `audit_log` entry, both through injected deps
 * (no direct I/O), so the same code runs in the worker and in the API dry-run.
 *
 * The dry-run guard is the single `if (opts.dryRun)` branch in {@link runMatch}:
 * a dry-run evaluates and records a history row (`dry_run=true`) but NEVER
 * enqueues a command or sends a notification.
 */

/** An RCON command ready to enqueue, resolved from an action + its target. */
export interface RconDispatch {
  serverId: string;
  command: RconOperatorCommandName;
  args: string[];
}

export interface NotifyDispatch {
  message: string;
  channels: AutomationNotifyChannel[];
}

export interface AutomationRunDraft {
  ruleId: string;
  serverId: string | null;
  matched: Record<string, unknown>;
  actionResult: Record<string, unknown> | null;
  dryRun: boolean;
  status: AutomationRunStatus;
}

export interface AutomationAuditDraft {
  ruleId: string;
  serverId: string | null;
  dryRun: boolean;
  status: AutomationRunStatus;
  actionType: AutomationMatch['actionType'];
  intent: Record<string, unknown>;
}

export interface RunMatchDeps {
  enqueueRcon: (dispatch: RconDispatch) => Promise<void>;
  notifyAdmin: (
    match: AutomationMatch,
    dispatch: NotifyDispatch,
  ) => Promise<{ delivered: boolean; detail?: unknown }>;
  recordRun: (draft: AutomationRunDraft) => Promise<void>;
  writeAudit: (draft: AutomationAuditDraft) => Promise<void>;
}

function resolveTarget(match: AutomationMatch): string | null {
  const player = match.player;
  if (!player) return null;
  return player.steamId64 ?? player.eosId ?? player.name ?? null;
}

/**
 * Resolves the concrete RCON dispatch (command + args) an rcon/kick/warn action
 * would perform, or `null` when the action is a `notify_admin` (handled
 * separately). Returns `{ error }` when the action cannot be built (e.g. a kick
 * with no resolvable target, or a rule with no server).
 */
function buildRconDispatch(
  match: AutomationMatch,
): { dispatch: RconDispatch } | { error: string } | null {
  if (match.serverId === null) return { error: 'no_server' };
  switch (match.actionType) {
    case 'rcon_command': {
      const action = match.action as RconCommandAction;
      return { dispatch: { serverId: match.serverId, command: action.command, args: action.args } };
    }
    case 'kick': {
      const action = match.action as KickAction;
      const target = resolveTarget(match);
      if (!target) return { error: 'no_target' };
      return {
        dispatch: { serverId: match.serverId, command: 'AdminKick', args: [target, action.reason] },
      };
    }
    case 'warn': {
      const action = match.action as WarnAction;
      const target = resolveTarget(match);
      if (!target) return { error: 'no_target' };
      return {
        dispatch: {
          serverId: match.serverId,
          command: 'AdminWarn',
          args: [target, action.message],
        },
      };
    }
    default:
      return null;
  }
}

function describeIntent(match: AutomationMatch): Record<string, unknown> {
  if (match.actionType === 'notify_admin') {
    const action = match.action as NotifyAdminAction;
    return { kind: 'notify_admin', message: action.message, channels: action.channels };
  }
  const built = buildRconDispatch(match);
  if (built && 'dispatch' in built) {
    return {
      kind: 'rcon',
      command: built.dispatch.command,
      args: built.dispatch.args,
      serverId: built.dispatch.serverId,
    };
  }
  return { kind: match.actionType, error: built?.error ?? 'unbuildable' };
}

/**
 * Executes (or, for a dry-run, only simulates) one matched rule, then persists
 * a history row and audit entry for it. Returns the recorded draft.
 */
export async function runMatch(
  deps: RunMatchDeps,
  match: AutomationMatch,
  opts: { dryRun: boolean },
): Promise<AutomationRunDraft> {
  const intent = describeIntent(match);

  let status: AutomationRunStatus;
  let actionResult: Record<string, unknown> | null;

  if (opts.dryRun) {
    // Dry-run guard: evaluate and record, but never touch RCON or the sink.
    status = 'matched';
    actionResult = { skipped: true, dryRun: true, intent };
  } else if (match.actionType === 'notify_admin') {
    const action = match.action as NotifyAdminAction;
    try {
      const outcome = await deps.notifyAdmin(match, {
        message: action.message,
        channels: action.channels,
      });
      status = 'executed';
      actionResult = {
        executed: true,
        intent,
        delivered: outcome.delivered,
        detail: outcome.detail,
      };
    } catch (err) {
      status = 'failed';
      actionResult = { intent, error: (err as Error).message };
    }
  } else {
    const built = buildRconDispatch(match);
    if (!built || 'error' in built) {
      status = 'skipped';
      actionResult = { intent, reason: built?.error ?? 'unbuildable' };
    } else {
      try {
        await deps.enqueueRcon(built.dispatch);
        status = 'executed';
        actionResult = { executed: true, intent };
      } catch (err) {
        status = 'failed';
        actionResult = { intent, error: (err as Error).message };
      }
    }
  }

  const draft: AutomationRunDraft = {
    ruleId: match.ruleId,
    serverId: match.serverId,
    matched: match.matched,
    actionResult,
    dryRun: opts.dryRun,
    status,
  };
  await deps.recordRun(draft);
  await deps.writeAudit({
    ruleId: match.ruleId,
    serverId: match.serverId,
    dryRun: opts.dryRun,
    status,
    actionType: match.actionType,
    intent,
  });
  return draft;
}
