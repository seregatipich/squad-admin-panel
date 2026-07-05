import { describe, expect, it } from 'vitest';
import {
  CHAT_FLAG_LOCALES,
  CHAT_FLAG_PATTERN_MAX,
  CHAT_FLAG_PATTERN_TYPES,
  compileChatFlagRule,
  compileChatFlagRules,
  detectChatFlag,
  isChatFlagLocale,
  isChatFlagPatternType,
  validateChatFlagPattern,
} from '../src/chat-flag-rules.js';

describe('chat flag pattern type / locale guards', () => {
  it('recognizes valid pattern types and locales', () => {
    expect(CHAT_FLAG_PATTERN_TYPES).toEqual(['word', 'regex']);
    expect(CHAT_FLAG_LOCALES).toEqual(['all', 'ru', 'en']);
    expect(isChatFlagPatternType('word')).toBe(true);
    expect(isChatFlagPatternType('glob')).toBe(false);
    expect(isChatFlagLocale('ru')).toBe(true);
    expect(isChatFlagLocale('de')).toBe(false);
  });
});

describe('validateChatFlagPattern', () => {
  it('rejects empty patterns', () => {
    expect(validateChatFlagPattern('', 'word')).toEqual({ ok: false, error: 'pattern_empty' });
  });

  it('rejects patterns above the length cap', () => {
    const result = validateChatFlagPattern('a'.repeat(CHAT_FLAG_PATTERN_MAX + 1), 'word');
    expect(result.ok).toBe(false);
  });

  it('accepts plain word patterns', () => {
    expect(validateChatFlagPattern('сука', 'word')).toEqual({ ok: true });
  });

  it('accepts safe regex patterns', () => {
    expect(validateChatFlagPattern('f+u+c+k', 'regex')).toEqual({ ok: true });
    expect(validateChatFlagPattern('(bad|worse)', 'regex')).toEqual({ ok: true });
    expect(validateChatFlagPattern('(bad|worse)+', 'regex')).toEqual({ ok: true });
    expect(validateChatFlagPattern('сволоч[ьи]', 'regex')).toEqual({ ok: true });
    expect(validateChatFlagPattern('[а-я]+ыч', 'regex')).toEqual({ ok: true });
    expect(validateChatFlagPattern('(?:бля)+', 'regex')).toEqual({ ok: true });
    expect(validateChatFlagPattern('ab{2,5}c', 'regex')).toEqual({ ok: true });
  });

  it('rejects syntactically invalid regex', () => {
    const result = validateChatFlagPattern('(unclosed', 'regex');
    expect(result.ok).toBe(false);
  });

  it('accepts safe regex exercising group skipping, quantifiers and char classes', () => {
    expect(validateChatFlagPattern('(?<=pre)word', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('(?<!no)word', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('(?<tag>word)', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('(?:group)+word', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('(?=ahead)word', 'regex').ok).toBe(true);
    // '?' quantifier (optional + lazy) and char-class scanning branches
    expect(validateChatFlagPattern('colou?r', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('ab??c', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('[a-z]word', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('[^0-9]word', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('[\\]x]word', 'regex').ok).toBe(true);
    expect(validateChatFlagPattern('a{2,4}word', 'regex').ok).toBe(true);
  });

  it('rejects catastrophic-backtracking regex (nested unbounded quantifiers)', () => {
    for (const evil of [
      '(a+)+$',
      '(a*)*',
      '(.*)*',
      '([a-zA-Z]+)*',
      '(\\d+)+',
      '(a+|b)+',
      '((a+))+',
    ]) {
      const result = validateChatFlagPattern(evil, 'regex');
      expect(result.ok, `expected ${evil} to be rejected`).toBe(false);
      if (!result.ok) expect(result.error).toBe('nested_quantifier');
    }
  });

  it('rejects oversized bounded repetition', () => {
    const result = validateChatFlagPattern('a{500}', 'regex');
    expect(result).toEqual({ ok: false, error: 'repeat_too_large' });
    const ranged = validateChatFlagPattern('(?:ab){2,999}', 'regex');
    expect(ranged).toEqual({ ok: false, error: 'repeat_too_large' });
  });
});

describe('compileChatFlagRule + detectChatFlag', () => {
  it('flags whole-word matches for word rules, respecting Unicode boundaries', () => {
    const compiled = compileChatFlagRules([
      { id: 'r-ru', pattern: 'сука', patternType: 'word' },
      { id: 'r-en', pattern: 'fuck', patternType: 'word' },
    ]);
    expect(detectChatFlag('ах ты сука!', compiled)).toBe('r-ru');
    expect(detectChatFlag('WHAT THE FUCK', compiled)).toBe('r-en');
    expect(detectChatFlag('clean message', compiled)).toBeNull();
    expect(detectChatFlag('сукатина здесь', compiled)).toBeNull();
  });

  it('applies regex rules case-insensitively', () => {
    const compiled = compileChatFlagRules([{ id: 'rx', pattern: 'f+u+c+k', patternType: 'regex' }]);
    expect(detectChatFlag('ffuuuck you', compiled)).toBe('rx');
    expect(detectChatFlag('polite', compiled)).toBeNull();
  });

  it('returns the first matching rule id', () => {
    const compiled = compileChatFlagRules([
      { id: 'first', pattern: 'bad', patternType: 'word' },
      { id: 'second', pattern: 'word', patternType: 'word' },
    ]);
    expect(detectChatFlag('bad word', compiled)).toBe('first');
  });

  it('drops rules whose pattern is blank or uncompilable', () => {
    expect(compileChatFlagRule({ id: 'blank', pattern: '   ', patternType: 'word' })).toBeNull();
    expect(compileChatFlagRule({ id: 'broken', pattern: '(', patternType: 'regex' })).toBeNull();
    const compiled = compileChatFlagRules([
      { id: 'blank', pattern: '', patternType: 'word' },
      { id: 'ok', pattern: 'shit', patternType: 'word' },
    ]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].id).toBe('ok');
  });
});
