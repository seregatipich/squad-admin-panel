import type {
  AutomationMatch,
  AutomationRuleInput,
  AutomationRunDraft,
  AutomationTriggerInput,
  EventEnvelope,
} from '@squad/shared-types';
import { evaluate } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

/**
 * Runtime glue that turns the AUTO-1 (#72) event streams into rule firings.
 *
 * `processAutomationEnvelope` is called once per envelope the automation
 * worker's dispatch loop reads. It maps the envelope to an
 * {@link AutomationTriggerInput}, evaluates the enabled rules with the pure
 * engine, and executes each match through `runMatch` (never a dry-run). The
 * `chat_keyword` condition is NOT handled here — chat is not on the event
 * stream, so it is evaluated inline in `@squad/worker-log-ingest`.
 */

export const DEFAULT_TIME_OF_DAY_COOLDOWN_SECONDS = 3_600;

export interface AutomationRuntimeDeps {
  loadRules: () => Promise<AutomationRuleInput[]>;
  resolvePlayerFlags: (ref: {
    steamId64: string | null;
    eosId: string | null;
  }) => Promise<string[]>;
  runMatch: (match: AutomationMatch, opts: { dryRun: boolean }) => Promise<AutomationRunDraft>;
  redis: Pick<Redis, 'set'>;
  now?: () => Date;
  timeOfDayCooldownSeconds?: number;
  log?: Pick<Logger, 'error'>;
}

function readPlayerCount(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const players = (payload as { players?: unknown }).players;
  return Array.isArray(players) ? players.length : null;
}

function readConnectedPlayer(
  payload: unknown,
): { steamId64: string | null; eosId: string | null; name: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { steam_id64?: unknown; eos_id?: unknown; name?: unknown };
  return {
    steamId64: typeof p.steam_id64 === 'string' ? p.steam_id64 : null,
    eosId: typeof p.eos_id === 'string' ? p.eos_id : null,
    name: typeof p.name === 'string' ? p.name : null,
  };
}

/**
 * Builds the trigger input for an envelope. Returns `null` for event kinds the
 * automation engine never keys off (there is nothing to evaluate). `now` is
 * always set so `time_of_day` rules evaluate on any kept event.
 */
async function buildTriggerInput(
  deps: AutomationRuntimeDeps,
  envelope: EventEnvelope,
  now: Date,
): Promise<AutomationTriggerInput | null> {
  const base: AutomationTriggerInput = { serverId: envelope.server_id, now };
  if (envelope.type === 'rcon.players_polled') {
    return { ...base, playerCount: readPlayerCount(envelope.payload) };
  }
  if (envelope.type === 'player.connected') {
    const ref = readConnectedPlayer(envelope.payload);
    if (!ref) return base;
    const flags = await deps.resolvePlayerFlags({ steamId64: ref.steamId64, eosId: ref.eosId });
    return {
      ...base,
      playerFlags: flags,
      player: { playerId: envelope.actor?.id ?? null, ...ref },
    };
  }
  // Any other kind still lets time_of_day rules evaluate off `now`.
  return base;
}

/**
 * Claims a per-rule cooldown so a `time_of_day` rule fires at most once per
 * cooldown window instead of on every event that arrives inside the window.
 * Returns `true` when the firing is allowed to proceed.
 */
async function claimTimeOfDayCooldown(
  deps: AutomationRuntimeDeps,
  ruleId: string,
): Promise<boolean> {
  const seconds = deps.timeOfDayCooldownSeconds ?? DEFAULT_TIME_OF_DAY_COOLDOWN_SECONDS;
  const claimed = await deps.redis.set(`automation:tod:${ruleId}`, '1', 'EX', seconds, 'NX');
  return claimed === 'OK';
}

/**
 * Evaluates the enabled rules against one envelope and fires every match.
 * Returns the drafts recorded (for tests / metrics). Never throws — a failure
 * evaluating or firing one envelope is logged and swallowed so the consumer
 * loop keeps running.
 */
export async function processAutomationEnvelope(
  deps: AutomationRuntimeDeps,
  envelope: EventEnvelope,
): Promise<AutomationRunDraft[]> {
  const now = deps.now?.() ?? new Date();
  const drafts: AutomationRunDraft[] = [];
  try {
    const input = await buildTriggerInput(deps, envelope, now);
    if (!input) return drafts;
    const rules = await deps.loadRules();
    const matches = evaluate(input, rules);
    for (const match of matches) {
      if (
        match.conditionType === 'time_of_day' &&
        !(await claimTimeOfDayCooldown(deps, match.ruleId))
      ) {
        continue;
      }
      drafts.push(await deps.runMatch(match, { dryRun: false }));
    }
  } catch (err) {
    deps.log?.error(
      { err: (err as Error).message, eventId: envelope.event_id },
      'automation rule processing failed',
    );
  }
  return drafts;
}
