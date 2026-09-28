export const CHAT_FLAG_PATTERN_TYPES = ['word', 'regex'] as const;
export type ChatFlagPatternType = (typeof CHAT_FLAG_PATTERN_TYPES)[number];

export const CHAT_FLAG_LOCALES = ['all', 'ru', 'en'] as const;
export type ChatFlagLocale = (typeof CHAT_FLAG_LOCALES)[number];

export const CHAT_FLAG_PATTERN_MAX = 200;
export const CHAT_FLAG_MAX_REPEAT = 100;

const PATTERN_TYPE_SET: ReadonlySet<string> = new Set(CHAT_FLAG_PATTERN_TYPES);
const LOCALE_SET: ReadonlySet<string> = new Set(CHAT_FLAG_LOCALES);

export function isChatFlagPatternType(x: string): x is ChatFlagPatternType {
  return PATTERN_TYPE_SET.has(x);
}

export function isChatFlagLocale(x: string): x is ChatFlagLocale {
  return LOCALE_SET.has(x);
}

export type ChatFlagValidation = { ok: true } | { ok: false; error: string };

interface QuantifierRead {
  next: number;
  /** `*`, `+` or `{n,}` — no upper bound on repetitions. */
  unbounded: boolean;
  /** May match its atom more than once (`*`, `+`, `{n,m}` with an upper bound above 1). */
  repeating: boolean;
  repeatTooBig: boolean;
}

/**
 * What an atom can start matching: one literal character (lower-cased, since
 * rules compile with the `i` flag), or `wide` for anything the scanner does
 * not model precisely — character classes, escapes, `.`, groups. `wide` is
 * assumed to overlap everything.
 */
type AtomStart = string | 'wide';

/** Scanner state for one group (the pattern itself is the outermost frame). */
interface GroupFrame {
  /** First atom of each finished alternative; `null` marks an empty alternative. */
  alternativeStarts: (AtomStart | null)[];
  /** First atom of the alternative being scanned; `undefined` until one is seen. */
  currentStart: AtomStart | null | undefined;
  /** Any quantifier anywhere inside this group, including nested groups. */
  containsQuantifier: boolean;
  /** An ambiguous alternation anywhere inside this group, including nested groups. */
  containsAmbiguousAlternation: boolean;
}

