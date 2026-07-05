import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const BONUS_TX_TYPES = [
  'earn_online',
  'earn_boost',
  'earn_seed',
  'spend',
  'adjust',
] as const;
export type BonusTxType = (typeof BONUS_TX_TYPES)[number];

export const bonusTransactions = pgTable(
  'bonus_transactions',
  {
    id: bigserial('id', { mode: 'bigint' }).notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    type: text('type').notNull(),
    referenceType: text('reference_type'),
    referenceId: text('reference_id'),
    comment: text('comment'),
    actorPlayerId: uuid('actor_player_id').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.createdAt] }),
    accrualIdempotencyIdx: uniqueIndex('bonus_transactions_accrual_idempotency_idx').on(
      table.playerId,
      table.type,
      table.referenceType,
      table.referenceId,
      table.createdAt,
    ),
    playerCreatedIdx: index('bonus_transactions_player_created_idx').on(
      table.playerId,
      table.createdAt,
    ),
    createdAtBrinIdx: index('bonus_transactions_created_at_brin_idx')
      .using('brin', table.createdAt)
      .with({ pages_per_range: 32 }),
    typeChk: check(
      'bonus_transactions_type_chk',
      sql`type IN ('earn_online','earn_boost','earn_seed','spend','adjust')`,
    ),
    amountNonzeroChk: check('bonus_transactions_amount_nonzero_chk', sql`amount <> 0`),
  }),
);

export type BonusTransactionRow = typeof bonusTransactions.$inferSelect;
export type NewBonusTransaction = typeof bonusTransactions.$inferInsert;
