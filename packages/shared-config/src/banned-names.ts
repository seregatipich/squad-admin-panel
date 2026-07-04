export const BANNED_NAME_MATCH_TYPES = ['exact', 'substring', 'regex'] as const;
export type BannedNameMatchType = (typeof BANNED_NAME_MATCH_TYPES)[number];

export const BANNED_NAME_ACTIONS = ['kick', 'alert'] as const;
export type BannedNameAction = (typeof BANNED_NAME_ACTIONS)[number];

export const BANNED_NAME_PATTERN_MAX = 256;

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
  }
  return { ok: true };
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
  try {
    return new RegExp(pattern).test(nickname);
  } catch {
    return false;
  }
}
