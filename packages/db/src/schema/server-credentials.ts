import { customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const serverCredentials = pgTable('server_credentials', {
  serverId: uuid('server_id')
    .primaryKey()
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  // Nullable: NULL means "resolve against caller's RCON_HOST_DEFAULT env".
  // Non-null is reserved for operator-pinned remote Squad instances.
  rconHost: text('rcon_host'),
  rconPort: integer('rcon_port').notNull(),
  rconPasswordEncrypted: bytea('rcon_password_encrypted').notNull(),
  licenseId: text('license_id'),
  licenseKeyEncrypted: bytea('license_key_encrypted'),
  // SRV-6 (#45): when the stored license last changed. Drives the
  // "restart required" badge — License.cfg is requires_restart, so the
  // license only applies once the container (re)starts after this instant.
  licenseUpdatedAt: timestamp('license_updated_at', { withTimezone: true, mode: 'date' }),
  keyVersion: integer('key_version').notNull().default(1),
});

export type ServerCredentialsRow = typeof serverCredentials.$inferSelect;
export type NewServerCredentials = typeof serverCredentials.$inferInsert;
