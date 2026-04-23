import {
  customType,
  index,
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

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name'),
    totpSecretEncrypted: bytea('totp_secret_encrypted'),
    totpKeyVersion: text('totp_key_version').default('1'),
    totpBackupCodesHash: text('totp_backup_codes_hash').array(),
    totpLastUsedStep: text('totp_last_used_step'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    emailLowerIdx: uniqueIndex('users_email_lower_idx').on(
      // lower(email) — Drizzle supports raw SQL for index expressions
      // using `.where(sql\`...\`)` would only filter; we need the expression.
      // We materialise the lowercase in a generated SQL via raw in migrations.
      table.email,
    ),
    createdAtIdx: index('users_created_at_idx').on(table.createdAt),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
