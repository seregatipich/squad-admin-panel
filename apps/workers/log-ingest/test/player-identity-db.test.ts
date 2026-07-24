import {
  auditLog,
  createDatabaseClient,
  playerIpHistory,
  playerNameHistory,
  players,
} from '@squad/db';
import type { EventEnvelope, PlayerConnectedPayload } from '@squad/shared-types';
import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { handlePlayerConnected } from '../src/player-identity/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the PLAYER-1 test database');

const db = createDatabaseClient(DATABASE_URL);
const SERVER_ID = '00000000-0000-7000-8000-000000000122';

// Test-range identities (unique per file) so cleanup stays scoped to this suite.
const EOS_IDEMPOTENT = 'aa00000000000000000000000000e001';
const EOS_CONCURRENT = 'aa00000000000000000000000000e002';
const EOS_RENAME = 'aa00000000000000000000000000e003';
const EOS_BACKFILL = 'aa00000000000000000000000000e004';
const EOS_CONFLICT = 'aa00000000000000000000000000e005';
const EOS_IP = 'aa00000000000000000000000000e006';
const ALL_EOS = [EOS_IDEMPOTENT, EOS_CONCURRENT, EOS_RENAME, EOS_BACKFILL, EOS_CONFLICT, EOS_IP];

const STEAM_BACKFILL = '76561199220000004';
const STEAM_CONFLICT_1 = '76561199220000051';
const STEAM_CONFLICT_2 = '76561199220000052';
const STEAM_IP = '76561199220000006';

function connectEvent(payload: Partial<PlayerConnectedPayload>): EventEnvelope {
  return {
    event_id: uuidv7(),
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: new Date().toISOString(),
    actor: null,
    correlation_id: null,
    payload: {
      steam_id64: null as unknown as string,
      eos_id: null,
      name: 'PL1 Player',
      ip: null,
      ...payload,
    },
  };
}

async function cleanup(): Promise<void> {
  // `audit_log` is append-only (trigger-enforced), so audit rows cannot be
  // deleted. Each test creates players with fresh uuidv7 ids, so audit counts
  // queried by `target_id` stay scoped to a single run regardless. Deleting the
  // players cascades their name/ip history away.
  await db.delete(players).where(inArray(players.eosId, ALL_EOS));
}

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.$client.end();
});

async function playerByEos(eosId: string) {
  const rows = await db.select().from(players).where(eq(players.eosId, eosId)).limit(1);
  return rows[0];
}

async function auditsFor(playerId: string, action: string) {
  return db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, playerId), eq(auditLog.actionType, action)));
}

describe('handlePlayerConnected (real database)', () => {
  it('is idempotent: a repeated identical connect creates no new rows', async () => {
    const event = connectEvent({ eos_id: EOS_IDEMPOTENT, steam_id64: '76561199220000001' });
    const first = await handlePlayerConnected(db, event);
    expect(first).toMatchObject({ outcome: 'created' });

    const created = await playerByEos(EOS_IDEMPOTENT);
    const firstSeen = created?.lastSeenAt;

    const second = await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_IDEMPOTENT,
        steam_id64: '76561199220000001',
      }),
    );
    expect(second).toMatchObject({ outcome: 'updated', nameChanged: false });

    const rows = await db.select().from(players).where(eq(players.eosId, EOS_IDEMPOTENT));
    expect(rows).toHaveLength(1);

    const history = await db
      .select()
      .from(playerNameHistory)
      .where(eq(playerNameHistory.playerId, rows[0].id));
    expect(history).toHaveLength(1);

    const createdAudits = await auditsFor(rows[0].id, 'player.created');
    expect(createdAudits).toHaveLength(1);

    const after = await playerByEos(EOS_IDEMPOTENT);
    expect(after?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(firstSeen?.getTime() ?? 0);
  });

  it('collapses concurrent connects of the same eos_id to a single row', async () => {
    const mk = () =>
      connectEvent({ eos_id: EOS_CONCURRENT, steam_id64: '76561199220000002', name: 'Concur' });
    await Promise.all([
      handlePlayerConnected(db, mk()),
      handlePlayerConnected(db, mk()),
      handlePlayerConnected(db, mk()),
    ]);

    const rows = await db.select().from(players).where(eq(players.eosId, EOS_CONCURRENT));
    expect(rows).toHaveLength(1);
    const history = await db
      .select()
      .from(playerNameHistory)
      .where(eq(playerNameHistory.playerId, rows[0].id));
    expect(history).toHaveLength(1);
  });

  it('updates canonical name and appends a name-history row on rename', async () => {
    await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_RENAME,
        steam_id64: '76561199220000003',
        name: 'OldNick',
      }),
    );
    await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_RENAME,
        steam_id64: '76561199220000003',
        name: 'NewNick',
      }),
    );

    const player = await playerByEos(EOS_RENAME);
    expect(player?.canonicalName).toBe('NewNick');

    const history = await db
      .select()
      .from(playerNameHistory)
      .where(eq(playerNameHistory.playerId, player?.id ?? ''));
    expect(history.map((h) => h.name).sort()).toEqual(['NewNick', 'OldNick']);
  });

  it('back-fills steam_id64 and persists it with a steam_linked audit', async () => {
    const created = await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_BACKFILL,
        steam_id64: null as unknown as string,
        name: 'EpicOnly',
      }),
    );
    expect(created).toMatchObject({ outcome: 'created' });
    expect((await playerByEos(EOS_BACKFILL))?.steamId64).toBeNull();

    const linked = await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_BACKFILL,
        steam_id64: STEAM_BACKFILL,
        name: 'EpicOnly',
      }),
    );
    expect(linked).toMatchObject({ outcome: 'updated', steamLinked: true, conflict: false });

    const player = await playerByEos(EOS_BACKFILL);
    expect(player?.steamId64).toBe(BigInt(STEAM_BACKFILL));
    expect(player?.steamEosConflict).toBe(false);
    expect(await auditsFor(player?.id ?? '', 'player.steam_linked')).toHaveLength(1);
  });

  it('flags and persists a steam<->eos conflict, storing the latest steam', async () => {
    await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_CONFLICT,
        steam_id64: STEAM_CONFLICT_1,
        name: 'Conflicter',
      }),
    );
    const result = await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_CONFLICT,
        steam_id64: STEAM_CONFLICT_2,
        name: 'Conflicter',
      }),
    );
    expect(result).toMatchObject({ outcome: 'updated', conflict: true });

    const player = await playerByEos(EOS_CONFLICT);
    expect(player?.steamEosConflict).toBe(true);
    expect(player?.steamId64).toBe(BigInt(STEAM_CONFLICT_2));
    expect(await auditsFor(player?.id ?? '', 'player.eos_steam_conflict')).toHaveLength(1);
  });

  it('records an IP observation and updates last_known_ip when the connect carries an ip', async () => {
    await handlePlayerConnected(
      db,
      connectEvent({
        eos_id: EOS_IP,
        steam_id64: STEAM_IP,
        name: 'WithIp',
        ip: '198.51.100.23',
      }),
    );

    const player = await playerByEos(EOS_IP);
    expect(player?.lastKnownIp).toBe('198.51.100.23');
    const ipRows = await db
      .select()
      .from(playerIpHistory)
      .where(eq(playerIpHistory.playerId, player?.id ?? ''));
    expect(ipRows).toHaveLength(1);
    expect(ipRows[0]?.ip).toBe('198.51.100.23');
  });
});
