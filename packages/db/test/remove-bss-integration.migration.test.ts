import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  createIsolatedPackageTestDatabase,
  MIGRATIONS_FOLDER,
} from './helpers/isolated-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = '76561190000000101';
const STORE_VIP_STEAM_ID = '76561190000000102';

describeIfDb('migration 0115 remove_bss_integration', () => {
  it('upgrades a strict-mode database without taking a store-bought VIP role away', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_remove_bss', {
      throughMigration: '0114_chat_source_rcon',
    });
    const sql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      // The state production had: fence on, a store-owned VIP carrying the
      // lifecycle marker, the site's read token and the bound store tier.
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('squad.vip_lifecycle_fence_rollback', 'on', true)`;
        await tx`
          INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized, role_id)
          VALUES (${OWNER_STEAM_ID}, 'Owner', 'owner',
            (SELECT id FROM roles WHERE name = 'Owner' AND is_system_role))`;
        await tx`
          INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized)
          VALUES (${STORE_VIP_STEAM_ID}, 'Store Vip', 'store vip')`;
        await tx`
          INSERT INTO vip_tiers (id, name, role_id, is_active)
          VALUES (gen_random_uuid(), 'BSS VIP',
            (SELECT id FROM roles WHERE name = 'QueuePriority' LIMIT 1), true)`;
        await tx`
          INSERT INTO player_api_tokens (id, player_id, name, token_hash, scopes)
          SELECT gen_random_uuid(), id, 'bss.games: проверка доступа', 'hash-bss',
                 ARRAY['user:view', 'role:view']
            FROM players WHERE steam_id64 = ${OWNER_STEAM_ID}`;
        await tx`
          INSERT INTO vip_lifecycle_events
            (event_id, event_type, player_id, role_id, tier, purchase_id, action, payload, applied_at)
          SELECT 'evt-store-1', 'vip.purchased', p.id, r.id, 'vip', 'purchase-1', 'assigned',
                 '{"expires_at":"2026-12-01T00:00:00.000Z"}'::jsonb, now()
            FROM players p, roles r
           WHERE p.steam_id64 = ${STORE_VIP_STEAM_ID} AND r.name = 'QueuePriority'`;
        await tx`
          UPDATE players
             SET role_id = (SELECT id FROM roles WHERE name = 'QueuePriority' LIMIT 1),
                 role_expires_at = '2026-12-01T00:00:00Z',
                 role_comment = 'VIP vip purchase purchase-1',
                 role_lifecycle_event_id = 'evt-store-1'
           WHERE steam_id64 = ${STORE_VIP_STEAM_ID}`;
        await tx`UPDATE panel_meta SET vip_lifecycle_strict = true WHERE id = 1`;
      });

      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });

      const [schemaState] = await sql<
        {
          events: string | null;
          marker: number;
          strict: number;
          triggers: number;
          functions: number;
        }[]
      >`
        SELECT to_regclass('public.vip_lifecycle_events')::text AS events,
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_name = 'players' AND column_name = 'role_lifecycle_event_id') AS marker,
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_name = 'panel_meta' AND column_name = 'vip_lifecycle_strict') AS strict,
          (SELECT count(*)::int FROM pg_trigger WHERE tgname IN (
            'trg_players_vip_lifecycle_owner_guard', 'trg_vip_tiers_writer_fence_lock',
            'trg_roles_vip_lifecycle_safety_guard', 'trg_panel_meta_vip_lifecycle_fence_lock',
            'trg_panel_meta_vip_lifecycle_fence_delete', 'trg_vip_tiers_site_binding_guard',
            'trg_roles_site_vip_safety_guard', 'trg_role_squad_permissions_site_vip_guard'
          )) AS triggers,
          (SELECT count(*)::int FROM pg_proc WHERE proname IN (
            'enforce_players_vip_lifecycle_owner', 'lock_vip_lifecycle_writer_fence',
            'enforce_site_vip_binding_safety'
          )) AS functions`;
      expect(schemaState).toEqual({
        events: null,
        marker: 0,
        strict: 0,
        triggers: 0,
        functions: 0,
      });

      const [storeVip] = await sql<{ role: string; expires: string; comment: string }[]>`
        SELECT r.name AS role, to_char(p.role_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS expires,
               p.role_comment AS comment
          FROM players p JOIN roles r ON r.id = p.role_id
         WHERE p.steam_id64 = ${STORE_VIP_STEAM_ID}`;
      expect(storeVip?.role).toBe('QueuePriority');
      expect(storeVip?.expires).toBe('2026-12-01T00:00:00');
      expect(storeVip?.comment).toBe('VIP vip purchase purchase-1');

      const [token] = await sql<{ revoked: boolean }[]>`
        SELECT revoked_at IS NOT NULL AS revoked
          FROM player_api_tokens WHERE name = 'bss.games: проверка доступа'`;
      expect(token?.revoked).toBe(true);

      const [tier] = await sql<{ active: boolean }[]>`
        SELECT is_active AS active FROM vip_tiers WHERE name = 'BSS VIP'`;
      expect(tier?.active).toBe(false);

      // With the fence gone, an ordinary panel write to that player succeeds.
      await sql`
        UPDATE players SET role_comment = 'edited by an admin'
         WHERE steam_id64 = ${STORE_VIP_STEAM_ID}`;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);

  it('applies cleanly to a database that never used the integration', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_remove_bss_fresh');
    const sql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      const [applied] = await sql<{ tag: number }[]>`
        SELECT count(*)::int AS tag FROM drizzle.__drizzle_migrations`;
      const journalLength = (
        await import('../drizzle/meta/_journal.json', { with: { type: 'json' } })
      ).default.entries.length;
      expect(applied?.tag).toBe(journalLength);
      const [events] = await sql<{ events: string | null }[]>`
        SELECT to_regclass('public.vip_lifecycle_events')::text AS events`;
      expect(events?.events).toBeNull();
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);
});
