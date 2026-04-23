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
  it('defaults actorKind to "user" and persists the minimum required fields', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actorUserId: 'u-1',
      actorIp: '10.0.0.1',
      actionType: 'server.create',
      targetType: 'server',
      targetId: 's-1',
      context: { source: 'unit-test' },
    });
    expect(captured).toHaveLength(1);
    const row = captured[0]?.values;
    expect(row.actorUserId).toBe('u-1');
    expect(row.actorIp).toBe('10.0.0.1');
    expect(row.actorKind).toBe('user');
    expect(row.actionType).toBe('server.create');
    expect(row.targetType).toBe('server');
    expect(row.targetId).toBe('s-1');
    expect(row.context).toEqual({ source: 'unit-test' });
  });

  it('passes explicit actorKind values through untouched', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actorUserId: null,
      actorIp: null,
      actorKind: 'system',
      actionType: 'scheduler.tick',
      targetType: null,
      targetId: null,
      context: {},
    });
    expect(captured[0]?.values.actorKind).toBe('system');
  });

  it('maps undefined before/after to null', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actorUserId: 'u',
      actorIp: null,
      actionType: 'a',
      targetType: 't',
      targetId: 'id',
      context: {},
    });
    expect(captured[0]?.values.beforeSnapshot).toBeNull();
    expect(captured[0]?.values.afterSnapshot).toBeNull();
  });

  it('preserves object before/after snapshots', async () => {
    const { db, captured } = fakeDb();
    const before = { status: 'stopped' };
    const after = { status: 'running' };
    await writeAuditEntry(db, {
      actorUserId: 'u',
      actorIp: null,
      actionType: 'server.start',
      targetType: 'server',
      targetId: 's-1',
      before,
      after,
      context: {},
    });
    expect(captured[0]?.values.beforeSnapshot).toEqual(before);
    expect(captured[0]?.values.afterSnapshot).toEqual(after);
  });

  it('fills rowHash with an empty buffer (trigger computes the real value)', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actorUserId: 'u',
      actorIp: null,
      actionType: 'x',
      targetType: null,
      targetId: null,
      context: {},
    });
    const rowHash = captured[0]?.values.rowHash as Buffer;
    expect(Buffer.isBuffer(rowHash)).toBe(true);
    expect(rowHash.byteLength).toBe(0);
  });

  it('defaults orgId, statusCode and durationMs to null', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actorUserId: 'u',
      actorIp: null,
      actionType: 'x',
      targetType: null,
      targetId: null,
      context: {},
    });
    expect(captured[0]?.values.orgId).toBeNull();
    expect(captured[0]?.values.statusCode).toBeNull();
    expect(captured[0]?.values.durationMs).toBeNull();
  });

  it('passes statusCode/durationMs/orgId through when provided', async () => {
    const { db, captured } = fakeDb();
    await writeAuditEntry(db, {
      actorUserId: 'u',
      actorIp: null,
      actionType: 'x',
      targetType: null,
      targetId: null,
      context: {},
      statusCode: 403,
      durationMs: 12,
      orgId: 'org-1',
    });
    const row = captured[0]?.values;
    expect(row.statusCode).toBe(403);
    expect(row.durationMs).toBe(12);
    expect(row.orgId).toBe('org-1');
  });
});
