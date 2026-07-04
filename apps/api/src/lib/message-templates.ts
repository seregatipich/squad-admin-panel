import type { DatabaseClient } from '@squad/db';
import { messageTemplates } from '@squad/db/schema';

export const MESSAGE_TEMPLATE_CATEGORIES = ['warn', 'info', 'vip', 'other'] as const;
export type MessageTemplateCategory = (typeof MESSAGE_TEMPLATE_CATEGORIES)[number];

export const MESSAGE_TEMPLATE_LOCALES = ['en', 'ru'] as const;
export type MessageTemplateLocale = (typeof MESSAGE_TEMPLATE_LOCALES)[number];

export const MESSAGE_BODY_MAX = 512;

interface DefaultTemplate {
  id: string;
  title: string;
  body: string;
  category: MessageTemplateCategory;
  locale: MessageTemplateLocale;
}

export const DEFAULT_MESSAGE_TEMPLATES: readonly DefaultTemplate[] = [
  {
    id: '0195b000-0000-7000-8000-000000000001',
    title: 'Claiming assets',
    body: '{player}, do not claim vehicles you cannot crew. Release the asset or you will be kicked from {server}.',
    category: 'warn',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-000000000002',
    title: 'Клейм техники',
    body: '{player}, не клеймите технику без экипажа. Освободите её, иначе будете кикнуты с {server}.',
    category: 'warn',
    locale: 'ru',
  },
  {
    id: '0195b000-0000-7000-8000-000000000003',
    title: 'Unreadable name',
    body: '{player}, your name is unreadable. Change it to a legible one to keep playing on {server}.',
    category: 'warn',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-000000000004',
    title: 'Нечитаемый ник',
    body: '{player}, ваш ник нечитаем. Смените его на читаемый, чтобы продолжить игру на {server}.',
    category: 'warn',
    locale: 'ru',
  },
  {
    id: '0195b000-0000-7000-8000-000000000005',
    title: 'Teamkill apology',
    body: 'Sorry for the teamkill, {player}. It was an accident.',
    category: 'info',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-000000000006',
    title: 'Извинение за тимкил',
    body: '{player}, извините за тимкил — это была случайность.',
    category: 'info',
    locale: 'ru',
  },
  {
    id: '0195b000-0000-7000-8000-000000000007',
    title: 'Take SL kit',
    body: '{player}, take a squad leader kit or hand the squad over to someone who will.',
    category: 'warn',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-000000000008',
    title: 'Возьмите кит СЛ',
    body: '{player}, возьмите кит сквадлидера или передайте отряд тому, кто возьмёт.',
    category: 'warn',
    locale: 'ru',
  },
  {
    id: '0195b000-0000-7000-8000-000000000009',
    title: 'Welcome',
    body: 'Welcome to {server}, {player}! Please read the rules before you start playing.',
    category: 'info',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-00000000000a',
    title: 'Приветствие',
    body: 'Добро пожаловать на {server}, {player}! Ознакомьтесь с правилами перед началом игры.',
    category: 'info',
    locale: 'ru',
  },
  {
    id: '0195b000-0000-7000-8000-00000000000b',
    title: 'Main camping',
    body: '{player}, stop camping the enemy main base. This is against the rules of {server}.',
    category: 'warn',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-00000000000c',
    title: 'Кемпинг мейна',
    body: '{player}, прекратите кемпить вражескую базу. Это нарушение правил {server}.',
    category: 'warn',
    locale: 'ru',
  },
  {
    id: '0195b000-0000-7000-8000-00000000000d',
    title: 'VIP slot active',
    body: '{player}, your VIP slot on {server} is active. Thank you for supporting the project.',
    category: 'vip',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-00000000000e',
    title: 'VIP-слот активен',
    body: '{player}, ваш VIP-слот на {server} активен. Спасибо за поддержку проекта.',
    category: 'vip',
    locale: 'ru',
  },
  {
    id: '0195b000-0000-7000-8000-00000000000f',
    title: 'Mic spam',
    body: '{player}, please stop mic spamming or you will be muted.',
    category: 'other',
    locale: 'en',
  },
  {
    id: '0195b000-0000-7000-8000-000000000010',
    title: 'Спам в микрофон',
    body: '{player}, прекратите спамить в микрофон, иначе будете замьючены.',
    category: 'other',
    locale: 'ru',
  },
];

export async function ensureDefaultMessageTemplates(db: DatabaseClient): Promise<void> {
  await db
    .insert(messageTemplates)
    .values(
      DEFAULT_MESSAGE_TEMPLATES.map((template, index) => ({
        id: template.id,
        title: template.title,
        body: template.body,
        category: template.category,
        locale: template.locale,
        sortOrder: (index + 1) * 10,
        isEnabled: true,
        createdBy: null,
      })),
    )
    .onConflictDoNothing({ target: messageTemplates.id });
}
