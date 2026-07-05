import type { DatabaseClient } from '@squad/db';
import { events, players, roles, servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const STEAM_RUN_BASE = 76561198100000000n + BigInt(Date.now() % 1_000_000_000);
const OWNER_STEAM_ID = STEAM_RUN_BASE + 1_000_000n;
let steamCounter = STEAM_RUN_BASE;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

async function seedRole(db: DatabaseClient, opts: { panelAccess?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `Role-${id.slice(0, 12)}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess ?? true,
  });
  return id;
}

async function seedPlayer(
  db: DatabaseClient,
  opts: { name?: string; roleId?: string | null; eosOnly?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  const name = opts.name ?? `Player-${id.slice(0, 8)}`;
  await db.insert(players).values({
    id,
    steamId64: opts.eosOnly ? null : nextSteam(),
    eosId: opts.eosOnly ? `eos-${id.slice(0, 12)}` : null,
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
    roleId: opts.roleId ?? null,
  });
  return id;
}

async function seedServer(db: DatabaseClient, name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(servers).values({
    id,
    displayName: name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${id}`,
  });
  return id;
}

interface SeedEventOpts {
  serverId: string | null;
  occurredAt: Date;
  kind?: string;
  actorKind?: string | null;
  actorId?: string | null;
  correlationId?: string | null;
  payload?: unknown;
}

async function seedEvent(db: DatabaseClient, opts: SeedEventOpts): Promise<string> {
  const id = uuidv7();
  await db.insert(events).values({
    eventId: id,
    serverId: opts.serverId,
    occurredAt: opts.occurredAt,
    kind: opts.kind ?? 'player.connected',
    version: 1,
    actorKind: opts.actorKind ?? null,
    actorId: opts.actorId ?? null,
    correlationId: opts.correlationId ?? null,
    payload: opts.payload ?? { name: 'Rifleman', steam_id64: '76561198000000000' },
  });
  return id;
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'events-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface EventDto {
  event_id: string;
  server_id: string | null;
  server_name: string | null;
  server_slug: string | null;
  occurred_at: string;
  kind: string;
  version: number;
  actor_kind: string | null;
  actor_id: string | null;
  actor_nickname: string | null;
  correlation_id: string | null;
}

interface ListResponse {
  items: EventDto[];
  next_cursor: string | null;
  limit: number;
}

interface EnvelopeResponse {
  event_id: string;
  version: number;
  type: string;
  server_id: string | null;
  ts: string;
  actor: { kind: string | null; id: string | null } | null;
  actor_nickname: string | null;
  correlation_id: string | null;
  payload: unknown;
}

// Occurred timestamps live inside bootstrapped monthly partitions (current + 5 months).
const BASE = new Date();
BASE.setUTCDate(2);
BASE.setUTCHours(10, 0, 0, 0);
function at(offsetMinutes: number): Date {
  return new Date(BASE.getTime() + offsetMinutes * 60_000);
}

