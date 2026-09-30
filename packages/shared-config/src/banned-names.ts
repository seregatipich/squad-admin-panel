export const BANNED_NAME_MATCH_TYPES = ['exact', 'substring', 'regex'] as const;
export type BannedNameMatchType = (typeof BANNED_NAME_MATCH_TYPES)[number];

export const BANNED_NAME_ACTIONS = ['kick', 'alert'] as const;
export type BannedNameAction = (typeof BANNED_NAME_ACTIONS)[number];

export const BANNED_NAME_PATTERN_MAX = 256;

/**
 * Longest nickname `GET /api/v1/banned-names/check` accepts: twice Steam's
 * 32-character persona-name limit, so no real player name is refused while
 * the player-controlled input every regex rule runs against stays bounded.
 */
export const BANNED_NAME_NICK_MAX = 64;

const MATCH_TYPE_SET: ReadonlySet<string> = new Set(BANNED_NAME_MATCH_TYPES);
const ACTION_SET: ReadonlySet<string> = new Set(BANNED_NAME_ACTIONS);

export function isBannedNameMatchType(x: string): x is BannedNameMatchType {
  return MATCH_TYPE_SET.has(x);
}

export function isBannedNameAction(x: string): x is BannedNameAction {
  return ACTION_SET.has(x);
}

export type BannedNameValidation = { ok: true } | { ok: false; error: string };

export function validateBannedNamePattern(
  pattern: string,
  matchType: BannedNameMatchType,
): BannedNameValidation {
  if (pattern.length === 0) {
    return { ok: false, error: 'pattern_empty' };
  }
  if (pattern.length > BANNED_NAME_PATTERN_MAX) {
    return { ok: false, error: `pattern_too_long: max ${BANNED_NAME_PATTERN_MAX} characters` };
  }
  if (matchType === 'regex') {
    try {
      new RegExp(pattern);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (!isSafeBannedNameRegex(pattern)) {
      return { ok: false, error: 'pattern_unsafe_regex' };
    }
  }
  return { ok: true };
}

interface RegexGroupFrame {
  /** The group's body contains a quantified atom (`?`, `*`, `+` or `{…}`). */
  quantified: boolean;
  /** The group's body contains an alternation `|`. */
  alternates: boolean;
}

/**
 * Reads the quantifier starting at `pattern[index]`, if any.
 *
 * @returns The index just past it (including a lazy `?`), and whether it may
 *   repeat the atom more than once; `null` when no quantifier starts there.
 */
function readQuantifier(pattern: string, index: number): { end: number; repeats: boolean } | null {
  const ch = pattern[index];
  let end: number;
  let repeats: boolean;
  if (ch === '*' || ch === '+') {
    end = index + 1;
    repeats = true;
  } else if (ch === '?') {
    end = index + 1;
    repeats = false;
  } else if (ch === '{') {
    const bounds = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
    if (!bounds) return null;
    end = index + bounds[0].length;
    const max =
      bounds[2] === undefined ? Number(bounds[1]) : bounds[3] ? Number(bounds[3]) : Infinity;
    repeats = max > 1;
  } else {
    return null;
  }
  if (pattern[end] === '?') end += 1;
  return { end, repeats };
}

/**
 * Conservative ReDoS screen for banned-name regex rules (audit #115).
 *
 * A rule runs synchronously on the API event loop (`/banned-names/check`) and
 * in log-ingest against a nickname the player chooses, so a pattern that can
 * backtrack exponentially stalls the whole process. This refuses the shapes
 * that cause it:
 *
 * - a group repeated more than once whose body itself contains a quantifier
 *   (`(a+)+`, `(\w+\s?)*`, `(a?){20}`, `((ab)+c)*`) — nested repetition;
 * - a group repeated more than once whose body contains an alternation
 *   (`(a|aa)+`) — overlapping alternatives cannot be told apart statically,
 *   so every repeated alternation is refused;
 * - backreferences (`\1`, `\k<name>`), which defeat any linear bound.
 *
 * Polynomial patterns (`.*.*x`) remain possible; {@link BANNED_NAME_NICK_MAX}
 * bounds their input.
 *
 * @param pattern - A pattern that already compiles with `new RegExp`.
 * @returns `false` when the pattern has one of the shapes above.
 */
export function isSafeBannedNameRegex(pattern: string): boolean {
  const stack: RegexGroupFrame[] = [{ quantified: false, alternates: false }];
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern[index];
    const top = stack[stack.length - 1] as RegexGroupFrame;
    if (ch === '|') {
      top.alternates = true;
      index += 1;
      continue;
    }
    if (ch === '(') {
      stack.push({ quantified: false, alternates: false });
      index += 1;
      const prefix = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(pattern.slice(index));
      if (prefix) index += prefix[0].length;
      continue;
    }
    let atomEnd: number;
    let group: RegexGroupFrame | null = null;
    if (ch === ')') {
      group = stack.pop() ?? null;
      if (!group || stack.length === 0) return false;
      atomEnd = index + 1;
    } else if (ch === '\\') {
      const next = pattern[index + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && pattern[index + 2] === '<')) return false;
      atomEnd = index + 2;
    } else if (ch === '[') {
      atomEnd = index + 1;
      if (pattern[atomEnd] === '^') atomEnd += 1;
      while (atomEnd < pattern.length && pattern[atomEnd] !== ']') {
        atomEnd += pattern[atomEnd] === '\\' ? 2 : 1;
      }
      atomEnd += 1;
    } else {
      atomEnd = index + 1;
    }
    const parent = stack[stack.length - 1] as RegexGroupFrame;
    if (group) {
      parent.quantified ||= group.quantified;
      parent.alternates ||= group.alternates;
    }
    const quantifier = readQuantifier(pattern, atomEnd);
    if (quantifier) {
      if (group && quantifier.repeats && (group.quantified || group.alternates)) return false;
      parent.quantified = true;
      index = quantifier.end;
    } else {
      index = atomEnd;
    }
  }
  return stack.length === 1;
}

