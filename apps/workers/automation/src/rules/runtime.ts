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
 * engine, and executes each match through `runMatch` (never a dry-run).
 * `time_of_day` rules are rate-limited by a per-rule cooldown and
 * `player_count` rules are edge-triggered per server (they fire on the
 * false→true transition, not on every roster poll). The
 * `chat_keyword` condition is NOT handled here — chat is not on the event
 * stream, so it is evaluated inline in `@squad/worker-log-ingest`.
 */

export const DEFAULT_TIME_OF_DAY_COOLDOWN_SECONDS = 3_600;

/**
 * Lifetime of a `player_count` rule's "condition already true" latch. Every
 * roster poll (~2 s) that still matches refreshes it, so it only lapses when
 * polls stop (server down, worker-rcon stalled) — the next matching poll after
 * that fires again.
 */
export const PLAYER_COUNT_LATCH_TTL_SECONDS = 600;

export interface AutomationRuntimeDeps {
  loadRules: () => Promise<AutomationRuleInput[]>;
  resolvePlayerFlags: (ref: {
    steamId64: string | null;
    eosId: string | null;
  }) => Promise<string[]>;
  runMatch: (match: AutomationMatch, opts: { dryRun: boolean }) => Promise<AutomationRunDraft>;
  redis: Pick<Redis, 'set' | 'del' | 'expire'>;
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

function playerCountLatchKey(ruleId: string, serverId: string | null): string {
  return `automation:pc:${ruleId}:${serverId ?? 'global'}`;
}

/**
 * Edge-triggers a `player_count` rule: `rcon.players_polled` arrives on every
 * roster poll, so a level-triggered rule would fire every ~2 s while the
 * condition holds. The first matching poll sets a per-(rule, server) latch and
 * fires; later matching polls only refresh the latch. Returns `true` when this
 * poll is the false→true transition and the firing may proceed.
 */
async function claimPlayerCountEdge(
  deps: AutomationRuntimeDeps,
  match: AutomationMatch,
): Promise<boolean> {
  const key = playerCountLatchKey(match.ruleId, match.serverId);
  const claimed = await deps.redis.set(key, '1', 'EX', PLAYER_COUNT_LATCH_TTL_SECONDS, 'NX');
  if (claimed === 'OK') return true;
  await deps.redis.expire(key, PLAYER_COUNT_LATCH_TTL_SECONDS);
  return false;
}

/**
 * Re-arms every in-scope `player_count` rule whose condition is false on this
 * roster poll, so it fires again on the next false→true transition. Only a
 * poll carrying a real count may re-arm: other envelopes have no count and
 * say nothing about the condition.
 */
async function rearmPlayerCountRules(
  deps: AutomationRuntimeDeps,
  input: AutomationTriggerInput,
  rules: readonly AutomationRuleInput[],
  matches: readonly AutomationMatch[],
): Promise<void> {
  if (typeof input.playerCount !== 'number') return;
  const matchedRuleIds = new Set(matches.map((match) => match.ruleId));
  const keys = rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.conditionType === 'player_count' &&
        (rule.serverId === null || rule.serverId === input.serverId) &&
        !matchedRuleIds.has(rule.id),
    )
    .map((rule) => playerCountLatchKey(rule.id, input.serverId));
  if (keys.length > 0) await deps.redis.del(...keys);
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
    await rearmPlayerCountRules(deps, input, rules, matches);
    for (const match of matches) {
      if (
        match.conditionType === 'time_of_day' &&
        !(await claimTimeOfDayCooldown(deps, match.ruleId))
      ) {
        continue;
      }
      if (match.conditionType === 'player_count' && !(await claimPlayerCountEdge(deps, match))) {
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
