import {
  type AutomationActionType,
  type AutomationConditionType,
  type ChatKeywordCondition,
  type PlayerCountCondition,
  type PlayerFlagCondition,
  parseAutomationAction,
  parseAutomationCondition,
  type TimeOfDayCondition,
} from './automation.js';

/**
 * Pure evaluation engine for the AUTO-1 (#72) trigger rules. `evaluate` maps a
 * single trigger (a chat line, an `rcon.players_polled` tick, a
 * `player.connected` event, or a clock tick) plus the set of enabled rules to
 * the rules that fire. It performs no I/O — action execution and history/audit
 * persistence live in `automation-actions.ts`.
 *
 * The logic lives in `@squad/shared-types` (like `cron5.ts`) so both the
 * evaluating worker (`@squad/worker-automation`) and the dry-run API route
 * (`apps/api/src/routes/automation-rules.ts`) share exactly one implementation.
 * Mirrors the AUTO-3 alerts engine (`apps/workers/log-ingest/src/alerts/engine.ts`).
 */

/** One rule row as loaded from `automation_rules`, before condition parsing. */
export interface AutomationRuleInput {
  id: string;
  serverId: string | null;
  name: string;
  conditionType: AutomationConditionType;
  condition: unknown;
  actionType: AutomationActionType;
  action: unknown;
  enabled: boolean;
}

/** The player a chat/player-scoped trigger is about (for kick/warn targeting). */
export interface AutomationPlayerRef {
  playerId: string | null;
  steamId64: string | null;
  eosId: string | null;
  name: string | null;
}

/**
 * The data a single trigger makes available. Each condition type consumes only
 * the fields it needs; a rule whose required field is absent never matches
 * (e.g. a `player_count` rule against a chat trigger that carries no count).
 * `now` is always present, so `time_of_day` rules are evaluable on any trigger.
 */
export interface AutomationTriggerInput {
  serverId: string | null;
  now: Date;
  chatMessage?: string | null;
  playerCount?: number | null;
  playerFlags?: readonly string[] | null;
  player?: AutomationPlayerRef | null;
}

/** A rule that matched a trigger, carrying everything the action layer needs. */
export interface AutomationMatch {
  ruleId: string;
  ruleName: string;
  serverId: string | null;
  conditionType: AutomationConditionType;
  actionType: AutomationActionType;
  action: Record<string, unknown>;
  matched: Record<string, unknown>;
  player: AutomationPlayerRef | null;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zoneMinuteAndWeekday(now: Date, timezone: string): { minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const part of parts) {
    if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
  }
  return { minute: hour * 60 + minute, weekday };
}

/** Inclusive window membership; `end < start` denotes an overnight wrap. */
function inWindow(minute: number, start: number, end: number): boolean {
  return start <= end ? minute >= start && minute <= end : minute >= start || minute <= end;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchChatKeyword(
  input: AutomationTriggerInput,
  config: ChatKeywordCondition,
): Record<string, unknown> | null {
  const message = input.chatMessage;
  if (typeof message !== 'string') return null;
  const haystack = config.caseSensitive ? message : message.toLowerCase();
  const needle = config.caseSensitive ? config.keyword : config.keyword.toLowerCase();
  let hit = false;
  if (config.match === 'exact') {
    hit = haystack.trim() === needle;
  } else if (config.match === 'word') {
    hit = new RegExp(`(^|\\W)${escapeRegExp(needle)}(\\W|$)`).test(haystack);
  } else {
    hit = haystack.includes(needle);
  }
  if (!hit) return null;
  return { keyword: config.keyword, match: config.match, message };
}

function compare(observed: number, operator: PlayerCountCondition['operator'], threshold: number) {
  switch (operator) {
    case 'gte':
      return observed >= threshold;
    case 'lte':
      return observed <= threshold;
    case 'gt':
      return observed > threshold;
    case 'lt':
      return observed < threshold;
    case 'eq':
      return observed === threshold;
    default:
      return false;
  }
}

function matchPlayerCount(
  input: AutomationTriggerInput,
  config: PlayerCountCondition,
): Record<string, unknown> | null {
  const observed = input.playerCount;
  if (typeof observed !== 'number' || !Number.isFinite(observed)) return null;
  if (!compare(observed, config.operator, config.threshold)) return null;
  return { operator: config.operator, threshold: config.threshold, observed };
}

function matchTimeOfDay(
  input: AutomationTriggerInput,
  config: TimeOfDayCondition,
): Record<string, unknown> | null {
  let position: { minute: number; weekday: number };
  try {
    position = zoneMinuteAndWeekday(input.now, config.timezone);
  } catch {
    return null;
  }
  if (
    config.weekdays &&
    config.weekdays.length > 0 &&
    !config.weekdays.includes(position.weekday)
  ) {
    return null;
  }
  if (!inWindow(position.minute, config.startMinute, config.endMinute)) return null;
  return {
    minute: position.minute,
    weekday: position.weekday,
    startMinute: config.startMinute,
    endMinute: config.endMinute,
    timezone: config.timezone,
  };
}

function matchPlayerFlag(
  input: AutomationTriggerInput,
  config: PlayerFlagCondition,
): Record<string, unknown> | null {
  const flags = input.playerFlags;
  if (!flags) return null;
  const has = flags.includes(config.flag);
  if (has !== config.present) return null;
  return { flag: config.flag, present: config.present, has };
}

function evaluateCondition(
  input: AutomationTriggerInput,
  rule: AutomationRuleInput,
): Record<string, unknown> | null {
  const parsed = parseAutomationCondition(rule.conditionType, rule.condition);
  if (!parsed.success) return null;
  switch (rule.conditionType) {
    case 'chat_keyword':
      return matchChatKeyword(input, parsed.data as ChatKeywordCondition);
    case 'player_count':
      return matchPlayerCount(input, parsed.data as PlayerCountCondition);
    case 'time_of_day':
      return matchTimeOfDay(input, parsed.data as TimeOfDayCondition);
    case 'player_flag':
      return matchPlayerFlag(input, parsed.data as PlayerFlagCondition);
    default:
      return null;
  }
}

/** True when a rule applies to the trigger's server (null server = global rule). */
function scopeMatches(rule: AutomationRuleInput, input: AutomationTriggerInput): boolean {
  if (rule.serverId === null) return true;
  return rule.serverId === input.serverId;
}

/**
 * Evaluates every enabled, in-scope rule against a trigger and returns the
 * matches. A rule whose `action` jsonb fails validation is dropped (never
 * matched) so a corrupt action can never produce an unexecutable firing.
 */
export function evaluate(
  input: AutomationTriggerInput,
  rules: readonly AutomationRuleInput[],
): AutomationMatch[] {
  const matches: AutomationMatch[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!scopeMatches(rule, input)) continue;
    const matched = evaluateCondition(input, rule);
    if (!matched) continue;
    const action = parseAutomationAction(rule.actionType, rule.action);
    if (!action.success) continue;
    matches.push({
      ruleId: rule.id,
      ruleName: rule.name,
      serverId: input.serverId,
      conditionType: rule.conditionType,
      actionType: rule.actionType,
      action: action.data as Record<string, unknown>,
      matched,
      player: input.player ?? null,
    });
  }
  return matches;
}
