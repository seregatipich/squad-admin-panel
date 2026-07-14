import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

const cidr = customType<{ data: string }>({
  dataType() {
    return 'cidr';
  },
});

/**
 * Default scoring weights and confidence thresholds for the ALT-1 candidate
 * engine — tunable at runtime via {@link altDetectionSettings}, but seeded
 * here as both the column defaults and the in-code fallback when the
 * singleton row is absent.
 */
export const ALT_DETECTION_DEFAULT_WEIGHT_SHARED_IP = 50;
export const ALT_DETECTION_DEFAULT_WEIGHT_SHARED_NAME = 25;
export const ALT_DETECTION_DEFAULT_WEIGHT_YOUNG_ACCOUNT = 15;
export const ALT_DETECTION_DEFAULT_WEIGHT_STEAMID_PROXIMITY = 10;
export const ALT_DETECTION_DEFAULT_STEAMID_DELTA_THRESHOLD = 10_000;
export const ALT_DETECTION_DEFAULT_MEDIUM_THRESHOLD = 50;
export const ALT_DETECTION_DEFAULT_HIGH_THRESHOLD = 75;

/**
 * IP/CIDR exclusion list for the ALT-1 candidate engine (VPN exits, CGNAT
 * ranges, internet cafés, …). A shared address covered by an ignored CIDR
 * still surfaces in `matches[]` (with `ignored: true`) but is excluded from
 * `shared_ip_count` and the score's shared-IP signal.
 */
export const altIgnoredIps = pgTable(
  'alt_ignored_ips',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    cidr: cidr('cidr').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    cidrKey: uniqueIndex('alt_ignored_ips_cidr_key').on(table.cidr),
  }),
);

/**
 * Singleton settings row (mirrors {@link coplaySettings}) holding the ALT-1
 * scoring weights and confidence-band thresholds. All four weights are
 * applied as on/off contributions (see `apps/api/src/lib/alt-score.ts`), not
 * scaled by signal magnitude.
 */
export const altDetectionSettings = pgTable(
  'alt_detection_settings',
  {
    id: smallint('id').primaryKey().default(1),
    weightSharedIp: integer('weight_shared_ip')
      .notNull()
      .default(ALT_DETECTION_DEFAULT_WEIGHT_SHARED_IP),
    weightSharedName: integer('weight_shared_name')
      .notNull()
      .default(ALT_DETECTION_DEFAULT_WEIGHT_SHARED_NAME),
    weightYoungAccount: integer('weight_young_account')
      .notNull()
      .default(ALT_DETECTION_DEFAULT_WEIGHT_YOUNG_ACCOUNT),
    weightSteamidProximity: integer('weight_steamid_proximity')
      .notNull()
      .default(ALT_DETECTION_DEFAULT_WEIGHT_STEAMID_PROXIMITY),
    steamidDeltaThreshold: bigint('steamid_delta_threshold', { mode: 'number' })
      .notNull()
      .default(ALT_DETECTION_DEFAULT_STEAMID_DELTA_THRESHOLD),
    mediumThreshold: integer('medium_threshold')
      .notNull()
      .default(ALT_DETECTION_DEFAULT_MEDIUM_THRESHOLD),
    highThreshold: integer('high_threshold')
      .notNull()
      .default(ALT_DETECTION_DEFAULT_HIGH_THRESHOLD),
    updatedByPlayerId: uuid('updated_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('alt_detection_settings_singleton', sql`${table.id} = 1`),
    thresholdsOrder: check(
      'alt_detection_settings_thresholds_chk',
      sql`${table.mediumThreshold} <= ${table.highThreshold}`,
    ),
  }),
);

export type AltIgnoredIpRow = typeof altIgnoredIps.$inferSelect;
export type NewAltIgnoredIp = typeof altIgnoredIps.$inferInsert;
export type AltDetectionSettingsRow = typeof altDetectionSettings.$inferSelect;
export type NewAltDetectionSettings = typeof altDetectionSettings.$inferInsert;
