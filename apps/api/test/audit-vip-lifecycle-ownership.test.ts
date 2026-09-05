import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import { type CreatedSchema, createIsolatedSchema } from './integration/isolated-db.js';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type SqlClient = ReturnType<typeof postgres>;

function runAudit(databaseUrl: string, fenceAction?: 'enable' | 'disable') {
  return spawnSync('pnpm', ['--silent', 'audit:vip-lifecycle-ownership'], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ...(fenceAction ? { VIP_LIFECYCLE_FENCE_ACTION: fenceAction } : {}),
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

describe('аудит владельца активных VIP-назначений перед строгим режимом', () => {
  let database: CreatedSchema;
  let sql: SqlClient;

  beforeEach(async () => {
    database = await createIsolatedSchema();
    sql = postgres(database.url, { max: 1, onnotice: () => undefined });
  });

  afterEach(async () => {
    await sql?.end();
    await database?.drop();
  });

  async function createVipRole() {
    const [binding] = await sql<{ role_id: string }[]>`
      SELECT role.id AS role_id
      FROM roles role
      JOIN role_squad_permissions permission ON permission.role_id = role.id
      WHERE role.name = 'QueuePriority'
        AND role.panel_access = false
        AND role.is_system_role = false
        AND permission.squad_permission_key = 'reserve'
    `;
    if (!binding) throw new Error('provisioned QueuePriority role is missing');
    await sql`
      INSERT INTO vip_tiers (id, name, role_id, default_days, price_bonuses, is_active)
      VALUES (${randomUUID()}, 'BSS VIP', ${binding.role_id}, NULL, NULL, true)
    `;
    return binding.role_id;
  }

  async function createPlayer(roleId: string, expiresAt: Date, steamId64: bigint) {
    const playerId = randomUUID();
    await sql`
      INSERT INTO players (
        id,
        steam_id64,
        canonical_name,
        canonical_name_normalized,
        role_id,
        role_expires_at
      ) VALUES (
        ${playerId},
        ${steamId64},
        ${`VIP audit ${playerId}`},
        ${`vip audit ${playerId}`},
        ${roleId},
        ${expiresAt}
      )
    `;
    return { playerId, steamId64 };
  }

  async function attachLifecycleOwner(
    playerId: string,
    steamId64: bigint,
    roleId: string,
    expiresAt: Date,
    roleComment = 'VIP vip2 purchase purchase-audit',
  ) {
    const eventId = `vip-audit-${randomUUID()}`;
    await sql`
      INSERT INTO vip_lifecycle_events (
        event_id,
        event_type,
        player_id,
        role_id,
        tier,
        purchase_id,
        action,
        payload,
        applied_at
      ) VALUES (
        ${eventId},
        'vip.purchased',
        ${playerId},
        ${roleId},
        'vip2',
        'purchase-audit',
        'assigned',
        ${sql.json({ expires_at: expiresAt.toISOString() })},
        now()
      )
    `;
    await sql`
      UPDATE players
      SET role_lifecycle_event_id = ${eventId}, role_comment = ${roleComment}
      WHERE steam_id64 = ${steamId64}
    `;
    return eventId;
  }

  async function strictFenceState(): Promise<boolean> {
    const [row] = await sql<{ vip_lifecycle_strict: boolean }[]>`
      SELECT vip_lifecycle_strict FROM panel_meta WHERE id = 1
    `;
    if (!row) throw new Error('panel_meta singleton is missing');
    return row.vip_lifecycle_strict;
  }

  async function attachNewerLegacyRevocation(
    playerId: string,
    roleId: string,
    assignedEventId: string,
  ): Promise<void> {
    await sql`
      UPDATE vip_lifecycle_events
      SET received_at = '2029-01-01T00:00:00.000Z'
      WHERE event_id = ${assignedEventId}
    `;
    await sql`
      INSERT INTO vip_lifecycle_events (
        event_id,
        event_type,
        player_id,
        role_id,
        tier,
        purchase_id,
        action,
        payload,
        received_at,
        applied_at
      ) VALUES (
        ${`vip-audit-revoked-${randomUUID()}`},
        'vip.expired',
        ${playerId},
        ${roleId},
        'vip2',
        'purchase-audit',
        'revoked',
        ${sql.json({})},
        '2030-01-01T00:00:00.000Z',
        '2030-01-01T00:00:00.000Z'
      )
    `;
  }

  it('атомарно включает fence после чистого аудита, не считая ручную роль orphan', async () => {
    const roleId = await createVipRole();
    await createPlayer(roleId, new Date('2099-01-01T00:00:00.000Z'), testSteamId(997_008));

    const result = runAudit(database.url, 'enable');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'Проверено активных VIP-назначений: 0; без владельца bss-store: 0; writer fence включён\n',
    );
    expect(await strictFenceState()).toBe(true);
  });

  it('не включает fence при orphan и откатывает переключение вместе с аудитом', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-01-02T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_009));
    await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    await sql`
      UPDATE players
      SET role_lifecycle_event_id = NULL
      WHERE steam_id64 = ${steamId64}
    `;

    const result = runAudit(database.url, 'enable');

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 1; конфликтующих lifecycle marker: 0\n',
    );
    expect(await strictFenceState()).toBe(false);
  });

  it('снимает fence только отдельным явным rollback-действием', async () => {
    await sql`UPDATE panel_meta SET vip_lifecycle_strict = true WHERE id = 1`;

    const result = runAudit(database.url, 'disable');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('VIP lifecycle writer fence выключен явной rollback-командой\n');
    expect(await strictFenceState()).toBe(false);
  });

  it('не считает ручную VIP-роль без lifecycle-истории orphan', async () => {
    const roleId = await createVipRole();
    const { playerId, steamId64 } = await createPlayer(
      roleId,
      new Date('2099-01-01T00:00:00.000Z'),
      testSteamId(997_001),
    );
    const before = await sql`
      SELECT role_id, role_expires_at, role_comment, role_lifecycle_event_id
      FROM players
      WHERE steam_id64 = ${steamId64}
    `;

    const result = runAudit(database.url);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'Проверено активных VIP-назначений: 0; без владельца bss-store: 0\n',
    );
    expect(
      await sql`
        SELECT role_id, role_expires_at, role_comment, role_lifecycle_event_id
        FROM players
        WHERE steam_id64 = ${steamId64}
      `,
    ).toEqual(before);
    expect(
      await sql`SELECT event_id FROM vip_lifecycle_events WHERE player_id = ${playerId}`,
    ).toEqual([]);
  });

  it('не считает старый legacy assigned действующим после более нового revoke', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-01-03T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_010));
    const assignedEventId = await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    await attachNewerLegacyRevocation(playerId, roleId, assignedEventId);
    await sql`
      UPDATE players
      SET role_lifecycle_event_id = NULL, role_comment = NULL
      WHERE steam_id64 = ${steamId64}
    `;

    const result = runAudit(database.url);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'Проверено активных VIP-назначений: 0; без владельца bss-store: 0\n',
    );
  });

  it('считает marker на старый legacy assigned конфликтом после более нового revoke', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-01-04T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_011));
    const assignedEventId = await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    await attachNewerLegacyRevocation(playerId, roleId, assignedEventId);

    const result = runAudit(database.url);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 0; конфликтующих lifecycle marker: 1\n',
    );
  });

  it('считает revisioned assigned действующим поверх legacy-события с той же миллисекундой', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-01-05T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_012));
    const legacyEventId = await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    const eventId = `vip-audit-revisioned-${randomUUID()}`;
    const receivedAt = new Date('2030-01-01T00:00:00.000Z');
    await sql`
      UPDATE vip_lifecycle_events
      SET received_at = ${receivedAt}
      WHERE event_id = ${legacyEventId}
    `;
    await sql`
      INSERT INTO vip_lifecycle_events (
        event_id,
        event_type,
        player_id,
        role_id,
        tier,
        purchase_id,
        revision,
        action,
        payload,
        received_at,
        applied_at
      ) VALUES (
        ${eventId},
        'vip.extended',
        ${playerId},
        ${roleId},
        'vip2',
        'purchase-audit',
        1,
        'assigned',
        ${sql.json({ expires_at: expiresAt.toISOString() })},
        ${receivedAt},
        ${receivedAt}
      )
    `;
    await sql`
      UPDATE players
      SET role_lifecycle_event_id = ${eventId}
      WHERE steam_id64 = ${steamId64}
    `;

    const result = runAudit(database.url);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'Проверено активных VIP-назначений: 1; без владельца bss-store: 0\n',
    );
  });

  it('отклоняет точную lifecycle-проекцию с потерянным marker', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-01-02T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_007));
    await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    await sql`
      UPDATE players
      SET role_lifecycle_event_id = NULL
      WHERE steam_id64 = ${steamId64}
    `;

    const result = runAudit(database.url);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 1; конфликтующих lifecycle marker: 0\n',
    );
  });

  it('не теряет orphan, если tier mapping удалили до cutover', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-01-06T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_014));
    await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    await sql`
      UPDATE players
      SET role_lifecycle_event_id = NULL
      WHERE steam_id64 = ${steamId64}
    `;
    await sql`DELETE FROM vip_tiers WHERE role_id = ${roleId}`;

    const result = runAudit(database.url);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 1; конфликтующих lifecycle marker: 0\n',
    );
  });

  it('принимает точного владельца bss-store и не считает истёкшую роль активной', async () => {
    const roleId = await createVipRole();
    const activePlayer = await createPlayer(
      roleId,
      new Date('2099-02-01T00:00:00.000Z'),
      testSteamId(997_002),
    );
    await attachLifecycleOwner(
      activePlayer.playerId,
      activePlayer.steamId64,
      roleId,
      new Date('2099-02-01T00:00:00.000Z'),
    );
    await createPlayer(roleId, new Date('2020-01-01T00:00:00.000Z'), testSteamId(997_003));

    const result = runAudit(database.url);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'Проверено активных VIP-назначений: 1; без владельца bss-store: 0\n',
    );
  });

  it('отклоняет владельца, роль которого больше не имеет безопасного активного tier mapping', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-02-03T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_013));
    await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    await sql`UPDATE vip_tiers SET is_active = false WHERE role_id = ${roleId}`;

    const result = runAudit(database.url);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 0; конфликтующих lifecycle marker: 1\n',
    );
  });

  it('отклоняет проекцию на superseded assigned-событие', async () => {
    const roleId = await createVipRole();
    const expiresAt = new Date('2099-02-02T00:00:00.000Z');
    const { playerId, steamId64 } = await createPlayer(roleId, expiresAt, testSteamId(997_006));
    const assignedEventId = await attachLifecycleOwner(playerId, steamId64, roleId, expiresAt);
    const winnerEventId = `vip-audit-winner-${randomUUID()}`;
    await sql`
      UPDATE vip_lifecycle_events
      SET revision = 4
      WHERE event_id = ${assignedEventId}
    `;
    await sql`
      INSERT INTO vip_lifecycle_events (
        event_id,
        event_type,
        player_id,
        role_id,
        tier,
        purchase_id,
        revision,
        action,
        payload,
        applied_at
      ) VALUES (
        ${winnerEventId},
        'vip.refunded',
        ${playerId},
        ${roleId},
        'vip2',
        'purchase-audit',
        5,
        'revoked',
        ${sql.json({})},
        now()
      )
    `;
    await sql`
      UPDATE vip_lifecycle_events
      SET superseded_by_event_id = ${winnerEventId}
      WHERE event_id = ${assignedEventId}
    `;

    const result = runAudit(database.url);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 0; конфликтующих lifecycle marker: 1\n',
    );
  });

  it('не признаёт один маркер владельцем при расхождении проекции', async () => {
    const roleId = await createVipRole();
    const { playerId, steamId64 } = await createPlayer(
      roleId,
      new Date('2099-03-01T00:00:00.000Z'),
      testSteamId(997_004),
    );
    await attachLifecycleOwner(
      playerId,
      steamId64,
      roleId,
      new Date('2099-03-01T00:00:00.000Z'),
      'ручное назначение',
    );

    const result = runAudit(database.url);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 0; конфликтующих lifecycle marker: 1\n',
    );
    expect(
      await sql`
        SELECT role_id, role_lifecycle_event_id
        FROM players
        WHERE steam_id64 = ${steamId64}
      `,
    ).toHaveLength(1);
  });

  it('отклоняет конфликтующий marker даже у роли вне активного VIP-каталога', async () => {
    const roleId = randomUUID();
    await sql`
      INSERT INTO roles (id, name)
      VALUES (${roleId}, ${`Non-VIP marker role ${roleId}`})
    `;
    const { playerId, steamId64 } = await createPlayer(
      roleId,
      new Date('2099-04-01T00:00:00.000Z'),
      testSteamId(997_005),
    );
    await attachLifecycleOwner(
      playerId,
      steamId64,
      roleId,
      new Date('2099-04-01T00:00:00.000Z'),
      'конфликтующая проекция',
    );

    const result = runAudit(database.url);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: 0; конфликтующих lifecycle marker: 1\n',
    );
    expect(
      await sql`
        SELECT role_id, role_lifecycle_event_id
        FROM players
        WHERE steam_id64 = ${steamId64}
      `,
    ).toEqual([{ role_id: roleId, role_lifecycle_event_id: expect.any(String) }]);
  });
});
