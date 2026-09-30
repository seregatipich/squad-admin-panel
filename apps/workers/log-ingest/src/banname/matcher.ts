import { createContext, Script } from 'node:vm';
import {
  BANNED_NAME_PATTERN_MAX,
  type BannedNameAction,
  type BannedNameMatchType,
  isSafeBannedNameRegex,
} from '@squad/shared-config/banned-names';

/** One row read from `banned_name_rules`, as needed to compile a matcher. */
export interface BannedNameRuleRow {
  id: string;
  pattern: string;
  matchType: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
}

/**
 * Wall-clock budget for one regex rule against one nickname. Rules are
 * operator-supplied and nicknames player-supplied, so a pattern such as
 * `^(a|a)*$` plus a crafted nickname would otherwise backtrack for seconds to
 * hours on the event loop, stalling log ingestion for every server.
 */
export const REGEX_MATCH_TIMEOUT_MS = 50;

/**
 * One shared sandbox for bounded regex evaluation. `vm`'s `timeout` interrupts
 * V8's backtracking engine, which a plain `RegExp.test` call cannot be.
 * Evaluation is synchronous, so reusing one context is safe.
 */
const regexSandbox = createContext({ regex: /$^/, nickname: '' });
const regexTestScript = new Script('regex.test(nickname)');

/** Thrown by a regex rule's `test` when it ran past `REGEX_MATCH_TIMEOUT_MS`. */
class RegexMatchTimeoutError extends Error {}

function testRegexWithTimeout(regex: RegExp, nickname: string): boolean {
  regexSandbox.regex = regex;
  regexSandbox.nickname = nickname;
  try {
    return regexTestScript.runInContext(regexSandbox, { timeout: REGEX_MATCH_TIMEOUT_MS }) === true;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new RegexMatchTimeoutError();
    }
    throw err;
  }
}

interface CompiledBannedNameRule {
  id: string;
  matchType: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
  /** Throws `RegexMatchTimeoutError` when a regex rule exceeds its time budget. */
  test: (nickname: string) => boolean;
}

/**
 * Rules compiled and bucketed by match tier. Evaluation order is
 * exact -> substring -> regex, first match wins (BANNAME-2 acceptance
 * criteria); within a tier, rules are tested in the order they were
 * compiled, which the cache loads in `created_at` (then `id`) order.
 */
export interface CompiledBannedNameRuleSet {
  exact: CompiledBannedNameRule[];
  substring: CompiledBannedNameRule[];
  regex: CompiledBannedNameRule[];
}

export interface BannedNameMatch {
  ruleId: string;
  matchType: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
}

function compileBannedNameRule(row: BannedNameRuleRow): CompiledBannedNameRule | null {
  const pattern = row.pattern.trim();
  if (pattern.length === 0 || pattern.length > BANNED_NAME_PATTERN_MAX) return null;

  if (row.matchType === 'exact') {
    const lowered = pattern.toLowerCase();
    return {
      id: row.id,
      matchType: row.matchType,
      reason: row.reason,
      action: row.action,
      test: (nickname) => nickname.toLowerCase() === lowered,
    };
  }

  if (row.matchType === 'substring') {
    const lowered = pattern.toLowerCase();
    return {
      id: row.id,
      matchType: row.matchType,
      reason: row.reason,
      action: row.action,
      test: (nickname) => nickname.toLowerCase().includes(lowered),
    };
  }

  // A catastrophically backtracking rule (stored before the API refused
  // them, audit #115) would stall ingestion on a crafted nickname.
  if (!isSafeBannedNameRegex(pattern)) return null;
  try {
    const regex = new RegExp(pattern, 'i');
    return {
      id: row.id,
      matchType: row.matchType,
      reason: row.reason,
      action: row.action,
      test: (nickname) => testRegexWithTimeout(regex, nickname),
    };
  } catch {
    // Invalid regex rules are dropped silently: one bad rule must never
    // break ingestion for every other rule/player.
    return null;
  }
}

/** Compiles active rule rows into the tiered set `matchBannedNickname` evaluates. */
export function compileBannedNameRules(rows: BannedNameRuleRow[]): CompiledBannedNameRuleSet {
  const compiled: CompiledBannedNameRuleSet = { exact: [], substring: [], regex: [] };
  for (const row of rows) {
    const rule = compileBannedNameRule(row);
    if (!rule) continue;
    compiled[rule.matchType].push(rule);
  }
  return compiled;
}

/** Optional hooks for {@link matchBannedNickname}. */
export interface MatchBannedNicknameOptions {
  /** Called with the rule id when a regex rule exceeds `REGEX_MATCH_TIMEOUT_MS`. */
  onRegexTimeout?: (ruleId: string) => void;
}

/**
 * Runs a nickname through the compiled rule set: exact rules first, then
 * substring, then regex; returns the first match or null. Matching is
 * case-insensitive for every match type.
 *
 * A regex rule that runs past `REGEX_MATCH_TIMEOUT_MS` is treated as not
 * matching (and reported through `onRegexTimeout`), so one pathological rule
 * costs at most that budget per nickname and never hides the rules after it.
 */
export function matchBannedNickname(
  nickname: string,
  compiled: CompiledBannedNameRuleSet,
  options: MatchBannedNicknameOptions = {},
): BannedNameMatch | null {
  for (const tier of [compiled.exact, compiled.substring, compiled.regex]) {
    for (const rule of tier) {
      let matched: boolean;
      try {
        matched = rule.test(nickname);
      } catch (err) {
        if (!(err instanceof RegexMatchTimeoutError)) throw err;
        options.onRegexTimeout?.(rule.id);
        continue;
      }
      if (matched) {
        return {
          ruleId: rule.id,
          matchType: rule.matchType,
          reason: rule.reason,
          action: rule.action,
        };
      }
    }
  }
  return null;
}
