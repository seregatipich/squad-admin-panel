import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { issues } from './issues.js';
import { players } from './players.js';

export const ISSUE_LINK_ENTITY_TYPES = [
  'player',
  'server',
  'moderation_action',
  'media_file',
] as const;
export type IssueLinkEntityType = (typeof ISSUE_LINK_ENTITY_TYPES)[number];

/**
 * Structural link between a tracker ticket and a panel entity — a player, a
 * server, a moderation action, or a media file (ISSUE-3, #156). It is what
 * turns "разобраться с жалобой на игрока X" from free text into a row the
 * player card can count.
 *
 * The discriminator mirrors `media_links` (#158) deliberately: `entityId` is
 * **not** a foreign key, because it addresses one of four different tables
 * depending on `entityType`, so a single FK is impossible. Existence is
 * therefore checked by the route layer before insert, and the read path
 * degrades a vanished target to a "deleted object" label instead of failing.
 *
 * Deletion strategy (fixed by the acceptance criteria): `issueId` is
 * `ON DELETE CASCADE`, so a deleted ticket takes its links with it. The
 * polymorphic side cannot carry `RESTRICT` — "нельзя удалить игрока при живых
 * ссылках" is unreachable there — and the panel exposes no hard player-delete
 * route anyway; a player row disappearing merely renders the link as deleted.
 *
 * `createdBy` is `SET NULL` on the linking player's deletion so the link
 * survives; it drives the ownership check on detach (`can_manage_issues` is
 * required to remove someone else's link).
 */
export const issueLinks = pgTable(
  'issue_links',
  {
    id: uuid('id').primaryKey().notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    entityTypeCheck: check(
      'issue_links_entity_type_check',
      sql`${table.entityType} IN ('player','server','moderation_action','media_file')`,
    ),
    issueEntityKey: uniqueIndex('issue_links_issue_entity_key').on(
      table.issueId,
      table.entityType,
      table.entityId,
    ),
    entityIdx: index('issue_links_entity_idx').on(table.entityType, table.entityId),
    issueIdx: index('issue_links_issue_idx').on(table.issueId),
  }),
);

export type IssueLinkRow = typeof issueLinks.$inferSelect;
export type NewIssueLink = typeof issueLinks.$inferInsert;
