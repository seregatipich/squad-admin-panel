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

type InsertBuilder = {
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
};

function makeDb() {
  const insertBuilder: InsertBuilder = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  insertBuilder.values.mockReturnValue(insertBuilder);

  return {
    insert: vi.fn().mockReturnValue(insertBuilder),
    _insertBuilder: insertBuilder,
  } as never;
}

describe('upsertPlayers', () => {
  it('returns immediately without any DB call when input is empty', async () => {
    const db = makeDb();
    await upsertPlayers(db, []);
    expect(
      (db as ReturnType<typeof makeDb> & { insert: ReturnType<typeof vi.fn> }).insert,
    ).not.toHaveBeenCalled();
  });

  it('calls insert once per player for players table and once for name history', async () => {
    const db = makeDb();
    await upsertPlayers(db, [makePlayer()]);
    const insertMock = (db as ReturnType<typeof makeDb> & { insert: ReturnType<typeof vi.fn> })
      .insert;
    expect(insertMock).toHaveBeenCalledTimes(2);
  });

  it('calls insert 2×n for n players (players + name history per player)', async () => {
    const db = makeDb();
    const players = [
      makePlayer({ steam_id64: '76561198000000001', name: 'Alpha' }),
      makePlayer({ steam_id64: '76561198000000002', name: 'Beta' }),
      makePlayer({ steam_id64: '76561198000000003', name: 'Gamma' }),
    ];
    await upsertPlayers(db, players);
    const insertMock = (db as ReturnType<typeof makeDb> & { insert: ReturnType<typeof vi.fn> })
      .insert;
    expect(insertMock).toHaveBeenCalledTimes(6);
  });

  it('uses onConflictDoUpdate for each insert', async () => {
    const db = makeDb();
    await upsertPlayers(db, [makePlayer()]);
    const { _insertBuilder } = db as ReturnType<typeof makeDb> & { _insertBuilder: InsertBuilder };
    expect(_insertBuilder.onConflictDoUpdate).toHaveBeenCalledTimes(2);
  });

  it('converts steam_id64 string to BigInt when inserting player', async () => {
    const db = makeDb();
    await upsertPlayers(db, [makePlayer({ steam_id64: '76561198000000099' })]);
    const { _insertBuilder } = db as ReturnType<typeof makeDb> & { _insertBuilder: InsertBuilder };
    const firstValuesCall = _insertBuilder.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstValuesCall.steamId64).toBe(BigInt('76561198000000099'));
  });

  it('normalises player name to lowercase trimmed form', async () => {
    const db = makeDb();
    await upsertPlayers(db, [makePlayer({ name: '  SQUAD Player  ' })]);
    const { _insertBuilder } = db as ReturnType<typeof makeDb> & { _insertBuilder: InsertBuilder };
    const firstValuesCall = _insertBuilder.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstValuesCall.canonicalNameNormalized).toBe('squad player');
  });
});
