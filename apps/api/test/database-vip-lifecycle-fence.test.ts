import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import databasePlugin from '../src/plugins/database.js';
import { type CreatedSchema, createIsolatedSchema } from './integration/isolated-db.js';

describe('startup-ограждение VIP lifecycle', () => {
  let database: CreatedSchema;
  let sql: ReturnType<typeof postgres>;

  beforeEach(async () => {
    database = await createIsolatedSchema();
    sql = postgres(database.url, { max: 1, onnotice: () => undefined });
  });

  afterEach(async () => {
    await sql?.end();
    await database?.drop();
  });

  function config(requireRevision: boolean, databaseUrl = database.url): AppConfig {
    return {
      DATABASE_URL: databaseUrl,
      VIP_LIFECYCLE_REQUIRE_REVISION: requireRevision,
    } as AppConfig;
  }

  async function persistedState(): Promise<boolean> {
    const [row] = await sql<{ vip_lifecycle_strict: boolean }[]>`
      SELECT vip_lifecycle_strict FROM panel_meta WHERE id = 1
    `;
    if (!row) throw new Error('panel_meta singleton is missing');
    return row.vip_lifecycle_strict;
  }

  async function expectStartupIntegrityFailure(
    requireRevision: boolean,
    databaseUrl = database.url,
  ): Promise<void> {
    const app = Fastify({ logger: false });
    app.register(databasePlugin, { config: config(requireRevision, databaseUrl) });

    let startupError: unknown;
    try {
      await app.ready();
    } catch (error) {
      startupError = error;
    }
    await app.close().catch(() => undefined);
    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toBe('VIP lifecycle fence integrity check failed');
  }

  it('strict startup audits and atomically enables the durable fence', async () => {
    const app = Fastify({ logger: false });

    app.register(databasePlugin, { config: config(true) });
    await app.ready();

    expect(await persistedState()).toBe(true);
    await app.close();
  });

  it('refuses relaxed startup while the durable fence is still enabled', async () => {
    await sql`UPDATE panel_meta SET vip_lifecycle_strict = true WHERE id = 1`;
    const app = Fastify({ logger: false });

    app.register(databasePlugin, { config: config(false) });

    await expect(app.ready()).rejects.toThrow('VIP lifecycle fence mode mismatch');
    expect(await persistedState()).toBe(true);
    await app.close().catch(() => undefined);
  });

  it('rejects a direct downgrade of the durable fence', async () => {
    await sql`UPDATE panel_meta SET vip_lifecycle_strict = true WHERE id = 1`;

    await expect(
      sql`UPDATE panel_meta SET vip_lifecycle_strict = false WHERE id = 1`,
    ).rejects.toThrow();
    expect(await persistedState()).toBe(true);
  });

  it('rejects deletion of the enabled durable fence state', async () => {
    await sql`UPDATE panel_meta SET vip_lifecycle_strict = true WHERE id = 1`;

    await expect(sql`DELETE FROM panel_meta WHERE id = 1`).rejects.toThrow();
    expect(await persistedState()).toBe(true);
  });

  it('does not enable strict mode when the ownership audit finds an orphan', async () => {
    const roleId = randomUUID();
    const tierId = randomUUID();
    const playerId = randomUUID();
    const eventId = `startup-orphan-${randomUUID()}`;
    const expiresAt = new Date('2099-01-01T00:00:00.000Z');
    await sql`INSERT INTO roles (id, name) VALUES (${roleId}, ${`Startup VIP ${roleId}`})`;
    await sql`
      INSERT INTO vip_tiers (id, name, role_id, default_days)
      VALUES (${tierId}, ${`Startup tier ${tierId}`}, ${roleId}, 30)
    `;
    await sql`
      INSERT INTO players (
        id, canonical_name, canonical_name_normalized, role_id, role_expires_at, role_comment
      ) VALUES (
        ${playerId}, 'Startup orphan', 'startup orphan', ${roleId}, ${expiresAt},
        ${`VIP ${tierId} purchase startup`}
      )
    `;
    await sql`
      INSERT INTO vip_lifecycle_events (
        event_id, event_type, player_id, role_id, tier, purchase_id, action, payload, applied_at
      ) VALUES (
        ${eventId}, 'vip.purchased', ${playerId}, ${roleId}, ${tierId}, 'startup', 'assigned',
        ${sql.json({ expires_at: expiresAt.toISOString() })}, now()
      )
    `;
    const app = Fastify({ logger: false });

    app.register(databasePlugin, { config: config(true) });

    await expect(app.ready()).rejects.toThrow('VIP lifecycle ownership audit failed');
    expect(await persistedState()).toBe(false);
    await app.close().catch(() => undefined);
  });

  it('refuses strict startup when the player fence trigger is missing', async () => {
    await sql`DROP TRIGGER trg_players_vip_lifecycle_owner_guard ON players`;

    await expectStartupIntegrityFailure(true);
    expect(await persistedState()).toBe(false);
  });

  it('refuses relaxed startup when a required fence trigger is disabled', async () => {
    await sql`ALTER TABLE vip_tiers DISABLE TRIGGER trg_vip_tiers_writer_fence_lock`;

    await expectStartupIntegrityFailure(false);
    expect(await persistedState()).toBe(false);
  });

  it('refuses startup when a trigger name is rebound to another function', async () => {
    await sql.unsafe(`
      CREATE FUNCTION vip_lifecycle_noop_trigger()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS 'BEGIN RETURN NEW; END'
    `);
    await sql`DROP TRIGGER trg_players_vip_lifecycle_owner_guard ON players`;
    await sql.unsafe(`
      CREATE TRIGGER trg_players_vip_lifecycle_owner_guard
      BEFORE INSERT OR UPDATE OF role_id, role_expires_at, role_comment, role_lifecycle_event_id
      ON players
      FOR EACH ROW EXECUTE FUNCTION vip_lifecycle_noop_trigger()
    `);

    await expectStartupIntegrityFailure(true);
    expect(await persistedState()).toBe(false);
  });

  it('refuses a same-named trigger function rebound from another visible schema', async () => {
    await sql`CREATE SCHEMA vip_shadow`;
    await sql.unsafe(`
      CREATE FUNCTION vip_shadow.enforce_players_vip_lifecycle_owner()
      RETURNS trigger
      LANGUAGE plpgsql
      AS 'BEGIN RETURN NEW; END'
    `);
    await sql`DROP TRIGGER trg_players_vip_lifecycle_owner_guard ON players`;
    await sql.unsafe(`
      CREATE TRIGGER trg_players_vip_lifecycle_owner_guard
      BEFORE INSERT OR UPDATE OF role_id, role_expires_at, role_comment, role_lifecycle_event_id
      ON players
      FOR EACH ROW EXECUTE FUNCTION vip_shadow.enforce_players_vip_lifecycle_owner()
    `);
    const shadowUrl = new URL(database.url);
    shadowUrl.searchParams.set('options', '-c search_path=vip_shadow,public');

    await expectStartupIntegrityFailure(true, shadowUrl.toString());
    expect(await persistedState()).toBe(false);
  });

  it('refuses startup when a fence function body drifts', async () => {
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION enforce_players_vip_lifecycle_owner()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS 'BEGIN RETURN NEW; END'
    `);

    await expectStartupIntegrityFailure(true);
    expect(await persistedState()).toBe(false);
  });
});
