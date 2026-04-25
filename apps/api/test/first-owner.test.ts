import * as schema from '@squad/db/schema';
import {
  organizationMembers,
  organizations,
  playerRoleAssignments,
  players,
} from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFirstOwner } from '../src/lib/first-owner.js';
import { createIsolatedSchema, runMigrations } from './integration/harness.js';

interface FakeBridge {
  fileRead: ReturnType<typeof vi.fn>;
  fileAtomicWrite: ReturnType<typeof vi.fn>;
}

const fakeBridge = (existingSentinel: boolean): FakeBridge => ({
  fileRead: vi.fn(async () => {
    if (existingSentinel) return { content: '{}' };
    throw new Error('ENOENT');
  }),
  fileAtomicWrite: vi.fn(async () => ({ status: 'written' })),
});

describe('claimFirstOwner', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let sql: ReturnType<typeof postgres>;
  // biome-ignore lint/suspicious/noExplicitAny: test setup
  let db: any;
  let orgId: string;

  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    sql = postgres(schemaInfo.url, { max: 1, onnotice: () => undefined });
    db = drizzle(sql, { schema });
    orgId = uuidv7();
    await db.insert(organizations).values({ id: orgId, name: 'T', slug: 't' });
    await seedSystemRoles(db, orgId);
  });

  afterEach(async () => {
    await sql.end({ timeout: 5 });
    await schemaInfo.drop();
  });

  it('claims first owner when neither anchor is set', async () => {
    const bridge = fakeBridge(false);
    const result = await claimFirstOwner(db, bridge, 76561198000000010n);
    expect(result).toBe('claimed');
    const ras = await db
      .select()
      .from(playerRoleAssignments)
      .where(eq(playerRoleAssignments.steamId64, 76561198000000010n));
    expect(ras.length).toBe(1);
    const member = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.steamId64, 76561198000000010n));
    expect(member.length).toBe(1);
    const player = await db.select().from(players).where(eq(players.steamId64, 76561198000000010n));
    expect(player[0]?.canonicalName).toBe('Player 0010');
    const orgRow = await db.select().from(organizations).limit(1);
    expect((orgRow[0]?.settings as Record<string, unknown>).first_owner_claimed).toBe(true);
    expect(bridge.fileAtomicWrite).toHaveBeenCalledTimes(1);
  });

  it('returns already_claimed when sentinel exists (short-circuits before tx)', async () => {
    const bridge = fakeBridge(true);
    const result = await claimFirstOwner(db, bridge, 76561198000000011n);
    expect(result).toBe('already_claimed');
    expect(bridge.fileAtomicWrite).not.toHaveBeenCalled();
    const ras = await db.select().from(playerRoleAssignments);
    expect(ras.length).toBe(0);
  });

  it('returns already_claimed when DB flag is set even without sentinel', async () => {
    const bridge = fakeBridge(false);
    await db
      .update(organizations)
      .set({ settings: { first_owner_claimed: true } })
      .where(eq(organizations.id, orgId));
    const result = await claimFirstOwner(db, bridge, 76561198000000012n);
    expect(result).toBe('already_claimed');
    expect(bridge.fileAtomicWrite).not.toHaveBeenCalled();
  });

  it('rolls back the transaction if sentinel write fails', async () => {
    const bridge = fakeBridge(false);
    bridge.fileAtomicWrite = vi.fn(async () => {
      throw new Error('bridge down');
    });
    await expect(claimFirstOwner(db, bridge, 76561198000000013n)).rejects.toThrow();
    const ras = await db.select().from(playerRoleAssignments);
    expect(ras.length).toBe(0);
    const orgRow = await db.select().from(organizations).limit(1);
    expect((orgRow[0]?.settings as Record<string, unknown>).first_owner_claimed).not.toBe(true);
  });

  it('serialises concurrent calls — exactly one claims', async () => {
    const bridge = fakeBridge(false);
    const ids = Array.from({ length: 8 }, (_, i) => 76561198000000020n + BigInt(i));
    const results = await Promise.all(ids.map((id) => claimFirstOwner(db, bridge, id)));
    const claimed = results.filter((r) => r === 'claimed').length;
    const already = results.filter((r) => r === 'already_claimed').length;
    expect(claimed).toBe(1);
    expect(already).toBe(7);
    const ras = await db.select().from(playerRoleAssignments);
    expect(ras.length).toBe(1);
  });
});
