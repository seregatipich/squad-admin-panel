import { recordIpObservation } from '@squad/db';
import type { EventEnvelope, PlayerConnectedPayload } from '@squad/shared-types';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePlayerConnected } from '../src/player-identity/store.js';

vi.mock('@squad/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@squad/db')>();
  return { ...actual, recordIpObservation: vi.fn(async () => undefined) };
});

const EOS_A = 'abcdef0123456789abcdef0123456789';
const STEAM_1 = '76561198000000001';
const STEAM_2 = '76561198000000002';

interface ExistingRow {
  id: string;
  steamId64: bigint | null;
  canonicalName: string;
  eosId: string | null;
  steamEosConflict: boolean;
}

function connectEvent(payload: Partial<PlayerConnectedPayload> = {}): EventEnvelope {
  return {
    event_id: uuidv7(),
    version: 1,
    type: 'player.connected',
    server_id: '00000000-0000-7000-8000-0000000000ff',
    ts: new Date().toISOString(),
    actor: null,
    correlation_id: null,
    payload: {
      steam_id64: STEAM_1,
      eos_id: EOS_A,
      name: 'CurrentName',
      ip: null,
      ...payload,
    },
  };
}

interface InsertedRow {
  values: Record<string, unknown>;
}
interface UpdatedRow {
  set: Record<string, unknown>;
}