describeIfDb('events API (EVT-2)', () => {
  let h: IntegrationHarness;
  let cookie: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    cookie = await loginAs(h, h.seed.ownerPlayerId!);
  });

  afterAll(async () => {
    await h.cleanup();
  });

  async function listEvents(qs: string): Promise<ListResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events${qs}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ListResponse;
  }

  async function paginateIds(qsBase: string, limit: number): Promise<string[]> {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await listEvents(`${qsBase}&limit=${limit}${cursorParam}`);
      collected.push(...page.items.map((event) => event.event_id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return collected;
  }

  it('rejects unauthenticated access with 401', async () => {
    for (const url of ['/api/v1/events', '/api/v1/events/count', `/api/v1/events/${uuidv7()}`]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects players without panel_access with 403', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const player = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, player);
    for (const url of ['/api/v1/events', '/api/v1/events/count', `/api/v1/events/${uuidv7()}`]) {
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie: deniedCookie } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('combines server, kind, player and date filters (AC)', async () => {
    const server = await seedServer(h.db, 'EvtFilterSrv');
    const otherServer = await seedServer(h.db, 'EvtOtherSrv');
    const rambo = await seedPlayer(h.db, { name: `Rambo-${uuidv7().slice(0, 6)}` });
    const ghost = await seedPlayer(h.db, { name: `Ghost-${uuidv7().slice(0, 6)}` });

    const target = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(10),
      kind: 'player.connected',
      actorKind: 'system',
      actorId: rambo,
    });
    await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(20),
      kind: 'player.disconnected',
      actorId: ghost,
    });
    await seedEvent(h.db, {
      serverId: otherServer,
      occurredAt: at(15),
      kind: 'player.connected',
      actorId: rambo,
    });
    await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(-1000),
      kind: 'player.connected',
      actorId: rambo,
    });

    const byServerKind = await listEvents(
      `?serverId=${server}&kind=player.connected&dateFrom=${encodeURIComponent(at(0).toISOString())}`,
    );
    expect(byServerKind.items.map((event) => event.event_id)).toEqual([target]);
    expect(byServerKind.items[0]?.actor_nickname).toContain('Rambo');
    expect(byServerKind.items[0]?.server_name).toBe('EvtFilterSrv');

    const byPlayer = await listEvents(
      `?serverId=${server}&playerId=${rambo}&dateFrom=${encodeURIComponent(at(0).toISOString())}&dateTo=${encodeURIComponent(at(1000).toISOString())}`,
    );
    expect(byPlayer.items.map((event) => event.event_id)).toEqual([target]);

    const combined = await listEvents(
      `?serverId=${server}&kind=player.connected&playerId=${rambo}&dateFrom=${encodeURIComponent(at(0).toISOString())}&dateTo=${encodeURIComponent(at(1000).toISOString())}`,
    );
    expect(combined.items.map((event) => event.event_id)).toEqual([target]);
  });

  it('accepts multiple kind values (multi-select)', async () => {
    const server = await seedServer(h.db, 'EvtMultiKindSrv');
    const connected = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(30),
      kind: 'player.connected',
    });
    const ended = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(31),
      kind: 'match.ended',
    });
    await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(32),
      kind: 'rcon.players_polled',
    });

    const filtered = await listEvents(`?serverId=${server}&kind=player.connected&kind=match.ended`);
    expect(new Set(filtered.items.map((event) => event.event_id))).toEqual(
      new Set([connected, ended]),
    );
  });

  it('searches player by nickname, including EOS-only players', async () => {
    const server = await seedServer(h.db, 'EvtNickSrv');
    const uniqueNick = `Xenon-${uuidv7().slice(0, 8)}`;
    const eosPlayer = await seedPlayer(h.db, { name: uniqueNick, eosOnly: true });
    const decoy = await seedPlayer(h.db, { name: `Decoy-${uuidv7().slice(0, 6)}` });

    const wanted = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(40),
      actorId: eosPlayer,
    });
    await seedEvent(h.db, { serverId: server, occurredAt: at(41), actorId: decoy });

    const found = await listEvents(`?serverId=${server}&playerQuery=${uniqueNick.slice(0, 6)}`);
    expect(found.items.map((event) => event.event_id)).toEqual([wanted]);
    expect(found.items[0]?.actor_nickname).toBe(uniqueNick);

    const none = await listEvents(`?serverId=${server}&playerQuery=zzz-no-such-nick`);
    expect(none.items).toEqual([]);
  });

  it('sorts by occurred_at in both directions', async () => {
    const server = await seedServer(h.db, 'EvtSortSrv');
    const early = await seedEvent(h.db, { serverId: server, occurredAt: at(50) });
    const mid = await seedEvent(h.db, { serverId: server, occurredAt: at(51) });
    const late = await seedEvent(h.db, { serverId: server, occurredAt: at(52) });

    const desc = await listEvents(`?serverId=${server}&order=desc`);
    expect(desc.items.map((event) => event.event_id)).toEqual([late, mid, early]);

    const asc = await listEvents(`?serverId=${server}&order=asc`);
    expect(asc.items.map((event) => event.event_id)).toEqual([early, mid, late]);
  });

  it('keyset paginates together with a filter and sort (AC)', async () => {
    const server = await seedServer(h.db, 'EvtPageSrv');
    const ascending: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const id = await seedEvent(h.db, {
        serverId: server,
        occurredAt: at(60 + index),
        kind: 'player.connected',
      });
      ascending.push(id);
    }
    await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(70),
      kind: 'match.ended',
    });

    const paged = await paginateIds(`?serverId=${server}&kind=player.connected&order=asc`, 2);
    expect(paged).toEqual(ascending);
    expect(new Set(paged).size).toBe(ascending.length);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/events?cursor=not-a-real-cursor',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_cursor' });
  });

  it('counts events honoring filters', async () => {
    const server = await seedServer(h.db, 'EvtCountSrv');
    await seedEvent(h.db, { serverId: server, occurredAt: at(80), kind: 'player.connected' });
    await seedEvent(h.db, { serverId: server, occurredAt: at(81), kind: 'match.started' });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events/count?serverId=${server}&kind=player.connected`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1 });
  });

  it('returns the raw envelope with payload (AC)', async () => {
    const server = await seedServer(h.db, 'EvtEnvSrv');
    const actor = await seedPlayer(h.db, { name: `Cap-${uuidv7().slice(0, 6)}` });
    const correlationId = uuidv7();
    const payload = { steam_id64: '76561198000000123', eos_id: null, name: 'Medic', ip: null };
    const eventId = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(90),
      kind: 'player.connected',
      actorKind: 'system',
      actorId: actor,
      correlationId,
      payload,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events/${eventId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const envelope = res.json() as EnvelopeResponse;
    expect(envelope.event_id).toBe(eventId);
    expect(envelope.type).toBe('player.connected');
    expect(envelope.server_id).toBe(server);
    expect(envelope.actor).toMatchObject({ kind: 'system', id: actor });
    expect(envelope.actor_nickname).toContain('Cap');
    expect(envelope.correlation_id).toBe(correlationId);
    expect(envelope.payload).toEqual(payload);
  });

  it('returns 404 for an unknown event id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events/${uuidv7()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'event_not_found' });
  });

  it('exports filtered events as CSV (P1)', async () => {
    const server = await seedServer(h.db, 'EvtCsvSrv');
    const withComma = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(100),
      kind: 'player.connected',
      payload: { name: 'Comma, Man', steam_id64: '76561198000000999' },
    });
    await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(101),
      kind: 'match.started',
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events/export?serverId=${server}&kind=player.connected`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const body = res.body;
    const lines = body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'event_id,server_id,server_name,occurred_at,kind,version,actor_kind,actor_id,actor_nickname,correlation_id,payload',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(withComma);
    expect(body).toContain('"Comma, Man"');
  });
});
