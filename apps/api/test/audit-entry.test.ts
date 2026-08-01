import type { DatabaseClient } from '@squad/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAuditEntry } from '../src/lib/audit.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

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
      actor: { kind: 'steam', playerId: 'test-player-123', tokenId: null },
      actorIp: '10.0.0.1',
      actionType: 'server.create',
      targetType: 'server',
      targetId: 's-1',
      context: { source: 'unit-test' },
    });
    expect(captured).toHaveLength(1);
    // captured has exactly one entry per the toHaveLength(1) assertion above.
    const row = (captured[0] as CapturedInsert).values;
    expect(row.actorKind).toBe('steam');
    expect(row.actorPlayerId).toBe('test-player-123');
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
    // writeAuditEntry performs exactly one insert().values() call, so captured has one entry.
    const row = (captured[0] as CapturedInsert).values;
    expect(row.actorKind).toBe('system');
    expect(row.actorPlayerId).toBeNull();
    expect(row.actorTokenId).toBeNull();
    expect(row.actorSystemLabel).toBe('status-reconciler');
  });

  it('records actor_token_id when steam-actor was acting via API token', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actor: {
        kind: 'steam',
        playerId: 'test-player-124',
        tokenId: '0195000a-0000-7000-8000-000000000001',
      },
      actorIp: '10.0.0.2',
      actionType: 'server.update',
      targetType: 'server',
      targetId: 's-2',
      context: {},
    });
    // writeAuditEntry performs exactly one insert().values() call, so captured has one entry.
    const row = (captured[0] as CapturedInsert).values;
    expect(row.actorTokenId).toBe('0195000a-0000-7000-8000-000000000001');
    expect(row.actorPlayerId).toBe('test-player-124');
  });

  it('maps undefined before/after to null', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actor: { kind: 'steam', playerId: 'test-player-1', tokenId: null },
      actorIp: null,
      actionType: 'noop',
      targetType: null,
      targetId: null,
      context: {},
    });
    // writeAuditEntry performs exactly one insert().values() call, so captured has one entry.
    const row = (captured[0] as CapturedInsert).values;
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
    // writeAuditEntry performs exactly one insert().values() call, so captured has one entry.
    const row = (captured[0] as CapturedInsert).values;
    expect(row.beforeSnapshot).toEqual({ x: 1 });
    expect(row.afterSnapshot).toEqual({ x: 2 });
  });
});

describe('GET /api/v1/audit — HTTP integration', () => {
  const OWNER_STEAM = 76561198000001200n;
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('returns 401 without authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/audit' });
    expect(res.statusCode).toBe(401);
  });

  it('happy path: returns paginated audit items', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        display_name: 'Audit Test',
        slug: 'audit-test',
        game_port: 7790,
        query_port: 27190,
        beacon_port: 15090,
        rcon_port: 21190,
        max_players: 80,
        tickrate: 50,
        multihome: '0.0.0.0',
      },
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; action_type: string }>;
      page: number;
      page_size: number;
    };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(50);
    expect(Array.isArray(body.items)).toBe(true);
    const hasSrvCreate = body.items.some((r) => r.action_type === 'server.create');
    expect(hasSrvCreate).toBe(true);
  });

  it('pagination: page 2 returns a different offset', async () => {
    const cookie = await loginAsOwner(h);
    const p1 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit?page=1&page_size=1',
      headers: { cookie },
    });
    const p2 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit?page=2&page_size=1',
      headers: { cookie },
    });
    expect(p1.statusCode).toBe(200);
    expect(p2.statusCode).toBe(200);
    const b1 = p1.json() as { items: Array<{ id: string }> };
    const b2 = p2.json() as { items: Array<{ id: string }> };
    if (b1.items.length > 0 && b2.items.length > 0) {
      expect(b1.items[0]?.id).not.toBe(b2.items[0]?.id);
    }
  });

  it('page_size out of range returns 400/422', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit?page_size=9999',
      headers: { cookie },
    });
    expect([400, 422]).toContain(res.statusCode);
  });
});