export function matchBannedName(
  pattern: string,
  matchType: BannedNameMatchType,
  nickname: string,
): boolean {
  if (pattern.length === 0) return false;
  if (matchType === 'exact') {
    return nickname.toLowerCase() === pattern.toLowerCase();
  }
  if (matchType === 'substring') {
    return nickname.toLowerCase().includes(pattern.toLowerCase());
  }
  // Rules stored before unsafe patterns were refused must not run either.
  if (!isSafeBannedNameRegex(pattern)) return false;
  try {
    // Case-insensitive to match the log-ingest worker's compiled regex
    // matcher (apps/workers/log-ingest/src/banname/matcher.ts), so this
    // preview/check never disagrees with what actually gets enforced.
    return new RegExp(pattern, 'i').test(nickname);
  } catch {
    return false;
  }
}

/** Minimal shape `findBannedNameRuleMatch` needs from a `banned_name_rules` row. */
export interface BannedNameRuleForMatch {
  id: string;
  pattern: string;
  match_type: BannedNameMatchType;
  action: BannedNameAction;
  reason: string | null;
}

/**
 * Finds the first rule matching `nickname`, mirroring the log-ingest worker's
 * evaluation order: exact rules first, then substring, then regex; within a
 * tier, rules are tried in the order they appear in `rules` (callers should
 * pass rules pre-sorted by `created_at`, `id` ascending, and pre-filtered to
 * active rules only — the same order `BannedNameRuleCache` loads). Invalid
 * regex rules never match (matchBannedName swallows compile errors) rather
 * than throwing, so one bad rule can't break a check for every other rule.
 */
export function findBannedNameRuleMatch<T extends BannedNameRuleForMatch>(
  rules: readonly T[],
  nickname: string,
): T | null {
  const buckets: Record<BannedNameMatchType, T[]> = { exact: [], substring: [], regex: [] };
  for (const rule of rules) {
    if (!isBannedNameMatchType(rule.match_type)) continue;
    buckets[rule.match_type].push(rule);
  }
  for (const tier of [buckets.exact, buckets.substring, buckets.regex]) {
    for (const rule of tier) {
      if (matchBannedName(rule.pattern, rule.match_type, nickname)) return rule;
    }
  }
  return null;
}
