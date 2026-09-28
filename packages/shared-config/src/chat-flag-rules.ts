import { detectDangerousRegex, REGEX_MAX_REPEAT } from './regex-safety.js';

export const CHAT_FLAG_PATTERN_TYPES = ['word', 'regex'] as const;
export type ChatFlagPatternType = (typeof CHAT_FLAG_PATTERN_TYPES)[number];

export const CHAT_FLAG_LOCALES = ['all', 'ru', 'en'] as const;
export type ChatFlagLocale = (typeof CHAT_FLAG_LOCALES)[number];

export const CHAT_FLAG_PATTERN_MAX = 200;
/** Largest bounded repetition a chat-flag regex may use; see {@link REGEX_MAX_REPEAT}. */
export const CHAT_FLAG_MAX_REPEAT = REGEX_MAX_REPEAT;

const PATTERN_TYPE_SET: ReadonlySet<string> = new Set(CHAT_FLAG_PATTERN_TYPES);
const LOCALE_SET: ReadonlySet<string> = new Set(CHAT_FLAG_LOCALES);

export function isChatFlagPatternType(x: string): x is ChatFlagPatternType {
  return PATTERN_TYPE_SET.has(x);
}

export function isChatFlagLocale(x: string): x is ChatFlagLocale {
  return LOCALE_SET.has(x);
}

export type ChatFlagValidation = { ok: true } | { ok: false; error: string };

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
  // A rule stored before the ReDoS screen tightened must never run on chat.
  if (detectDangerousRegex(rule.pattern)) return null;
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
