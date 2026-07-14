import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { mediaFiles } from './media-files.js';
import { playerReports } from './player-reports.js';

/**
 * Link table between `player_reports` (REPORT-2) and `media_files` (MOD-3/VIDEO-1),
 * used by REPORT-4 to attach evidence (uploaded screenshots/clips or external links)
 * to a report submitted from the panel. A report may reference up to a small,
 * API-enforced number of media files; a media file may be attached to more than
 * one report.
 */
export const reportEvidence = pgTable(
  'report_evidence',
  {
    reportId: uuid('report_id')
      .notNull()
      .references(() => playerReports.id, { onDelete: 'cascade' }),
    mediaFileId: uuid('media_file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.reportId, table.mediaFileId] }),
    mediaIdx: index('report_evidence_media_idx').on(table.mediaFileId),
  }),
);

export type ReportEvidenceRow = typeof reportEvidence.$inferSelect;
export type NewReportEvidence = typeof reportEvidence.$inferInsert;
