import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { mediaFiles } from './media-files.js';
import { players } from './players.js';

export const MEDIA_PUBLICATION_DESTINATIONS = ['youtube', 'telegram'] as const;
export type MediaPublicationDestination = (typeof MEDIA_PUBLICATION_DESTINATIONS)[number];

export const MEDIA_PUBLICATION_STATUSES = ['queued', 'uploading', 'published', 'failed'] as const;
export type MediaPublicationStatus = (typeof MEDIA_PUBLICATION_STATUSES)[number];

/**
 * Outbound fan-out of a stored media file to a public community channel
 * (VIDEO-4, #160) — the showcase counterpart to the internal evidence store.
 *
 * The row is the queue: `worker-media-publisher` claims every row whose
 * `status = 'queued'` and `next_attempt_at <= now()` with a conditional
 * `UPDATE ... SET status = 'uploading' ... RETURNING`, so two workers can never
 * pick up the same publication. Failure handling deliberately distinguishes
 * three outcomes, because conflating them is what makes an upload queue lose
 * work:
 *
 * - a transient error bumps `attempts`, sets an exponential `next_attempt_at`
 *   and returns the row to `'queued'`;
 * - a YouTube daily-quota wall also returns the row to `'queued'` but does
 *   **not** touch `attempts` — an outage outside our control must never burn
 *   the retry budget and tip the job into `'failed'`;
 * - only a permanent rejection (or an exhausted retry budget) reaches
 *   `'failed'`.
 *
 * `external_url` is nullable on success: a Telegram message is only publicly
 * addressable for `@username` channels and `-100…` supergroups, and inventing a
 * link for the rest would strand the "release the local file" mode behind a URL
 * that resolves to nothing.
 *
 * Credentials for either destination live exclusively in the worker's
 * environment. Nothing token-shaped is ever written to this table.
 */
export const mediaPublications = pgTable(
  'media_publications',
  {
    id: uuid('id').primaryKey().notNull(),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    destination: text('destination').notNull(),
    status: text('status').notNull().default('queued'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    requestedByPlayerId: uuid('requested_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    destinationCheck: check(
      'media_publications_destination_check',
      sql`${table.destination} IN ('youtube','telegram')`,
    ),
    statusCheck: check(
      'media_publications_status_check',
      sql`${table.status} IN ('queued','uploading','published','failed')`,
    ),
    attemptsNonneg: check('media_publications_attempts_nonneg', sql`${table.attempts} >= 0`),
    mediaDestinationKey: uniqueIndex('media_publications_media_destination_key').on(
      table.mediaId,
      table.destination,
    ),
    dueIdx: index('media_publications_due_idx').on(table.status, table.nextAttemptAt),
  }),
);

export type MediaPublicationRow = typeof mediaPublications.$inferSelect;
export type NewMediaPublication = typeof mediaPublications.$inferInsert;
