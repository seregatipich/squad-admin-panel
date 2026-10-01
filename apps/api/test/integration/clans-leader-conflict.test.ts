import { clanMembers, clans, players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

/**
 * #29 (follow-up D of #14): a check_violation (23514) raised by the deferred
 * clan_members_single_leader trigger while adding a member is answered with a
 * 409 leader_conflict, not a 500. No HTTP input can reach the trigger (the
 * body forbids member_role 'leader'), so the violation is injected at the
 * audit write that runs inside the same transaction, wrapped the way
 * drizzle wraps driver errors (code on `cause`).
 */
let injectCheckViolation = false;

vi.mock('../../src/lib/audit.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/audit.js')>();
  return {
    ...original,
    writeAuditEntry: vi.fn(async (...args: Parameters<typeof original.writeAuditEntry>) => {
      if (injectCheckViolation && args[1].actionType === 'clan.member.add') {
        throw new Error('Failed query', { cause: { code: '23514' } });
      }
      return original.writeAuditEntry(...args);
    }),
  };
});

const OWNER_STEAM = testSteamId(897201);

let h: IntegrationHarness;
let ownerCookie: string;
let clanId: string;
let candidateId: string;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
  ownerCookie = await loginAsOwner(h);
  clanId = uuidv7();
  await h.db.insert(clans).values({ id: clanId, name: 'Конфликт-лидера', description: 'x' });
  const [candidate] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(897202),
      canonicalName: 'КандидатВКлан',
      canonicalNameNormalized: 'кандидатвклан',
    })
    .returning({ id: players.id });
  candidateId = candidate?.id as string;
  await h.db.insert(clanMembers).values({
    clanId,
    playerId: h.seed.ownerPlayerId as string,
    memberRole: 'leader',
    hasPriority: false,
  });
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

describeIfDb('clan add-member leader conflict (#29)', () => {
  it('maps a single_leader check_violation to 409 leader_conflict and adds nobody', async () => {
    injectCheckViolation = true;
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/clans/${clanId}/members`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ player_id: candidateId }),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'leader_conflict' });
    } finally {
      injectCheckViolation = false;
    }
    const rows = await h.db
      .select({ playerId: clanMembers.playerId })
      .from(clanMembers)
      .where(eq(clanMembers.playerId, candidateId));
    expect(rows).toHaveLength(0);
  });
});
