import { players } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = 76561198000000998n;
const LINKED_EOS = 'aaaa0123456789abcdef0123456789ab';
const LINKED_STEAM = '76561198012345678';
const EOS_ONLY = 'bbbb0123456789abcdef0123456789ab';
const UNKNOWN_EOS = 'cccc0123456789abcdef0123456789ab';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function seedRosterPlayers(): Promise<{ linkedId: string; eosOnlyId: string }> {
  const linked = await h.db
    .insert(players)
    .values({
      steamId64: BigInt(LINKED_STEAM),
      eosId: LINKED_EOS,
      canonicalName: 'LinkedPlayer',
      canonicalNameNormalized: 'linkedplayer',
    })
    .returning({ id: players.id });
  const eosOnly = await h.db
    .insert(players)
    .values({
      steamId64: null,
      eosId: EOS_ONLY,
      canonicalName: 'EpicOnly',
      canonicalNameNormalized: 'epiconly',
    })
    .returning({ id: players.id });
  return { linkedId: linked[0]?.id as string, eosOnlyId: eosOnly[0]?.id as string };
}

function storedRoster(serverId: string) {
  return JSON.stringify({
    server_id: serverId,
    polled_at: '2026-07-05T10:00:00.000Z',
    players: [
      {
        rcon_id: 0,
        eos_id: LINKED_EOS,
        steam_id64: LINKED_STEAM,
        name: 'LinkedPlayer',
        team_id: 1,
        squad_id: 2,
        is_leader: true,
        role: 'USA_Rifleman_01',
        first_seen_at: '2026-07-05T09:45:00.000Z',
      },
      {
        rcon_id: 1,
        eos_id: EOS_ONLY,
        steam_id64: null,
        name: 'EpicOnly',
        team_id: 2,
        squad_id: null,
        is_leader: false,
        role: 'RGF_Rifleman_01',
        first_seen_at: '2026-07-05T09:50:00.000Z',
      },
      {
        rcon_id: 2,
        eos_id: UNKNOWN_EOS,
        steam_id64: '76561198099999999',
        name: 'Stranger',
        team_id: 1,
        squad_id: 1,
        is_leader: false,
        role: 'USA_Medic_01',
        first_seen_at: '2026-07-05T09:55:00.000Z',
      },
    ],
  });
}

describeIfDb('GET /api/v1/servers/:id/roster', () => {
  it('returns an empty roster when no RCON poll has run', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/roster`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ polled_at: null, players: [] });
  });

  it('resolves player_id for known players and keeps EOS-only entries', async () => {
    const cookie = await loginAsOwner(h);
    const { linkedId, eosOnlyId } = await seedRosterPlayers();
    const serverId = uuidv7();
    await h.redis.set(`rcon:roster:${serverId}`, storedRoster(serverId));

    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/roster`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      polled_at: string;
      players: Array<{
        player_id: string | null;
        eos_id: string;
        steam_id64: string | null;
        name: string;
      }>;
    }>();

    expect(body.polled_at).toBe('2026-07-05T10:00:00.000Z');
    expect(body.players).toHaveLength(3);

    const linked = body.players[0];
    expect(linked?.player_id).toBe(linkedId);
    expect(linked?.steam_id64).toBe(LINKED_STEAM);

    const eosOnly = body.players[1];
    expect(eosOnly?.player_id).toBe(eosOnlyId);
    expect(eosOnly?.steam_id64).toBeNull();
    expect(eosOnly?.name).toBe('EpicOnly');

    const stranger = body.players[2];
    expect(stranger?.player_id).toBeNull();
  });

  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/roster`,
    });
    expect(resp.statusCode).toBe(401);
  });
});
