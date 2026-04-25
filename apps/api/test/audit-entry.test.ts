import type { DatabaseClient } from '@squad/db';
import { describe, expect, it } from 'vitest';
import { writeAuditEntry } from '../src/lib/audit.js';

interface CapturedInsert {
  table: unknown;
  values: Record<string, unknown>;
}

function fakeDb(): { db: DatabaseClient; captured: CapturedInsert[] } {
  const captured: CapturedInsert[] = [];
  const db = {
    insert(table: unknown) {
      return {
        async values(v: Record<string, unknown>) {
          captured.push({ table, values: v });
        },
      };
    },
  } as unknown as DatabaseClient;
  return { db, captured };
}

describe('writeAuditEntry', () => {
  it('writes a steam-actor row with all expected columns', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actor: { kind: 'steam', steamId64: 76561198000000123n, tokenId: null },
      actorIp: '10.0.0.1',
      actionType: 'server.create',
      targetType: 'server',
      targetId: 's-1',
      context: { source: 'unit-test' },
    });
    expect(captured).toHaveLength(1);
    const row = captured[0]!.values;
    expect(row.actorKind).toBe('steam');
    expect(row.actorSteamId64).toBe(76561198000000123n);
    expect(row.actorTokenId).toBeNull();
    expect(row.actorSystemLabel).toBeNull();
    expect(row.actorIp).toBe('10.0.0.1');
    expect(row.actionType).toBe('server.create');
    expect(row.targetType).toBe('server');
    expect(row.targetId).toBe('s-1');
    expect(row.context).toEqual({ source: 'unit-test' });
  });

  it('writes a system-actor row with label and null steam fields', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actor: { kind: 'system', label: 'status-reconciler' },
      actorIp: null,
      actionType: 'scheduler.tick',
      targetType: null,
      targetId: null,
      context: {},
    });
    const row = captured[0]!.values;
    expect(row.actorKind).toBe('system');
    expect(row.actorSteamId64).toBeNull();
    expect(row.actorTokenId).toBeNull();
    expect(row.actorSystemLabel).toBe('status-reconciler');
  });

  it('records actor_token_id when steam-actor was acting via API token', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actor: {
        kind: 'steam',
        steamId64: 76561198000000124n,
        tokenId: '0195000a-0000-7000-8000-000000000001',
      },
      actorIp: '10.0.0.2',
      actionType: 'server.update',
      targetType: 'server',
      targetId: 's-2',
      context: {},
    });
    const row = captured[0]!.values;
    expect(row.actorTokenId).toBe('0195000a-0000-7000-8000-000000000001');
    expect(row.actorSteamId64).toBe(76561198000000124n);
  });

  it('maps undefined before/after to null', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actor: { kind: 'steam', steamId64: 1n, tokenId: null },
      actorIp: null,
      actionType: 'noop',
      targetType: null,
      targetId: null,
      context: {},
    });
    const row = captured[0]!.values;
    expect(row.beforeSnapshot).toBeNull();
    expect(row.afterSnapshot).toBeNull();
  });

  it('maps explicit before/after objects to jsonb-friendly values', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actor: { kind: 'system', label: 'migrator' },
      actorIp: null,
      actionType: 'noop',
      targetType: null,
      targetId: null,
      before: { x: 1 },
      after: { x: 2 },
      context: {},
    });
    const row = captured[0]!.values;
    expect(row.beforeSnapshot).toEqual({ x: 1 });
    expect(row.afterSnapshot).toEqual({ x: 2 });
  });
});
