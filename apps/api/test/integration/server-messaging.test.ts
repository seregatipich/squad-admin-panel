import { chatMessages, players, roleSquadPermissions, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import type { WorkerRconCommandOutcome } from '../../src/lib/rcon-worker-command.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './harness.js';

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = testSteamId(186000);
const SERVER_ID = '019e2000-0000-7000-8000-000000000001';

let h: IntegrationHarness;

function okOutcome(overrides: Partial<WorkerRconCommandOutcome> = {}): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'req-test',
    response: 'ok',
    via: 'worker-rcon',
    ...overrides,
  } as WorkerRconCommandOutcome;
}

function notConnectedOutcome(): WorkerRconCommandOutcome {
  return { attempted: false, reason: 'worker_not_connected' };
}

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
  await h.db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Messaging Test Server',
    slug: 'messaging-test-server',
  });
  vi.mocked(sendRconCommandViaWorker).mockReset();
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function asRoleWithSquadPermissions(keys: string[]): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `Messaging-${keys.join('-') || 'none'}-${roleId}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: true,
    });
    for (const key of keys) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded above
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

function storedRoster(serverId: string, playerEntries: Array<Record<string, unknown>>) {
  return JSON.stringify({
    server_id: serverId,
    polled_at: '2026-07-09T10:00:00.000Z',
    players: playerEntries,
  });
}

function rosterEntry(overrides: Record<string, unknown>) {
  return {
    rcon_id: 0,
    eos_id: 'eos-000000000000000000000000000001',
    steam_id64: '76561198000000001',
    name: 'Player',
    team_id: 1,
    squad_id: 1,
    is_leader: false,
    role: null,
    first_seen_at: '2026-07-09T09:55:00.000Z',
    ...overrides,
  };
}

describeIfDb('POST /api/v1/servers/:serverId/broadcast', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/broadcast`,
      payload: { message: 'hello there' },
    });
    expect(resp.statusCode).toBe(401);
  });

  it('403s without the chat squad permission', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/broadcast`,
      headers: { cookie },
      payload: { message: 'hello there' },
    });
    expect(resp.statusCode).toBe(403);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('rejects a message shorter than 2 characters', async () => {
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/broadcast`,
      headers: { cookie },
      payload: { message: 'a' },
    });
    expect(resp.statusCode).toBe(400);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('enqueues AdminBroadcast, writes chat_messages and an audit entry on success', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(
      okOutcome({ response: 'Broadcast sent' }),
    );
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/broadcast`,
      headers: { cookie },
      payload: { message: 'Server restarting soon' },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({ ok: true, response: 'Broadcast sent' });

    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: SERVER_ID,
        command: 'AdminBroadcast',
        args: ['Server restarting soon'],
      }),
    );

    const rows = await h.db.select().from(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('broadcast');
    expect(rows[0]?.source).toBe('panel');
    expect(rows[0]?.message).toBe('Server restarting soon');
    // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
    expect(rows[0]?.playerId).toBe(h.seed.ownerPlayerId!);

    const audit = await assertAuditRow(h, {
      action: 'server.broadcast',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(audit.afterSnapshot).toMatchObject({ message: 'Server restarting soon' });
  });

  it('502s and writes no chat_messages row when the worker is not connected', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(notConnectedOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/broadcast`,
      headers: { cookie },
      payload: { message: 'Server restarting soon' },
    });
    expect(resp.statusCode).toBe(502);

    const rows = await h.db.select().from(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
    expect(rows).toHaveLength(0);
  });
});

