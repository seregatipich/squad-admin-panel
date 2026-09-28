/**
 * Static ReDoS screen for operator-authored regular expressions (chat-flag
 * rules, banned-name rules). Those patterns run on text a remote player
 * controls — every chat line, every nickname — inside the single-threaded API
 * and ingest workers, so one catastrophic pattern stalls the whole process.
 *
 * The screen is deliberately conservative: it rejects every construct that
 * lets a backtracking engine try more than one way to split the input across
 * a repetition, and so rejects some patterns that would in fact be safe (for
 * example `(\d|x)+`). Operators can always rewrite such a pattern without the
 * ambiguity (`[\dx]+`).
 */

/** Largest single bounded repetition count (`{n}` / `{n,m}`) a pattern may use. */
export const REGEX_MAX_REPEAT = 100;

/** Why a pattern was rejected by {@link detectDangerousRegex}. */
export type DangerousRegexReason =
  | 'nested_quantifier'
  | 'alternation_under_quantifier'
  | 'repeat_too_large';

interface QuantifierRead {
  next: number;
  /** True when the quantifier can match more than one repetition (`*`, `+`, `{n,}`, `{n,m}` with m > 1). */
  repeats: boolean;
  /** True when the repetition count is not fixed (`*`, `+`, `?`, `{n,}`, `{n,m}` with n < m). */
  variable: boolean;
  repeatTooBig: boolean;
}

interface GroupFrame {
  /** Index of the group's first content character (after any `?:`-style prefix). */
  contentStart: number;
  /** The group contains a variable-count quantifier at any depth. */
  variable: boolean;
  /** The group has a `|` at its own top level. */
  hasBar: boolean;
  /** A nested group holds an alternation whose branches may overlap. */
  ambiguous: boolean;
}

const LITERAL_BRANCH = /^[^\\[\](){}.*+?^$|]+$/;

/**
 * True when every branch of `content` (split on `|`) is a non-empty plain
 * literal and no branch is a case-insensitive prefix of another. Such an
 * alternation can match the start of the input in at most one way, so
 * repeating it never multiplies the backtracking paths: `(bad|worse)+` is
 * safe, `(a|aa)+` is not.
 */
function isPrefixFreeLiteralAlternation(content: string): boolean {
  const branches = content.split('|').map((branch) => branch.toLowerCase());
  if (!branches.every((branch) => LITERAL_BRANCH.test(branch))) return false;
  return branches.every((branch, i) =>
    branches.every((other, j) => i === j || !other.startsWith(branch)),
  );
}

function readQuantifier(pattern: string, index: number): QuantifierRead | null {
  const ch = pattern[index];
  if (ch === '*' || ch === '+') {
    let next = index + 1;
    if (pattern[next] === '?') next += 1;
    return { next, repeats: true, variable: true, repeatTooBig: false };
  }
  if (ch === '?') {
    let next = index + 1;
    if (pattern[next] === '?') next += 1;
    return { next, repeats: false, variable: true, repeatTooBig: false };
  }
  if (ch === '{') {
    const close = pattern.indexOf('}', index);
    if (close < 0) return null;
    const body = pattern.slice(index + 1, close);
    const match = body.match(/^(\d+)(,(\d*)?)?$/);
    if (!match) return null;
    const min = Number(match[1]);
    const hasComma = match[2] !== undefined;
    const maxRaw = match[3];
    const max = hasComma ? (maxRaw ? Number(maxRaw) : Number.POSITIVE_INFINITY) : min;
    const repeatTooBig = min > REGEX_MAX_REPEAT || (Number.isFinite(max) && max > REGEX_MAX_REPEAT);
    let next = close + 1;
    if (pattern[next] === '?') next += 1;
    return { next, repeats: max > 1, variable: max !== min, repeatTooBig };
  }
  return null;
}

function skipGroupPrefix(pattern: string, index: number): number {
  if (pattern[index] !== '?') return index;
  let i = index + 1;
  const marker = pattern[i];
  if (marker === ':' || marker === '=' || marker === '!') return i + 1;
  if (marker === '<') {
    i += 1;
    if (pattern[i] === '=' || pattern[i] === '!') return i + 1;
    const close = pattern.indexOf('>', i);
    return close < 0 ? i : close + 1;
  }
  return i;
}

function skipCharClass(pattern: string, index: number): number {
  let i = index + 1;
  if (pattern[i] === '^') i += 1;
  if (pattern[i] === ']') i += 1;
  while (i < pattern.length && pattern[i] !== ']') {
    if (pattern[i] === '\\') i += 2;
    else i += 1;
  }
  return i + 1;
}

/**
 * Scans a regular expression for constructs prone to catastrophic
 * backtracking. The pattern is assumed to compile; callers check that first.
 *
 * Rejected constructs:
 * - `nested_quantifier` — a repeating quantifier over a group that itself
 *   contains a variable-count quantifier: `(a+)+`, `(a{1,100}){1,100}`,
 *   `(.*a){20}`, `(a?){10}`.
 * - `alternation_under_quantifier` — a repeating quantifier over a group that
 *   contains an alternation whose branches may overlap: `(a|aa)+`,
 *   `(\w|\d)+`, `(?:x|x)+`. Only an alternation of plain literals where no
 *   branch is a prefix of another (`(bad|worse)+`) is accepted.
 * - `repeat_too_large` — a single bounded repetition above
 *   {@link REGEX_MAX_REPEAT}.
 *
 * @param pattern Regular expression source (without delimiters or flags).
 * @returns The first reason the pattern is unsafe, or `null` when it passes.
 */
export function detectDangerousRegex(pattern: string): DangerousRegexReason | null {
  const newFrame = (contentStart: number): GroupFrame => ({
    contentStart,
    variable: false,
    hasBar: false,
    ambiguous: false,
  });
  const stack: GroupFrame[] = [newFrame(0)];
  const top = (): GroupFrame => stack[stack.length - 1] as GroupFrame;
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i];
    if (ch === '(') {
      i = skipGroupPrefix(pattern, i + 1);
      stack.push(newFrame(i));
      continue;
    }
    if (ch === '|') {
      top().hasBar = true;
      i += 1;
      continue;
    }
    let closed: GroupFrame | null = null;
    let closedAmbiguous = false;
    if (ch === ')') {
      closed = stack.length > 1 ? (stack.pop() as GroupFrame) : null;
      if (closed) {
        closedAmbiguous =
          closed.ambiguous ||
          (closed.hasBar && !isPrefixFreeLiteralAlternation(pattern.slice(closed.contentStart, i)));
      }
      i += 1;
    } else if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      i = skipCharClass(pattern, i);
    } else {
      i += 1;
    }
    const quant = readQuantifier(pattern, i);
    if (quant) {
      if (quant.repeatTooBig) return 'repeat_too_large';
      if (closed && quant.repeats) {
        if (closed.variable) return 'nested_quantifier';
        if (closedAmbiguous) return 'alternation_under_quantifier';
      }
      if (quant.variable) top().variable = true;
      i = quant.next;
    }
    if (closed) {
      if (closed.variable) top().variable = true;
      if (closedAmbiguous) top().ambiguous = true;
    }
  }
  return null;
}
