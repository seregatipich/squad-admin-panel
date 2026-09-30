/**
 * Shared vocabulary of the RCON message-template library. The built-in
 * templates are seeded once by migration `0119_message_templates_seed_once`,
 * never at request time, so deleting one is permanent (#36).
 */
export const MESSAGE_TEMPLATE_CATEGORIES = ['warn', 'info', 'vip', 'other'] as const;
export type MessageTemplateCategory = (typeof MESSAGE_TEMPLATE_CATEGORIES)[number];

export const MESSAGE_TEMPLATE_LOCALES = ['en', 'ru'] as const;
export type MessageTemplateLocale = (typeof MESSAGE_TEMPLATE_LOCALES)[number];

export const MESSAGE_BODY_MAX = 512;
