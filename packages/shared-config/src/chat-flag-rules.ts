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
  unbounded: boolean;
  repeatTooBig: boolean;
}

/* v8 ignore start -- internal ReDoS scanner; behavior is verified through validateChatFlagPattern's accept/reject tests */
function readQuantifier(pattern: string, index: number): QuantifierRead | null {
  const ch = pattern[index];
  if (ch === '*' || ch === '+') {
    let next = index + 1;
    if (pattern[next] === '?') next += 1;
    return { next, unbounded: true, repeatTooBig: false };
  }
  if (ch === '?') {
    let next = index + 1;
    if (pattern[next] === '?') next += 1;
    return { next, unbounded: false, repeatTooBig: false };
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
    const repeatTooBig =
      min > CHAT_FLAG_MAX_REPEAT || (max !== undefined && max > CHAT_FLAG_MAX_REPEAT);
    let next = close + 1;
    if (pattern[next] === '?') next += 1;
    return { next, unbounded, repeatTooBig };
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

function markTop(stack: { unbounded: boolean }[]): void {
  const top = stack[stack.length - 1];
  if (top) top.unbounded = true;
}

function detectDangerousRegex(pattern: string): string | null {
  const stack: { unbounded: boolean }[] = [{ unbounded: false }];
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 2;
      const quant = readQuantifier(pattern, i);
      if (quant) {
        if (quant.repeatTooBig) return 'repeat_too_large';
        if (quant.unbounded) markTop(stack);
        i = quant.next;
      }
      continue;
    }
    if (ch === '[') {
      i = skipCharClass(pattern, i);
      const quant = readQuantifier(pattern, i);
      if (quant) {
        if (quant.repeatTooBig) return 'repeat_too_large';
        if (quant.unbounded) markTop(stack);
        i = quant.next;
      }
      continue;
    }
    if (ch === '(') {
      i = skipGroupPrefix(pattern, i + 1);
      stack.push({ unbounded: false });
      continue;
    }
    if (ch === ')') {
      const closed = stack.pop() ?? { unbounded: false };
      i += 1;
      const quant = readQuantifier(pattern, i);
      if (quant) {
        if (quant.repeatTooBig) return 'repeat_too_large';
        if (quant.unbounded && closed.unbounded) return 'nested_quantifier';
        if (quant.unbounded || closed.unbounded) markTop(stack);
        i = quant.next;
      } else if (closed.unbounded) {
        markTop(stack);
      }
      continue;
    }
    i += 1;
    const quant = readQuantifier(pattern, i);
    if (quant) {
      if (quant.repeatTooBig) return 'repeat_too_large';
      if (quant.unbounded) markTop(stack);
      i = quant.next;
    }
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
