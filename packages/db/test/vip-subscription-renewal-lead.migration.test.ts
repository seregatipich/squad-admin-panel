import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { VIP_RENEWAL_LEAD_MS } from '../src/economy/vip-grant.js';
import { describeIfDb } from './helpers/describe-if.js';
import {
  createIsolatedPackageTestDatabase,
  MIGRATIONS_FOLDER,
} from './helpers/isolated-database.js';

/**
 * Issue #44 (w3-15): migration 0129 moves the billing date of active VIP
 * subscriptions created before `VIP_RENEWAL_LEAD_MS` existed ahead of their
 * role expiry (#364); migrations 0126 and 0128 add the indexes the reworked API
 * routes rely on.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const ROLE_EXPIRES_AT = new Date('2026-12-01T00:00:00.000Z');
const HOUR_MS = 3_600_000;

describeIfDb('migration 0129 vip_subscription_renewal_lead', () => {
  it('puts old subscriptions ahead of their role expiry and creates the route indexes', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_api_route_audit', {
      throughMigration: '0118_clan_members_release_disbanded',
    });
    const sql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      const [role] = await sql<{ id: string }[]>`
        SELECT id FROM roles WHERE name = 'QueuePriority' LIMIT 1`;
      const [otherRole] = await sql<{ id: string }[]>`
        SELECT id FROM roles WHERE name <> 'QueuePriority' AND NOT is_system_role LIMIT 1`;
      if (!role || !otherRole) throw new Error('seed roles missing');
      const [tier] = await sql<{ id: string }[]>`
        INSERT INTO vip_tiers (id, name, role_id, is_active)
        VALUES (gen_random_uuid(), 'Audit VIP', ${role.id}, true)
        RETURNING id`;
      if (!tier) throw new Error('tier insert failed');

      const seed = async (
        steamId: string,
        roleId: string,
        status: string,
        nextRenewalAt: Date,
      ): Promise<string> => {
        const [player] = await sql<{ id: string }[]>`
          INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized, role_id, role_expires_at)
          VALUES (${steamId}, ${steamId}, ${steamId}, ${roleId}, ${ROLE_EXPIRES_AT})
          RETURNING id`;
        if (!player) throw new Error('player insert failed');
        const [subscription] = await sql<{ id: string }[]>`
          INSERT INTO vip_subscriptions
            (id, player_id, tier_id, status, renews_every_days, price_bonuses, next_renewal_at)
          VALUES (gen_random_uuid(), ${player.id}, ${tier.id}, ${status}, 30, 100, ${nextRenewalAt})
          RETURNING id`;
        if (!subscription) throw new Error('subscription insert failed');
        return subscription.id;
      };

      const lagging = await seed('76561190000044901', role.id, 'active', ROLE_EXPIRES_AT);
      const alreadyAhead = new Date(ROLE_EXPIRES_AT.getTime() - 24 * HOUR_MS);
      const ahead = await seed('76561190000044902', role.id, 'active', alreadyAhead);
      const cancelled = await seed('76561190000044903', role.id, 'cancelled', ROLE_EXPIRES_AT);
      const otherRoleHolder = await seed(
        '76561190000044904',
        otherRole.id,
        'active',
        ROLE_EXPIRES_AT,
      );

      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });

      const rows = await sql<{ id: string; next_renewal_at: Date | string }[]>`
        SELECT id, next_renewal_at FROM vip_subscriptions`;
      const renewalOf = (id: string) => {
        const row = rows.find((candidate) => candidate.id === id);
        return row ? new Date(row.next_renewal_at).getTime() : undefined;
      };
      expect(renewalOf(lagging)).toBe(ROLE_EXPIRES_AT.getTime() - VIP_RENEWAL_LEAD_MS);
      expect(renewalOf(ahead)).toBe(alreadyAhead.getTime());
      expect(renewalOf(cancelled)).toBe(ROLE_EXPIRES_AT.getTime());
      expect(renewalOf(otherRoleHolder)).toBe(ROLE_EXPIRES_AT.getTime());

      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'chat_messages_matched_rule_idx',
          'player_sessions_server_disconnected_idx',
          'players_canonical_name_normalized_trgm_idx',
          'player_name_history_name_normalized_trgm_idx'
        )`;
      expect(new Set(indexes.map((row) => row.indexname))).toEqual(
        new Set([
          'chat_messages_matched_rule_idx',
          'player_sessions_server_disconnected_idx',
          'players_canonical_name_normalized_trgm_idx',
          'player_name_history_name_normalized_trgm_idx',
        ]),
      );
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);
});
