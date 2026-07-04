import { describe, expect, it, vi } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import { upsertPlayers } from '../src/persist.js';

function makePlayer(overrides?: Partial<RconPlayer>): RconPlayer {
  return {
    rcon_id: 1,
    eos_id: 'abcdef0123456789abcdef0123456789',
    steam_id64: '76561198000000001',
    name: 'TestPlayer',
    team_id: 1,
    squad_id: 2,
    is_leader: false,
    role: 'USA_Rifleman_01',
    ...overrides,
  };
}

function makeDb(
  existingPlayers: Array<{
    id: string;
    steamId64: bigint | null;
    canonicalName: string;
    eosId: string | null;
  }> = [],
) {
  const insertedValues: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updatedValues: Array<{ table: string; set: Record<string, unknown> }> = [];

  const selectChain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(() => Promise.resolve(existingPlayers)),
      }),
    }),
  };

  const updateChain = {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((_args: unknown) => {
        updatedValues.push({
          table: 'players',
          set: updateChain.set.mock.calls[updateChain.set.mock.calls.length - 1]?.[0],
        });
        return Promise.resolve(undefined);
      }),
    }),
  };

  const insertChain = {
    values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      insertedValues.push({ table: 'unknown', values: vals });
      return {
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };

  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue(updateChain),
    insert: vi.fn().mockReturnValue(insertChain),
    _insertedValues: insertedValues,
    _updatedValues: updatedValues,
  };

  return db as never;
}

describe('upsertPlayers', () => {
  it('returns immediately without any DB call when input is empty', async () => {
    const db = makeDb();
    await upsertPlayers(db, []);
    expect((db as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it('creates new player with UUIDv7 when not found', async () => {
    const db = makeDb([]);
    await upsertPlayers(db, [makePlayer()]);
    const insertMock = (db as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertMock).toHaveBeenCalledTimes(3); // players + name_history + audit_log
  });

  it('updates existing player instead of inserting', async () => {
    const db = makeDb([
      {
        id: '00000000-0000-7000-8000-000000000001',
        steamId64: BigInt('76561198000000001'),
        canonicalName: 'OldName',
        eosId: 'abcdef0123456789abcdef0123456789',
      },
    ]);
    await upsertPlayers(db, [makePlayer()]);
    const updateMock = (db as { update: ReturnType<typeof vi.fn> }).update;
    expect(updateMock).toHaveBeenCalled();
  });

  it('creates audit event for new player', async () => {
    const db = makeDb([]);
    await upsertPlayers(db, [makePlayer()]);
    const insertMock = (db as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertMock).toHaveBeenCalledTimes(3);
  });

  it('handles multiple players', async () => {
    const db = makeDb([]);
    const players = [
      makePlayer({ steam_id64: '76561198000000001', name: 'Alpha' }),
      makePlayer({ steam_id64: '76561198000000002', name: 'Beta' }),
    ];
    await upsertPlayers(db, players);
    const selectMock = (db as { select: ReturnType<typeof vi.fn> }).select;
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('creates an EOS-only player with a null steam_id64', async () => {
    const db = makeDb([]);
    await upsertPlayers(db, [makePlayer({ steam_id64: null, name: 'EpicOnly' })]);
    const inserted = (db as { _insertedValues: Array<{ values: Record<string, unknown> }> })
      ._insertedValues;
    const playerRow = inserted.find((row) => 'canonicalName' in row.values);
    expect(playerRow?.values.steamId64).toBeNull();
    expect(playerRow?.values.eosId).toBe('abcdef0123456789abcdef0123456789');
  });

  it('does not steam-link an EOS-only player onto an existing row', async () => {
    const db = makeDb([
      {
        id: '00000000-0000-7000-8000-000000000002',
        steamId64: null,
        canonicalName: 'OldName',
        eosId: 'abcdef0123456789abcdef0123456789',
      },
    ]);
    await upsertPlayers(db, [makePlayer({ steam_id64: null })]);
    const insertMock = (db as { insert: ReturnType<typeof vi.fn> }).insert;
    const auditInsert = (
      db as { _insertedValues: Array<{ values: Record<string, unknown> }> }
    )._insertedValues.find((row) => row.values.actionType === 'player.steam_linked');
    expect(auditInsert).toBeUndefined();
    expect(insertMock).toHaveBeenCalled();
  });
});
