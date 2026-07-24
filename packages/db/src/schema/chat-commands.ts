import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/** In-game chat commands recognized from live chat (AUTO-4, #75). */
export const CHAT_COMMAND_NAMES = ['stats', 'rules', 'report'] as const;
export type ChatCommandName = (typeof CHAT_COMMAND_NAMES)[number];

/**
 * How AUTO-4 answered an invocation. `rcon_warn` = an `AdminWarn` was enqueued
 * to the requesting player; `none` = recognized but not answered (e.g. no
 * `rules_text` configured, or the player could not be resolved).
 */
export const CHAT_COMMAND_RESPONSE_SOURCES = ['rcon_warn', 'none'] as const;
export type ChatCommandResponseSource = (typeof CHAT_COMMAND_RESPONSE_SOURCES)[number];

/**
 * chat_command_invocations (AUTO-4, #75): append-only history of in-game chat
 * commands (`!stats`, `!rules`, `!report`) recognized by
 * `@squad/worker-log-ingest` (`apps/workers/log-ingest/src/chat/commands.ts`)
 * and answered over RCON.
 *
 * This is AUTO-4's own history and is written for every recognized command,
 * including `!report`. The report *record* itself remains owned by REPORT-1
 * (`player_reports`, written by `apps/workers/log-ingest/src/report/store.ts`
 * via the ingestor's `onReport` path) — a `!report` invocation logs one history
 * row here and does not create a second `player_reports` row or a second
 * Discord notification.
 */
export const chatCommandInvocations = pgTable(
  'chat_command_invocations',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Resolved sender, or null when the sender could not be matched to a player. */
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'set null' }),
    command: text('command').$type<ChatCommandName>().notNull(),
    /** Raw arguments after the command token (e.g. the `!report` target + body). */
    args: text('args').notNull().default(''),
    /** Whether AUTO-4 sent an in-game response for this invocation. */
    responded: boolean('responded').notNull().default(false),
    responseSource: text('response_source').$type<ChatCommandResponseSource>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverCreatedIdx: index('chat_command_invocations_server_created_idx').on(
      table.serverId,
      table.createdAt,
    ),
    commandCheck: check(
      'chat_command_invocations_command_check',
      sql`command IN ('stats','rules','report')`,
    ),
  }),
);

export type ChatCommandInvocationRow = typeof chatCommandInvocations.$inferSelect;
export type NewChatCommandInvocation = typeof chatCommandInvocations.$inferInsert;
