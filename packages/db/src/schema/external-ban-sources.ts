import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const externalBanSources = pgTable(
  'external_ban_sources',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    url: text('url').notNull(),
    format: text('format').notNull(),
    authHeaderEncrypted: bytea('auth_header_encrypted'),
    trustLevel: text('trust_level').notNull().default('normal'),
    onMatch: text('on_match').notNull().default('alert'),
    discordUrl: text('discord_url'),
    enabled: boolean('enabled').notNull().default(true),
    pollIntervalMinutes: integer('poll_interval_minutes').notNull().default(60),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }),
    lastSyncStatus: text('last_sync_status'),
    lastSyncError: text('last_sync_error'),
    importedCount: integer('imported_count').notNull().default(0),
    parserConfig: jsonb('parser_config').notNull().default({}),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    formatChk: check(
      'external_ban_sources_format_chk',
      sql`${table.format} IN ('squad_bans_cfg','battlemetrics_json','json_generic','csv')`,
    ),
    trustLevelChk: check(
      'external_ban_sources_trust_level_chk',
      sql`${table.trustLevel} IN ('trusted','normal','low')`,
    ),
    onMatchChk: check(
      'external_ban_sources_on_match_chk',
      sql`${table.onMatch} IN ('none','alert','kick')`,
    ),
    lastSyncStatusChk: check(
      'external_ban_sources_last_sync_status_chk',
      sql`${table.lastSyncStatus} IS NULL OR ${table.lastSyncStatus} IN ('ok','error')`,
    ),
    pollIntervalChk: check(
      'external_ban_sources_poll_interval_chk',
      sql`${table.pollIntervalMinutes} >= 15`,
    ),
  }),
);

export const externalBans = pgTable(
  'external_bans',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => externalBanSources.id, { onDelete: 'cascade' }),
    steamId64: text('steam_id64'),
    eosId: text('eos_id'),
    nickname: text('nickname'),
    reason: text('reason'),
    adminName: text('admin_name'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    raw: jsonb('raw').notNull().default({}),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    identityChk: check(
      'external_bans_identity_chk',
      sql`${table.steamId64} IS NOT NULL OR ${table.eosId} IS NOT NULL`,
    ),
    dedupKey: uniqueIndex('external_bans_dedup_key').on(
      table.sourceId,
      sql`coalesce(${table.steamId64}, '')`,
      sql`coalesce(${table.eosId}, '')`,
      sql`coalesce(${table.issuedAt}, 'epoch'::timestamptz)`,
    ),
    steamIdIdx: index('external_bans_steam_id64_idx')
      .on(table.steamId64)
      .where(sql`steam_id64 IS NOT NULL`),
    eosIdIdx: index('external_bans_eos_id_idx').on(table.eosId).where(sql`eos_id IS NOT NULL`),
    sourceIdIdx: index('external_bans_source_id_idx').on(table.sourceId),
  }),
);

export type ExternalBanSourceRow = typeof externalBanSources.$inferSelect;
export type NewExternalBanSource = typeof externalBanSources.$inferInsert;
export type ExternalBanRow = typeof externalBans.$inferSelect;
export type NewExternalBan = typeof externalBans.$inferInsert;
