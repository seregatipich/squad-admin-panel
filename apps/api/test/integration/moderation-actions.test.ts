import { moderationActions, players } from '@squad/db/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000000991n;

let h: IntegrationHarness;
let playerId: string;
let authorId: string;

afterEach(async () => {
  if (h) await h.cleanup();
});

async function seedPlayer(steamId: bigint, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: steamId,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      eosId: `eos-${name.toLowerCase()}`,
    })
    .returning({ id: players.id });
  return row.id;
}

describe('GET /api/v1/players/:playerId/moderation-actions', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
    });
    playerId = await seedPlayer(76561198000000123n, 'TargetPlayer');
    authorId = await seedPlayer(76561198000000124n, 'ModeratorPlayer');
    await h.db.insert(moderationActions).values([
      {
        playerId,
        actionType: 'name_kick',
        authorSystemLabel: 'banname-worker',
        reason: 'Banned nickname rule matched',
        context: { rule_id: 'rule-1' },
        createdAt: new Date('2026-06-01T10:00:00Z'),
      },
      {
        playerId,
        actionType: 'warn',
        authorPlayerId: authorId,
        reason: 'Please stop teamkilling',
        createdAt: new Date('2026-06-02T10:00:00Z'),
      },
    ]);
  });

  it('returns moderation actions newest-first with resolved author', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/moderation-actions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      actions: Array<{
        action_type: string;
        reason: string | null;
        context: Record<string, unknown>;
        author:
          | { kind: 'player'; id: string; name: string | null }
          | { kind: 'system'; label: string | null };
      }>;
    };
    expect(body.actions).toHaveLength(2);
    expect(body.actions[0]).toMatchObject({
      action_type: 'warn',
      author: { kind: 'player', id: authorId, name: 'ModeratorPlayer' },
    });
    expect(body.actions[1]).toMatchObject({
      action_type: 'name_kick',
      reason: 'Banned nickname rule matched',
      author: { kind: 'system', label: 'banname-worker' },
    });
    expect(body.actions[1].context).toMatchObject({ rule_id: 'rule-1' });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/moderation-actions`,
    });
    expect(res.statusCode).toBe(401);
  });
});
