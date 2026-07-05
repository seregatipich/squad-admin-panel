export const CHAT_FLAG_PATTERN_TYPES = ['word', 'regex'] as const;
export type ChatFlagPatternType = (typeof CHAT_FLAG_PATTERN_TYPES)[number];

export const CHAT_FLAG_LOCALES = ['all', 'ru', 'en'] as const;
export type ChatFlagLocale = (typeof CHAT_FLAG_LOCALES)[number];

export const PATTERN_TYPE_LABELS: Record<ChatFlagPatternType, string> = {
  word: 'Слово',
  regex: 'Регэксп',
};

export const LOCALE_LABELS: Record<ChatFlagLocale, string> = {
  all: 'Все языки',
  ru: 'Русский',
  en: 'English',
};

export interface ChatFlagRule {
  id: string;
  pattern: string;
  pattern_type: ChatFlagPatternType;
  locale: ChatFlagLocale;
  enabled: boolean;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
}

export interface ReindexSummary {
  days: number;
  scanned: number;
  flagged: number;
  changed: number;
}

export function describeRule(rule: ChatFlagRule): string {
  const parts = [PATTERN_TYPE_LABELS[rule.pattern_type], LOCALE_LABELS[rule.locale]];
  parts.push(rule.enabled ? 'включено' : 'отключено');
  return parts.join(' · ');
}

export function countEnabled(rules: ChatFlagRule[]): number {
  return rules.reduce((total, rule) => total + (rule.enabled ? 1 : 0), 0);
}

export function summarizeReindex(summary: ReindexSummary): string {
  return `Проверено ${summary.scanned}, помечено ${summary.flagged}, изменено ${summary.changed} за ${summary.days} дн.`;
}
