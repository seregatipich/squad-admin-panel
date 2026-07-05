import { boolean, customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const GEOIP_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-0000006e01ff';

export const geoipSettings = pgTable('geoip_settings', {
  id: uuid('id').primaryKey().notNull(),
  accountId: text('account_id'),
  licenseKeyEncrypted: bytea('license_key_encrypted'),
  dbPath: text('db_path'),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true, mode: 'date' }),
  enabled: boolean('enabled').notNull().default(false),
  keyVersion: integer('key_version').notNull().default(1),
  countrySwitchWindowHours: integer('country_switch_window_hours').notNull().default(24),
  multiCountryThreshold: integer('multi_country_threshold').notNull().default(3),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export type GeoipSettingsRow = typeof geoipSettings.$inferSelect;
export type NewGeoipSettings = typeof geoipSettings.$inferInsert;
