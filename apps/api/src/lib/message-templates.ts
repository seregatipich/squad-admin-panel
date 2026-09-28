export const MESSAGE_TEMPLATE_CATEGORIES = ['warn', 'info', 'vip', 'other'] as const;
export type MessageTemplateCategory = (typeof MESSAGE_TEMPLATE_CATEGORIES)[number];

export const MESSAGE_TEMPLATE_LOCALES = ['en', 'ru'] as const;
export type MessageTemplateLocale = (typeof MESSAGE_TEMPLATE_LOCALES)[number];

export const MESSAGE_BODY_MAX = 512;