function makeDb(
  opts: { existing?: ExistingRow[]; racedExisting?: ExistingRow[]; insertConflicts?: boolean } = {},
) {
  const insertedValues: InsertedRow[] = [];
  const updatedValues: UpdatedRow[] = [];
  let selectCall = 0;

  const selectChain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(() => {
          selectCall += 1;
          if (selectCall === 1) return Promise.resolve(opts.existing ?? []);
          return Promise.resolve(opts.racedExisting ?? opts.existing ?? []);
        }),
      }),
    }),
  };

  const updateChain = {
    set: vi.fn().mockImplementation((set: Record<string, unknown>) => ({
      where: vi.fn().mockImplementation(() => {
        updatedValues.push({ set });
        return Promise.resolve(undefined);
      }),
    })),
  };

  const insertChain = {
    values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      insertedValues.push({ values: vals });
      const isPlayerRow = 'canonicalName' in vals;
      const returningResult =
        isPlayerRow && opts.insertConflicts ? [] : [{ id: (vals.id as string) ?? 'generated' }];
      return {
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(returningResult),
        }),
        returning: vi.fn().mockResolvedValue(returningResult),
      };
    }),
  };

  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue(updateChain),
    insert: vi.fn().mockReturnValue(insertChain),
    _inserted: insertedValues,
    _updated: updatedValues,
  };
  return db as unknown as Parameters<typeof handlePlayerConnected>[0] & {
    _inserted: InsertedRow[];
    _updated: UpdatedRow[];
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function playerInsert(db: ReturnType<typeof makeDb>) {
  return db._inserted.find((r) => 'canonicalName' in r.values);
}
function nameHistoryInsert(db: ReturnType<typeof makeDb>) {
  return db._inserted.find((r) => 'nameNormalized' in r.values);
}
function auditInsert(db: ReturnType<typeof makeDb>, action: string) {
  return db._inserted.find((r) => r.values.actionType === action);
}

beforeEach(() => {
  vi.mocked(recordIpObservation).mockClear();
});

describe('handlePlayerConnected', () => {
  it('ignores non-connect events', async () => {
    const db = makeDb();
    const result = await handlePlayerConnected(db, {
      ...connectEvent(),
      type: 'player.disconnected',
    });
    expect(result).toEqual({ outcome: 'ignored' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('creates a new player with a uuidv7 id, first name-history row, and player.created audit', async () => {
    const db = makeDb({ existing: [] });
    const result = await handlePlayerConnected(db, connectEvent());

    const player = playerInsert(db);
    expect(player?.values.eosId).toBe(EOS_A);
    expect(player?.values.steamId64).toBe(BigInt(STEAM_1));
    expect(player?.values.canonicalName).toBe('CurrentName');
    // uuidv7: version nibble is 7
    expect(String(player?.values.id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(nameHistoryInsert(db)?.values.name).toBe('CurrentName');
    expect(auditInsert(db, 'player.created')).toBeDefined();
    expect(result).toMatchObject({ outcome: 'created' });
  });

  it('creates an EOS-only player (steam absent) with a null steam_id64', async () => {
    const db = makeDb({ existing: [] });
    const result = await handlePlayerConnected(
      db,
      connectEvent({ steam_id64: null as unknown as string, eos_id: EOS_A }),
    );
    expect(playerInsert(db)?.values.steamId64).toBeNull();
    expect(playerInsert(db)?.values.eosId).toBe(EOS_A);
    expect(result).toMatchObject({ outcome: 'created' });
  });

  it('updates canonical name and writes name-history when the nickname changed', async () => {
    const db = makeDb({
      existing: [
        {
          id: uuidv7(),
          steamId64: BigInt(STEAM_1),
          canonicalName: 'OldName',
          eosId: EOS_A,
          steamEosConflict: false,
        },
      ],
    });
    const result = await handlePlayerConnected(db, connectEvent({ name: 'NewName' }));

    expect(db._updated[0]?.set.canonicalName).toBe('NewName');
    expect(db._updated[0]?.set.canonicalNameNormalized).toBeDefined();
    expect(nameHistoryInsert(db)?.values.name).toBe('NewName');
    expect(auditInsert(db, 'player.created')).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'updated', nameChanged: true });
  });

  it('back-fills steam_id64 and audits player.steam_linked when steam was previously null', async () => {
    const db = makeDb({
      existing: [
        {
          id: uuidv7(),
          steamId64: null,
          canonicalName: 'CurrentName',
          eosId: EOS_A,
          steamEosConflict: false,
        },
      ],
    });
    const result = await handlePlayerConnected(db, connectEvent({ steam_id64: STEAM_1 }));

    expect(db._updated[0]?.set.steamId64).toBe(BigInt(STEAM_1));
    expect(auditInsert(db, 'player.steam_linked')).toBeDefined();
    expect(db._updated[0]?.set.steamEosConflict).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'updated', steamLinked: true, conflict: false });
  });

  it('back-fills eos_id onto a steam-matched row whose eos_id was null', async () => {
    const db = makeDb({
      existing: [
        {
          id: uuidv7(),
          steamId64: BigInt(STEAM_1),
          canonicalName: 'CurrentName',
          eosId: null,
          steamEosConflict: false,
        },
      ],
    });
    const result = await handlePlayerConnected(db, connectEvent({ eos_id: EOS_A }));
    expect(db._updated[0]?.set.eosId).toBe(EOS_A);
    expect(result).toMatchObject({ outcome: 'updated' });
  });

  it('is idempotent for a repeated identical connect: only last_seen_at, no new rows, no audit', async () => {
    const db = makeDb({
      existing: [
        {
          id: uuidv7(),
          steamId64: BigInt(STEAM_1),
          canonicalName: 'CurrentName',
          eosId: EOS_A,
          steamEosConflict: false,
        },
      ],
    });
    const result = await handlePlayerConnected(db, connectEvent());

    const setKeys = Object.keys(db._updated[0]?.set ?? {}).sort();
    expect(setKeys).toEqual(['lastSeenAt', 'updatedAt']);
    expect(nameHistoryInsert(db)).toBeUndefined();
    expect(db._inserted.filter((r) => 'actionType' in r.values)).toHaveLength(0);
    expect(result).toMatchObject({
      outcome: 'updated',
      nameChanged: false,
      steamLinked: false,
      conflict: false,
    });
  });

  it('flags a steam<->eos conflict, stores the latest steam, and audits player.eos_steam_conflict', async () => {
    const db = makeDb({
      existing: [
        {
          id: uuidv7(),
          steamId64: BigInt(STEAM_1),
          canonicalName: 'CurrentName',
          eosId: EOS_A,
          steamEosConflict: false,
        },
      ],
    });
    const result = await handlePlayerConnected(db, connectEvent({ steam_id64: STEAM_2 }));

    expect(db._updated[0]?.set.steamId64).toBe(BigInt(STEAM_2));
    expect(db._updated[0]?.set.steamEosConflict).toBe(true);
    const audit = auditInsert(db, 'player.eos_steam_conflict');
    expect(audit).toBeDefined();
    expect(auditInsert(db, 'player.steam_linked')).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'updated', conflict: true });
  });

  it('records an IP observation when the payload carries an ip', async () => {
    const db = makeDb({ existing: [] });
    await handlePlayerConnected(db, connectEvent({ ip: '203.0.113.7' }));
    expect(recordIpObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ip: '203.0.113.7' }),
    );
  });

  it('does not record an IP observation when the payload ip is null', async () => {
    const db = makeDb({ existing: [] });
    await handlePlayerConnected(db, connectEvent({ ip: null }));
    expect(recordIpObservation).not.toHaveBeenCalled();
  });

  it('collapses onto the existing row when the insert loses a create race', async () => {
    const winner: ExistingRow = {
      id: uuidv7(),
      steamId64: BigInt(STEAM_1),
      canonicalName: 'CurrentName',
      eosId: EOS_A,
      steamEosConflict: false,
    };
    const db = makeDb({ existing: [], racedExisting: [winner], insertConflicts: true });
    const result = await handlePlayerConnected(db, connectEvent());

    // The create audit is only written on a genuine fresh insert, never after a race.
    expect(auditInsert(db, 'player.created')).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'updated', playerId: winner.id });
  });
});
