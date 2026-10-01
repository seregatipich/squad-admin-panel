import { clanMembers, clans, players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

/**
 * #133: every clan mutation writes its audit row in the same transaction as
 * the change, so a failed audit write rolls the change back instead of
 * leaving an unaudited mutation behind the hash chain.
 */
const failingActions = new Set<string>();

vi.mock('../../src/lib/audit.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/audit.js')>();
  return {
    ...original,
    writeAuditEntry: vi.fn(async (...args: Parameters<typeof original.writeAuditEntry>) => {
      if (failingActions.has(args[1].actionType)) throw new Error('audit write failed');
      return original.writeAuditEntry(...args);
    }),
  };
});

const OWNER_STEAM = testSteamId(897101);

let h: IntegrationHarness;
let ownerCookie: string;
let clanId: string;
let memberId: string;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
  ownerCookie = await loginAsOwner(h);
  clanId = uuidv7();
  await h.db.insert(clans).values({ id: clanId, name: 'Атомарный-клан', description: 'до' });
  const [member] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(897102),
      canonicalName: 'АтомарныйУчастник',
      canonicalNameNormalized: 'атомарныйучастник',
    })
    .returning({ id: players.id });
  memberId = member?.id as string;
  await h.db.insert(clanMembers).values([
    { clanId, playerId: h.seed.ownerPlayerId as string, memberRole: 'leader', hasPriority: false },
    { clanId, playerId: memberId, memberRole: 'member', hasPriority: false },
  ]);
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

describeIfDb('clan mutations are audited atomically (#133)', () => {
  it('rolls a clan update back when its audit row cannot be written', async () => {
    failingActions.add('clan.update');
    try {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/clans/${clanId}`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ description: 'после' }),
      });
      expect(res.statusCode).toBe(500);
    } finally {
      failingActions.clear();
    }
    const [row] = await h.db
      .select({ description: clans.description })
      .from(clans)
      .where(eq(clans.id, clanId));
    expect(row?.description).toBe('до');
  });

  it('rolls a member removal back when its audit row cannot be written', async () => {
    failingActions.add('clan.member.remove');
    try {
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/clans/${clanId}/members/${memberId}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      failingActions.clear();
    }
    const rows = await h.db
      .select({ playerId: clanMembers.playerId })
      .from(clanMembers)
      .where(eq(clanMembers.playerId, memberId));
    expect(rows).toHaveLength(1);
  });
});
