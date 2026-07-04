export const MESSAGE_TEMPLATE_CATEGORIES = ['warn', 'info', 'vip', 'other'] as const;
export type MessageTemplateCategory = (typeof MESSAGE_TEMPLATE_CATEGORIES)[number];

export const MESSAGE_TEMPLATE_LOCALES = ['en', 'ru'] as const;
export type MessageTemplateLocale = (typeof MESSAGE_TEMPLATE_LOCALES)[number];

export const MESSAGE_BODY_MAX = 512;

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  category: MessageTemplateCategory;
  locale: MessageTemplateLocale;
  sort_order: number;
  is_enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TokenContext {
  player?: string;
  server?: string;
}

export function substituteTokens(body: string, context: TokenContext): string {
  return body
    .replace(/\{player\}/g, context.player ?? '{player}')
    .replace(/\{server\}/g, context.server ?? '{server}');
}

export function pickableTemplates(templates: MessageTemplate[]): MessageTemplate[] {
  return templates
    .filter((template) => template.is_enabled)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
}

export const CATEGORY_LABELS: Record<MessageTemplateCategory, string> = {
  warn: 'Предупреждение',
  info: 'Информация',
  vip: 'VIP',
  other: 'Прочее',
};

export const LOCALE_LABELS: Record<MessageTemplateLocale, string> = {
  en: 'EN',
  ru: 'RU',
};
