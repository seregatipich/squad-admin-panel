-- Seed the built-in message templates once (#36). They used to be inserted by
-- ensureDefaultMessageTemplates() on every GET /api/v1/message-templates with
-- ON CONFLICT DO NOTHING, so DELETE of a built-in template was undone by the
-- next read. The API no longer seeds at runtime; this migration is the only
-- seed, so a deleted template stays deleted.
--
-- Rollback-safe: data only. The previous release still re-seeds on read,
-- which is the old behaviour. A built-in template an operator deleted before
-- this migration had already been resurrected by that release, so re-inserting
-- missing ids here changes nothing visible.
INSERT INTO message_templates (id, title, body, category, locale, sort_order, is_enabled, created_by)
VALUES
  ('0195b000-0000-7000-8000-000000000001', 'Claiming assets',
   '{player}, do not claim vehicles you cannot crew. Release the asset or you will be kicked from {server}.',
   'warn', 'en', 10, true, NULL),
  ('0195b000-0000-7000-8000-000000000002', 'Клейм техники',
   '{player}, не клеймите технику без экипажа. Освободите её, иначе будете кикнуты с {server}.',
   'warn', 'ru', 20, true, NULL),
  ('0195b000-0000-7000-8000-000000000003', 'Unreadable name',
   '{player}, your name is unreadable. Change it to a legible one to keep playing on {server}.',
   'warn', 'en', 30, true, NULL),
  ('0195b000-0000-7000-8000-000000000004', 'Нечитаемый ник',
   '{player}, ваш ник нечитаем. Смените его на читаемый, чтобы продолжить игру на {server}.',
   'warn', 'ru', 40, true, NULL),
  ('0195b000-0000-7000-8000-000000000005', 'Teamkill apology',
   'Sorry for the teamkill, {player}. It was an accident.',
   'info', 'en', 50, true, NULL),
  ('0195b000-0000-7000-8000-000000000006', 'Извинение за тимкил',
   '{player}, извините за тимкил — это была случайность.',
   'info', 'ru', 60, true, NULL),
  ('0195b000-0000-7000-8000-000000000007', 'Take SL kit',
   '{player}, take a squad leader kit or hand the squad over to someone who will.',
   'warn', 'en', 70, true, NULL),
  ('0195b000-0000-7000-8000-000000000008', 'Возьмите кит СЛ',
   '{player}, возьмите кит сквадлидера или передайте отряд тому, кто возьмёт.',
   'warn', 'ru', 80, true, NULL),
  ('0195b000-0000-7000-8000-000000000009', 'Welcome',
   'Welcome to {server}, {player}! Please read the rules before you start playing.',
   'info', 'en', 90, true, NULL),
  ('0195b000-0000-7000-8000-00000000000a', 'Приветствие',
   'Добро пожаловать на {server}, {player}! Ознакомьтесь с правилами перед началом игры.',
   'info', 'ru', 100, true, NULL),
  ('0195b000-0000-7000-8000-00000000000b', 'Main camping',
   '{player}, stop camping the enemy main base. This is against the rules of {server}.',
   'warn', 'en', 110, true, NULL),
  ('0195b000-0000-7000-8000-00000000000c', 'Кемпинг мейна',
   '{player}, прекратите кемпить вражескую базу. Это нарушение правил {server}.',
   'warn', 'ru', 120, true, NULL),
  ('0195b000-0000-7000-8000-00000000000d', 'VIP slot active',
   '{player}, your VIP slot on {server} is active. Thank you for supporting the project.',
   'vip', 'en', 130, true, NULL),
  ('0195b000-0000-7000-8000-00000000000e', 'VIP-слот активен',
   '{player}, ваш VIP-слот на {server} активен. Спасибо за поддержку проекта.',
   'vip', 'ru', 140, true, NULL),
  ('0195b000-0000-7000-8000-00000000000f', 'Mic spam',
   '{player}, please stop mic spamming or you will be muted.',
   'other', 'en', 150, true, NULL),
  ('0195b000-0000-7000-8000-000000000010', 'Спам в микрофон',
   '{player}, прекратите спамить в микрофон, иначе будете замьючены.',
   'other', 'ru', 160, true, NULL)
ON CONFLICT (id) DO NOTHING;
