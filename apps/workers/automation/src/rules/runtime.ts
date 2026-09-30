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
 * Redis key of the `time_of_day` cooldown for one rule on one server. The
 * server is part of the key so a global rule (`serverId = null`) fires once
 * per window on *each* server it matches, instead of only on whichever
 * server's event happened to arrive first (#842). A serverless firing (an
 * `events:global` envelope, only ever reached by `notify_admin`) gets its own
 * `global` slot.
 */
function timeOfDayCooldownKey(match: AutomationMatch): string {
  return `automation:tod:${match.ruleId}:${match.serverId ?? 'global'}`;
}

/**
 * Claims the cooldown for `match` so a `time_of_day` rule fires at most once
 * per cooldown window instead of on every event that arrives inside the
 * window. Returns `true` when the firing is allowed to proceed.
 */
async function claimTimeOfDayCooldown(
  deps: AutomationRuntimeDeps,
  match: AutomationMatch,
): Promise<boolean> {
  const seconds = deps.timeOfDayCooldownSeconds ?? DEFAULT_TIME_OF_DAY_COOLDOWN_SECONDS;
  const claimed = await deps.redis.set(timeOfDayCooldownKey(match), '1', 'EX', seconds, 'NX');
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
 * Every action except `notify_admin` is an RCON command and needs a target
 * server; `runMatch` records such a firing as `skipped` with `no_server`.
 */
function needsServer(match: AutomationMatch): boolean {
  return match.actionType !== 'notify_admin';
}

/**
 * Fires one match. A `time_of_day` match first claims its per-server
 * cooldown and a `player_count` match its edge latch; when the firing then
 * throws or records `failed`, the claim is released so the next event retries
 * instead of the rule staying silent for the rest of the window. A failure here is logged and swallowed:
 * the other matches of the same envelope still fire.
 */
async function fireMatch(
  deps: AutomationRuntimeDeps,
  match: AutomationMatch,
  eventId: string,
): Promise<AutomationRunDraft | null> {
  const gated = match.conditionType === 'time_of_day';
  if (gated) {
    // A serverless envelope can never execute an RCON action; spending the
    // shared window on it would block the rule everywhere for an hour.
    if (match.serverId === null && needsServer(match)) return null;
    if (!(await claimTimeOfDayCooldown(deps, match))) return null;
  }
  const edgeTriggered = match.conditionType === 'player_count';
  if (edgeTriggered && !(await claimPlayerCountEdge(deps, match))) return null;
  const latchKey = playerCountLatchKey(match.ruleId, match.serverId);
  try {
    const draft = await deps.runMatch(match, { dryRun: false });
    if (gated && draft.status === 'failed') await deps.redis.del(timeOfDayCooldownKey(match));
    if (edgeTriggered && draft.status === 'failed') await deps.redis.del(latchKey);
    return draft;
  } catch (err) {
    deps.log?.error(
      { err: (err as Error).message, eventId, ruleId: match.ruleId },
      'automation rule firing failed',
    );
    if (gated) await deps.redis.del(timeOfDayCooldownKey(match)).catch(() => undefined);
    if (edgeTriggered) await deps.redis.del(latchKey).catch(() => undefined);
    return null;
  }
}

/**
 * Evaluates the enabled rules against one envelope and fires every match.
 * Returns the drafts recorded (for tests / metrics).
 *
 * Rejects when the trigger input or the rule set cannot be built (e.g. the
 * database is unreachable): nothing has fired yet, so the dispatch loop leaves
 * the stream entry pending and it is retried (#841). Once matches are known,
 * each firing is isolated by {@link fireMatch} and never rejects this call —
 * a retry would re-fire the matches that already succeeded.
 */
export async function processAutomationEnvelope(
  deps: AutomationRuntimeDeps,
  envelope: EventEnvelope,
): Promise<AutomationRunDraft[]> {
  const now = deps.now?.() ?? new Date();
  const drafts: AutomationRunDraft[] = [];
  const input = await buildTriggerInput(deps, envelope, now);
  if (!input) return drafts;
  const rules = await deps.loadRules();
  const matches = evaluate(input, rules);
  await rearmPlayerCountRules(deps, input, rules, matches);
  for (const match of matches) {
    const draft = await fireMatch(deps, match, envelope.event_id);
    if (draft) drafts.push(draft);
  }
  return drafts;
}
