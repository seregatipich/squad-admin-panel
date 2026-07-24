import { auditLog, automationRules, automationRuns, type DatabaseClient, players } from '@squad/db';
import type {
  AutomationAuditDraft,
  AutomationMatch,
  AutomationRuleInput,
  AutomationRunDraft,
  NotifyDispatch,
  RconDispatch,
  RconOperatorCommandName,
  RunMatchDeps,
} from '@squad/shared-types';
import { rconCommandRequestSchema, rconCommandStream } from '@squad/shared-types';
import { eq, or } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';

const RCON_STREAM_MAXLEN = 500;

/** Loads the enabled automation rules the worker evaluates against events. */
export async function loadEnabledAutomationRules(
  db: DatabaseClient,
): Promise<AutomationRuleInput[]> {
  const rows = await db.select().from(automationRules).where(eq(automationRules.enabled, true));
  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    conditionType: row.conditionType,
    condition: row.condition,
    actionType: row.actionType,
    action: row.action,
    enabled: row.enabled,
  }));
}

/**
 * Enqueues an operator RCON command onto worker-rcon's per-server command
 * stream. Mirrors `apps/workers/scheduler/src/deps.ts`'s `sendRconCommand`
 * (the API-side helper cannot be imported from a worker package).
 */
export async function sendRconCommand(
  redis: Pick<Redis, 'xadd'>,
  dispatch: RconDispatch,
): Promise<void> {
  const request = rconCommandRequestSchema.parse({
    request_id: uuidv7(),
    command: dispatch.command as RconOperatorCommandName,
    args: dispatch.args,
    actor_player_id: null,
    enqueued_at: new Date().toISOString(),
  });
  await redis.xadd(
    rconCommandStream(dispatch.serverId),
    'MAXLEN',
    '~',
    String(RCON_STREAM_MAXLEN),
    '*',
    'request',
    JSON.stringify(request),
  );
}

/** Appends one firing-history row to `automation_runs`. */
export async function recordAutomationRun(
  db: DatabaseClient,
  draft: AutomationRunDraft,
): Promise<void> {
  await db.insert(automationRuns).values({
    ruleId: draft.ruleId,
    serverId: draft.serverId,
    matched: draft.matched,
    actionResult: draft.actionResult,
    dryRun: draft.dryRun,
    status: draft.status,
  });
}

/** Writes a system-actor audit entry for a rule firing. */
export async function writeAutomationAuditEntry(
  db: DatabaseClient,
  draft: AutomationAuditDraft,
): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: 'system',
    actorPlayerId: null,
    actorTokenId: null,
    actorSystemLabel: 'automation-worker',
    actorIp: null,
    actionType: draft.dryRun ? 'automation_rule.dry_run' : 'automation_rule.fire',
    targetType: 'automation_rule',
    targetId: draft.ruleId,
    beforeSnapshot: null,
    afterSnapshot: null,
    context: {
      serverId: draft.serverId,
      status: draft.status,
      actionType: draft.actionType,
      intent: draft.intent,
    },
    statusCode: null,
    rowHash: Buffer.from([]),
  });
}

/**
 * Derives the set of flags the `player_flag` condition can match against for a
 * connecting player, looked up by the SteamID64/EOS id in the event payload.
 * The flags are the player-state signals directly available on the `players`
 * row; an unknown player (no row) yields an empty set.
 */
export async function resolvePlayerFlags(
  db: DatabaseClient,
  ref: { steamId64: string | null; eosId: string | null },
): Promise<string[]> {
  const filters = [];
  if (ref.steamId64) filters.push(eq(players.steamId64, BigInt(ref.steamId64)));
  if (ref.eosId) filters.push(eq(players.eosId, ref.eosId));
  if (filters.length === 0) return [];
  const rows = await db
    .select({
      steamEosConflict: players.steamEosConflict,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
    })
    .from(players)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(1);
  const row = rows[0];
  if (!row) return [];
  const flags: string[] = [];
  if (row.steamEosConflict) flags.push('steam_eos_conflict');
  if (row.roleId) flags.push('has_role');
  if (row.roleExpiresAt && row.roleExpiresAt.getTime() < Date.now()) flags.push('role_expired');
  return flags;
}

/**
 * Builds the {@link RunMatchDeps} the pure `runMatch` executor calls to perform
 * an action and persist its outcome. `notify_admin` is delivered as a durable
 * `automation_runs` + `audit_log` record (surfaced in the panel's automation
 * history and audit log) plus a warn-level worker log line; external
 * email/web-push delivery is intentionally not wired here (see the AUTO-3 sink,
 * which would need extracting into a shared package — out of scope for #72).
 */
export function createRunMatchDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'xadd'>,
  log: Pick<Logger, 'warn'>,
): RunMatchDeps {
  return {
    enqueueRcon: (dispatch) => sendRconCommand(redis, dispatch),
    notifyAdmin: async (match: AutomationMatch, dispatch: NotifyDispatch) => {
      log.warn(
        { ruleId: match.ruleId, ruleName: match.ruleName, channels: dispatch.channels },
        `automation notify_admin: ${dispatch.message}`,
      );
      return { delivered: false, detail: { channels: dispatch.channels, via: 'audit_log' } };
    },
    recordRun: (draft) => recordAutomationRun(db, draft),
    writeAudit: (draft) => writeAutomationAuditEntry(db, draft),
  };
}