/* v8 ignore start -- internal ReDoS scanner; behavior is verified through validateChatFlagPattern's accept/reject tests */
function readQuantifier(pattern: string, index: number): QuantifierRead | null {
  const ch = pattern[index];
  if (ch === '*' || ch === '+') {
    let next = index + 1;
    if (pattern[next] === '?') next += 1;
    return { next, unbounded: true, repeating: true, repeatTooBig: false };
  }
  if (ch === '?') {
    let next = index + 1;
    if (pattern[next] === '?') next += 1;
    return { next, unbounded: false, repeating: false, repeatTooBig: false };
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
    const max = hasComma && maxRaw ? Number(maxRaw) : undefined;
    const unbounded = hasComma && (maxRaw === undefined || maxRaw === '');
    const repeating = unbounded || (max ?? min) > 1;
    const repeatTooBig =
      min > CHAT_FLAG_MAX_REPEAT || (max !== undefined && max > CHAT_FLAG_MAX_REPEAT);
    let next = close + 1;
    if (pattern[next] === '?') next += 1;
    return { next, unbounded, repeating, repeatTooBig };
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
    /* v8 ignore next -- malformed lookbehind (no closing '>') is rejected by RegExp before it matters */
    return close < 0 ? i : close + 1;
  }
  /* v8 ignore next -- unknown group prefix; defensive fallthrough */
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

function newFrame(): GroupFrame {
  return {
    alternativeStarts: [],
    currentStart: undefined,
    containsQuantifier: false,
    containsAmbiguousAlternation: false,
  };
}

function finishAlternative(frame: GroupFrame): void {
  frame.alternativeStarts.push(frame.currentStart ?? null);
  frame.currentStart = undefined;
}

/**
 * An alternation is unambiguous only when every alternative starts with its
 * own literal character: then the next input character alone picks the
 * branch, so a repeated group never has two ways to consume the same text.
 */
function hasAmbiguousAlternation(frame: GroupFrame): boolean {
  if (frame.alternativeStarts.length < 2) return false;
  const seen = new Set<string>();
  for (const start of frame.alternativeStarts) {
    if (start === null || start === 'wide' || seen.has(start)) return true;
    seen.add(start);
  }
  return false;
}

/**
 * Conservative static ReDoS scan for user-supplied chat-flag regexes (#344).
 *
 * The rules run synchronously on the API event loop (reindex) and in the chat
 * ingest workers, so a pattern with super-linear backtracking stalls the whole
 * process. Rejected shapes:
 *
 * - `nested_quantifier` — a group repeated more than once (`*`, `+`, `{n,m}`
 *   with m > 1) that itself contains any quantifier: `(a+)+`, `(ab?)+`,
 *   `(a{1,3}){1,50}`. Star height above one is the classic exponential case.
 * - `ambiguous_alternation` — a repeated group containing an alternation whose
 *   branches do not all start with distinct literal characters: `(a|a)*`,
 *   `(\w|\d)+`, `(a|ab)*`.
 * - `overlapping_quantifiers` — three or more unbounded quantifiers whose atoms
 *   may match the same character (`\w*\w*\w*`, `.*x.*y.*`, `a+a+a+`): each
 *   one multiplies the backtracking work on a failing match (polynomial blow-up).
 * - `repeat_too_large` — a `{n,m}` bound above {@link CHAT_FLAG_MAX_REPEAT}.
 *
 * It intentionally over-rejects some safe patterns (for example `(a|b)+`,
 * which `[ab]+` expresses safely); chat-flag rules rarely need more.
 */
function detectDangerousRegex(pattern: string): string | null {
  const stack: GroupFrame[] = [newFrame()];
  let wideUnbounded = 0;
  const literalUnbounded = new Map<string, number>();
  let i = 0;
  const n = pattern.length;

  const top = (): GroupFrame => stack[stack.length - 1] as GroupFrame;

  /** Records an atom and its optional quantifier; returns an error code or null. */
  const consumeAtom = (start: AtomStart, inner: GroupFrame | null): string | null => {
    const frame = top();
    if (frame.currentStart === undefined) frame.currentStart = start;
    const quant = readQuantifier(pattern, i);
    const innerQuantified = inner?.containsQuantifier ?? false;
    const innerAmbiguous =
      inner !== null && (inner.containsAmbiguousAlternation || hasAmbiguousAlternation(inner));
    if (quant) {
      if (quant.repeatTooBig) return 'repeat_too_large';
      if (quant.repeating && innerQuantified) return 'nested_quantifier';
      if (quant.repeating && innerAmbiguous) return 'ambiguous_alternation';
      if (quant.unbounded) {
        if (start === 'wide') wideUnbounded += 1;
        else literalUnbounded.set(start, (literalUnbounded.get(start) ?? 0) + 1);
        const maxLiteral = Math.max(0, ...literalUnbounded.values());
        if (wideUnbounded + maxLiteral >= 3) return 'overlapping_quantifiers';
      }
      i = quant.next;
    }
    if (quant || innerQuantified) frame.containsQuantifier = true;
    if (innerAmbiguous) frame.containsAmbiguousAlternation = true;
    return null;
  };

  while (i < n) {
    const ch = pattern[i] as string;
    let error: string | null = null;
    if (ch === '\\') {
      i += 2;
      error = consumeAtom('wide', null);
    } else if (ch === '[') {
      i = skipCharClass(pattern, i);
      error = consumeAtom('wide', null);
    } else if (ch === '(') {
      i = skipGroupPrefix(pattern, i + 1);
      stack.push(newFrame());
    } else if (ch === '|') {
      finishAlternative(top());
      i += 1;
    } else if (ch === ')') {
      const closed = stack.length > 1 ? (stack.pop() as GroupFrame) : newFrame();
      finishAlternative(closed);
      i += 1;
      error = consumeAtom('wide', closed);
    } else {
      i += 1;
      const literal = ch === '.' || ch === '^' || ch === '$' ? 'wide' : ch.toLowerCase();
      error = consumeAtom(literal, null);
    }
    if (error) return error;
  }
  return null;
}

/* v8 ignore stop */
export function validateChatFlagPattern(
  pattern: string,
  patternType: ChatFlagPatternType,
): ChatFlagValidation {
  if (pattern.length === 0) {
    return { ok: false, error: 'pattern_empty' };
  }
  if (pattern.length > CHAT_FLAG_PATTERN_MAX) {
    return { ok: false, error: `pattern_too_long: max ${CHAT_FLAG_PATTERN_MAX} characters` };
  }
  if (patternType === 'regex') {
    try {
      new RegExp(pattern, 'i');
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const danger = detectDangerousRegex(pattern);
    if (danger) {
      return { ok: false, error: danger };
    }
  }
  return { ok: true };
}

export interface ChatFlagRuleInput {
  id: string;
  pattern: string;
  patternType: ChatFlagPatternType;
}

export interface CompiledChatFlagRule {
  id: string;
  test: (message: string) => boolean;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileChatFlagRule(rule: ChatFlagRuleInput): CompiledChatFlagRule | null {
  const trimmed = rule.pattern.trim();
  if (trimmed.length === 0) return null;
  if (rule.patternType === 'word') {
    try {
      const boundary = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegex(trimmed)}(?![\\p{L}\\p{N}])`,
        'iu',
      );
      return { id: rule.id, test: (message) => boundary.test(message) };
      /* v8 ignore next 3 -- escaped word patterns never produce an invalid RegExp; defensive */
    } catch {
      return null;
    }
  }
  // Rules stored before a stricter ReDoS scan landed are skipped, never run (#344).
  if (!validateChatFlagPattern(rule.pattern, 'regex').ok) return null;
  try {
    const regex = new RegExp(rule.pattern, 'i');
    return { id: rule.id, test: (message) => regex.test(message) };
  } catch {
    return null;
  }
}

export function compileChatFlagRules(rules: ChatFlagRuleInput[]): CompiledChatFlagRule[] {
  const compiled: CompiledChatFlagRule[] = [];
  for (const rule of rules) {
    const entry = compileChatFlagRule(rule);
    if (entry) compiled.push(entry);
  }
  return compiled;
}

export function detectChatFlag(message: string, rules: CompiledChatFlagRule[]): string | null {
  for (const rule of rules) {
    if (rule.test(message)) return rule.id;
  }
  return null;
}
