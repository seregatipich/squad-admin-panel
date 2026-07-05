import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { chatFlagRules } from './chat-flag-rules.js';
import { players } from './players.js';
import { servers } from './servers.js';

export const CHAT_SCOPES = ['all', 'team', 'squad', 'admin', 'broadcast', 'direct'] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];

export const CHAT_SOURCES = ['log', 'panel'] as const;
export type ChatSource = (typeof CHAT_SOURCES)[number];

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigserial('id', { mode: 'bigint' }).notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull(),
    scope: text('scope').notNull(),
    teamId: smallint('team_id'),
    squadId: integer('squad_id'),
    message: text('message').notNull(),
    source: text('source').notNull().default('log'),
    isFlagged: boolean('is_flagged').notNull().default(false),
    matchedRuleId: uuid('matched_rule_id').references(() => chatFlagRules.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.sentAt] }),
    playerSentIdx: index('chat_messages_player_sent_idx').on(table.playerId, table.sentAt.desc()),
    serverSentIdx: index('chat_messages_server_sent_idx').on(table.serverId, table.sentAt.desc()),
    messageTrgmIdx: index('chat_messages_message_trgm_idx').using(
      'gin',
      sql`${table.message} gin_trgm_ops`,
    ),
    sentAtBrinIdx: index('chat_messages_sent_at_brin_idx')
      .using('brin', table.sentAt)
      .with({ pages_per_range: 32 }),
    scopeChk: check(
      'chat_messages_scope_chk',
      sql`scope IN ('all','team','squad','admin','broadcast','direct')`,
    ),
    sourceChk: check('chat_messages_source_chk', sql`source IN ('log','panel')`),
  }),
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