describeIfDb('POST /api/v1/servers/:serverId/squads/:squadId/message', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/squads/2/message?team_id=1`,
      payload: { message: 'move up' },
    });
    expect(resp.statusCode).toBe(401);
  });

  it('403s without the chat squad permission', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/squads/2/message?team_id=1`,
      headers: { cookie },
      payload: { message: 'move up' },
    });
    expect(resp.statusCode).toBe(403);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('rejects a message shorter than 2 characters', async () => {
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/squads/2/message?team_id=1`,
      headers: { cookie },
      payload: { message: 'x' },
    });
    expect(resp.statusCode).toBe(400);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('warns only current members of the matching (team, squad) pair, and lists recipients in the audit entry', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);

    await h.redis.set(
      `rcon:roster:${SERVER_ID}`,
      storedRoster(SERVER_ID, [
        rosterEntry({
          rcon_id: 0,
          eos_id: 'eos-a1',
          steam_id64: '76561198000000101',
          name: 'Alpha',
          team_id: 1,
          squad_id: 2,
        }),
        rosterEntry({
          rcon_id: 1,
          eos_id: 'eos-a2',
          steam_id64: '76561198000000102',
          name: 'Bravo',
          team_id: 1,
          squad_id: 2,
        }),
        // Same squad_id, different team — must NOT receive a warning.
        rosterEntry({
          rcon_id: 2,
          eos_id: 'eos-a3',
          steam_id64: '76561198000000103',
          name: 'Charlie',
          team_id: 2,
          squad_id: 2,
        }),
        // Different squad in the target team — must NOT receive a warning.
        rosterEntry({
          rcon_id: 3,
          eos_id: 'eos-a4',
          steam_id64: '76561198000000104',
          name: 'Delta',
          team_id: 1,
          squad_id: 3,
        }),
      ]),
    );

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/squads/2/message?team_id=1`,
      headers: { cookie },
      payload: { message: 'Push the flag now' },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ recipients: Array<{ target: string; name: string; ok: boolean }> }>();
    expect(body.recipients).toHaveLength(2);
    expect(body.recipients.map((r) => r.name).sort()).toEqual(['Alpha', 'Bravo']);

    const calls = vi.mocked(sendRconCommandViaWorker).mock.calls;
    const warnCalls = calls.filter(([, opts]) => opts.command === 'AdminWarn');
    expect(warnCalls).toHaveLength(2);
    for (const [, opts] of warnCalls) {
      expect(opts.args).toEqual([expect.stringMatching(/^eos-a[12]$/), 'Push the flag now']);
    }

    const audit = await assertAuditRow(h, {
      action: 'server.squad_message',
      resource: 'server',
      targetId: SERVER_ID,
    });
    const after = audit.afterSnapshot as {
      squad_id: number;
      team_id: number;
      recipients: Array<{ name: string }>;
    };
    expect(after.squad_id).toBe(2);
    expect(after.team_id).toBe(1);
    expect(after.recipients.map((r) => r.name).sort()).toEqual(['Alpha', 'Bravo']);
  });

  it('recomputes the member set on every call instead of caching the roster', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);

    await h.redis.set(
      `rcon:roster:${SERVER_ID}`,
      storedRoster(SERVER_ID, [
        rosterEntry({ eos_id: 'eos-b1', name: 'First', team_id: 1, squad_id: 4 }),
      ]),
    );
    const first = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/squads/4/message?team_id=1`,
      headers: { cookie },
      payload: { message: 'first wave' },
    });
    expect(first.statusCode).toBe(200);
    expect(
      first.json<{ recipients: Array<{ name: string }> }>().recipients.map((r) => r.name),
    ).toEqual(['First']);

    // Roster changes between requests: First left, Second joined the squad.
    await h.redis.set(
      `rcon:roster:${SERVER_ID}`,
      storedRoster(SERVER_ID, [
        rosterEntry({ eos_id: 'eos-b2', name: 'Second', team_id: 1, squad_id: 4 }),
      ]),
    );
    const second = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/squads/4/message?team_id=1`,
      headers: { cookie },
      payload: { message: 'second wave' },
    });
    expect(second.statusCode).toBe(200);
    expect(
      second.json<{ recipients: Array<{ name: string }> }>().recipients.map((r) => r.name),
    ).toEqual(['Second']);
  });

  it('returns an empty recipient list and still audits when the squad is empty', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);
    await h.redis.set(`rcon:roster:${SERVER_ID}`, storedRoster(SERVER_ID, []));

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/squads/9/message?team_id=1`,
      headers: { cookie },
      payload: { message: 'anyone there?' },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({ recipients: [] });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });
});

describeIfDb('POST /api/v1/servers/:serverId/players/:playerId/message', () => {
  const TARGET_EOS_ID = 'eos-msg2-target-000000000000001';
  const UNKNOWN_PLAYER_ID = '019e2000-0000-7000-8000-0000000009ff';

  let targetPlayerId: string;
  let unaddressablePlayerId: string;

  beforeEach(async () => {
    const [target] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(185001),
        canonicalName: 'DirectTarget',
        canonicalNameNormalized: 'directtarget',
        eosId: TARGET_EOS_ID,
      })
      .returning({ id: players.id });
    const [unaddressable] = await h.db
      .insert(players)
      .values({
        steamId64: null,
        canonicalName: 'NoIdsTarget',
        canonicalNameNormalized: 'noidstarget',
        eosId: null,
      })
      .returning({ id: players.id });
    // biome-ignore lint/style/noNonNullAssertion: inserts above always return a row
    targetPlayerId = target!.id;
    // biome-ignore lint/style/noNonNullAssertion: inserts above always return a row
    unaddressablePlayerId = unaddressable!.id;
  });

  it('rejects an unauthenticated direct message', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      payload: { message: 'stop teamkilling' },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json()).toMatchObject({ error: 'unauthenticated' });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('403s without the chat squad permission on the direct-message route', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      headers: { cookie },
      payload: { message: 'stop teamkilling' },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json()).toMatchObject({
      error: 'forbidden',
      required_squad_permission: 'chat',
    });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('404s for an unknown player id', async () => {
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${UNKNOWN_PLAYER_ID}/message`,
      headers: { cookie },
      payload: { message: 'stop teamkilling' },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json()).toMatchObject({ error: 'player_not_found' });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('404s when the target player has no eos id and no steam id', async () => {
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${unaddressablePlayerId}/message`,
      headers: { cookie },
      payload: { message: 'stop teamkilling' },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json()).toMatchObject({ error: 'player_not_addressable' });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('rejects a message longer than 300 characters', async () => {
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      headers: { cookie },
      payload: { message: 'x'.repeat(301) },
    });
    expect(resp.statusCode).toBe(400);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('enqueues AdminWarn addressed to the target player', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome({ response: 'Warned' }));
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      headers: { cookie },
      payload: { message: 'stop teamkilling' },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({
      ok: true,
      request_id: 'req-test',
      response: 'Warned',
    });

    expect(sendRconCommandViaWorker).toHaveBeenCalledTimes(1);
    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: SERVER_ID,
        command: 'AdminWarn',
        args: [TARGET_EOS_ID, 'stop teamkilling'],
      }),
    );
  });

  it('audits the direct message with the addressee and the text', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      headers: { cookie },
      payload: { message: 'last warning', log_to_card: true },
    });
    expect(resp.statusCode).toBe(200);

    const audit = await assertAuditRow(h, {
      action: 'server.player_message',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(audit.afterSnapshot).toMatchObject({
      player_id: targetPlayerId,
      target: TARGET_EOS_ID,
      message: 'last warning',
      log_to_card: true,
    });
  });

  it('log_to_card writes a direct chat_messages row visible on the target card', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      headers: { cookie },
      payload: { message: 'behave please', log_to_card: true },
    });
    expect(resp.statusCode).toBe(200);

    const rows = await h.db.select().from(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playerId).toBe(targetPlayerId);
    expect(rows[0]?.scope).toBe('direct');
    expect(rows[0]?.source).toBe('panel');
    expect(rows[0]?.message).toBe('behave please');

    // The card's «Чат» section reads exactly this route, filtered by the addressee.
    const listed = await h.app.inject({
      method: 'GET',
      url: `/api/v1/chat/messages?playerId=${targetPlayerId}&scope=direct`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{
      items: Array<{ message: string; source: string; scope: string; player: { id: string } }>;
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.message).toBe('behave please');
    expect(body.items[0]?.source).toBe('panel');
    expect(body.items[0]?.scope).toBe('direct');
    expect(body.items[0]?.player.id).toBe(targetPlayerId);
  });

  it('writes no chat_messages row when log_to_card is omitted', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      headers: { cookie },
      payload: { message: 'silent nudge' },
    });
    expect(resp.statusCode).toBe(200);

    const rows = await h.db.select().from(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
    expect(rows).toHaveLength(0);
  });

  it('502s and writes no chat row when the worker is not connected', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(notConnectedOutcome());
    const cookie = await asRoleWithSquadPermissions(['chat']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/players/${targetPlayerId}/message`,
      headers: { cookie },
      payload: { message: 'you there?', log_to_card: true },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({
      error: 'message_failed',
      reason: 'worker_not_connected',
    });

    const rows = await h.db.select().from(chatMessages).where(eq(chatMessages.serverId, SERVER_ID));
    expect(rows).toHaveLength(0);
  });
});
