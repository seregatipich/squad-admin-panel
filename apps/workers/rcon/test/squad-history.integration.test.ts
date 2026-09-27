/**
 * Squad history end to end: a fake Squad server whose roster the test
 * rewrites, a real supervisor, and real Redis and Postgres. It proves the
 * tracker is wired into the roster refresh (events land in `events` and the
 * server stream, crowns land in `rcon:squad-crowns:{id}`) and that the
 * no-false-event rules hold across a worker restart and a round end.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { events, servers } from '@squad/db/schema';
import {
  type EventEnvelope,
  eventEnvelope,
  STREAM_NAME,
  squadCrownsKey,
  validatePayload,
} from '@squad/shared-types';
import { and, asc, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_CHAT_VALUE,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';
import { RconSupervisor, type Target } from '../src/supervisor.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const describeIfInfra = DATABASE_URL && REDIS_URL ? describe : describe.skip;

interface GamePlayer {
  eos: string;
  steam: string;
  name: string;
  team: number;
  squad: number | null;
  leader: boolean;
}

interface GameSquad {
  team: number;
  id: number;
  name: string;
  creator: GamePlayer;
}

function gamePlayer(name: string, squad: number | null, leader = false): GamePlayer {
  const steamTail = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return {
    eos: randomBytes(16).toString('hex'),
    steam: `7656119${steamTail}`,
    name,
    team: 1,
    squad,
    leader,
  };
}

const game: { players: GamePlayer[]; squads: GameSquad[] } = { players: [], squads: [] };
const commands: string[] = [];
const sockets: Socket[] = [];

function listPlayers(): string {
  return [
    '----- Active Players -----',
    ...game.players.map(
      (p, i) =>
        `ID: ${i} | Online IDs: EOS: ${p.eos} steam: ${p.steam} | Name: ${p.name} | Team ID: ${p.team} | Squad ID: ${p.squad ?? 'N/A'} | Is Leader: ${p.leader ? 'True' : 'False'} | Role: USA_Rifleman_01`,
    ),
    '----- Recently Disconnected Players [Max of 15] -----',
  ].join('\n');
}

function listSquads(): string {
  const lines: string[] = [];
  const teams = [
    [1, 'United States Army'],
    [2, 'Russian Ground Forces'],
  ] as const;
  for (const [team, teamName] of teams) {
    lines.push(`Team ID: ${team} (${teamName})`);
    for (const s of game.squads.filter((squad) => squad.team === team)) {
      lines.push(
        `ID: ${s.id} | Name: ${s.name} | Size: 1 | Locked: False | Creator Name: ${s.creator.name} | Creator Online IDs: EOS: ${s.creator.eos} steam: ${s.creator.steam}`,
      );
    }
  }
  return lines.join('\n');
}

function startGameServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      const stream = new RconPacketStream();
      const reply = (id: number, body: string, type = SERVERDATA_RESPONSE_VALUE) => {
        if (!sock.destroyed) sock.write(encodePacket({ id, type, body }));
      };
      sock.on('error', () => undefined);
      sock.on('data', (chunk) => {
        for (const packet of stream.push(chunk)) {
          if (packet.type === SERVERDATA_AUTH) {
            reply(packet.id, '');
            reply(packet.id, '', SERVERDATA_AUTH_RESPONSE);
            sockets.push(sock);
            continue;
          }
          if (packet.type !== SERVERDATA_EXECCOMMAND) continue;
          if (packet.body !== '') commands.push(packet.body);
          if (packet.body === 'ListPlayers') reply(packet.id, listPlayers());
          else if (packet.body === 'ListSquads') reply(packet.id, listSquads());
          else reply(packet.id, '');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function broadcast(body: string): void {
  for (const sock of sockets) {
    if (!sock.destroyed) sock.write(encodePacket({ id: 0, type: SERVERDATA_CHAT_VALUE, body }));
  }
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

const count = (command: string) => commands.filter((c) => c === command).length;

async function waitFor(probe: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;
let redis: Redis;
let server: Server;
let target: Target;
let supervisor: RconSupervisor;
const serverId = randomUUID();

const anna = gamePlayer('Anna', 1, true);
const boris = gamePlayer('Boris', 1);
const clara = gamePlayer('Clara', 2, true);
const dana = gamePlayer('Dana', 1, true);

/**
 * Starts a supervisor and waits until its connect-time refresh finished: the
 * worker reads server info only after the roster (and squad tracking) is done.
 */
async function connect(): Promise<void> {
  const before = count('ShowServerInfo');
  supervisor = new RconSupervisor({
    db,
    redis,
    log: makeLogger(),
    pollIntervalMs: 600_000,
    rosterIntervalMs: 600_000,
    infoIntervalMs: 600_000,
    hintDebounceMs: 5,
    hintFollowUpMs: 600_000,
  });
  await supervisor.reconcile([target]);
  await waitFor(() => count('ShowServerInfo') > before);
}

/** One hinted roster refresh, finished (tracking included) when server info is read. */
async function refresh(reason?: string): Promise<void> {
  const before = count('ShowServerInfo');
  expect(supervisor.hint(serverId, ['roster', 'info'], reason)).toBe(true);
  await waitFor(() => count('ShowServerInfo') > before);
}

function squadEvents() {
  return db
    .select()
    .from(events)
    .where(and(eq(events.serverId, serverId), like(events.kind, 'squad.%')))
    .orderBy(asc(events.occurredAt));
}

async function crown(eosId: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.hget(squadCrownsKey(serverId), eosId);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  sql = postgres(DATABASE_URL, { max: 4, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await db.insert(servers).values({
    id: serverId,
    displayName: 'Squad History Test Server',
    slug: `squad-history-${randomBytes(4).toString('hex')}`,
  });
  const started = await startGameServer();
  server = started.server;
  target = {
    serverId,
    host: '127.0.0.1',
    port: started.port,
    queryPort: started.port + 1000,
    password: 'pw',
  };
});

afterAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  await supervisor?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await redis.del(
    `rcon:status:${serverId}`,
    `rcon:roster:${serverId}`,
    `rcon:squads:${serverId}`,
    `rcon:commands:${serverId}`,
    squadCrownsKey(serverId),
    STREAM_NAME.eventsServer(serverId),
  );
  await db.delete(servers).where(eq(servers.id, serverId));
  await redis.quit();
  await sql.end();
});

describeIfInfra('squad history through the RCON supervisor', () => {
  it('records the first roster as a baseline without events', async () => {
    game.players = [anna, boris];
    game.squads = [{ team: 1, id: 1, name: 'Alpha', creator: anna }];
    await connect();
    expect(await squadEvents()).toEqual([]);
  });

  it('records a handoff to a squadmate and gives the creator a grey crown', async () => {
    anna.leader = false;
    boris.leader = true;
    await refresh();

    const rows = await squadEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'squad.leader_changed',
      actorKind: 'player',
      actorId: anna.eos,
      payload: {
        squad_name: 'Alpha',
        reason: 'passed',
        from: { eos_id: anna.eos },
        to: { eos_id: boris.eos },
      },
    });
    expect(await crown(anna.eos)).toMatchObject({
      color: 'grey',
      squads: [{ squad_name: 'Alpha', handoffs: [{ to_name: 'Boris', reason: 'passed' }] }],
    });
    expect(await redis.ttl(squadCrownsKey(serverId))).toBeGreaterThan(0);
  });

  it('dates a new squad by its RCON creation broadcast', async () => {
    broadcast(
      `Clara (Online IDs: EOS: ${clara.eos} steam: ${clara.steam}) has created Squad 2 (Squad Name: Bravo) on United States Army`,
    );
    await sleep(200);
    const hintedAt = new Date();
    game.players.push(clara);
    game.squads.push({ team: 1, id: 2, name: 'Bravo', creator: clara });
    await refresh();

    const created = (await squadEvents()).find((row) => row.kind === 'squad.created');
    expect(created).toMatchObject({
      actorId: clara.eos,
      payload: {
        squad_name: 'Bravo',
        squad_id: 2,
        creator: { eos_id: clara.eos, steam_id64: clara.steam },
      },
    });
    expect(created?.occurredAt.getTime()).toBeLessThan(hintedAt.getTime());
    expect(await crown(clara.eos)).toBeNull();
  });

  it('turns the crown red when the creator disconnects while leading and the squad disbands', async () => {
    game.players = game.players.filter((p) => p !== clara);
    game.squads = game.squads.filter((s) => s.creator !== clara);
    await refresh();

    const disband = (await squadEvents()).find((row) => row.kind === 'squad.disbanded');
    expect(disband).toMatchObject({
      actorId: clara.eos,
      payload: { creator_was_leader: true, last_leader: { eos_id: clara.eos } },
    });
    const claraCrown = await crown(clara.eos);
    expect(claraCrown?.color).toBe('red');
    expect(claraCrown).toMatchObject({
      squads: [{ disbanded_at: expect.any(String), abandoned_at: expect.any(String) }],
    });
  });

  it('publishes envelopes every stream consumer accepts', async () => {
    const entries = (await redis.xrange(STREAM_NAME.eventsServer(serverId), '-', '+')) as Array<
      [string, string[]]
    >;
    const envelopes = entries
      .map(
        ([, fields]) =>
          JSON.parse(fields[fields.indexOf('envelope') + 1] ?? 'null') as EventEnvelope,
      )
      .filter((envelope) => envelope.type.startsWith('squad.'));
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      'squad.leader_changed',
      'squad.created',
      'squad.disbanded',
    ]);
    for (const envelope of envelopes) {
      expect(eventEnvelope.safeParse(envelope).success).toBe(true);
      expect(validatePayload(envelope.type, envelope.payload)).toMatchObject({ ok: true });
    }
  });

  it('starts from a baseline after a restart and extends the restored crowns', async () => {
    await supervisor.stop();
    const before = (await squadEvents()).length;
    await connect();
    expect(await squadEvents()).toHaveLength(before);

    boris.leader = false;
    anna.leader = true;
    await refresh();
    game.players = game.players.filter((p) => p !== anna);
    boris.leader = true;
    await refresh();

    const last = (await squadEvents()).at(-1);
    expect(last).toMatchObject({
      kind: 'squad.leader_changed',
      actorId: anna.eos,
      payload: { reason: 'disconnected' },
    });
    const annaCrown = (await crown(anna.eos)) as {
      color: string;
      squads: Array<{ handoffs: Array<{ reason: string }> }>;
    } | null;
    expect(annaCrown?.color).toBe('red');
    expect(annaCrown?.squads[0]?.handoffs.map((h) => h.reason)).toEqual(['passed', 'disconnected']);
  });

  it("clears crowns at round end and reports no disbands when the old map's squads vanish", async () => {
    await refresh('match.ended');
    expect(await redis.exists(squadCrownsKey(serverId))).toBe(0);
    const disbands = async () =>
      (await squadEvents()).filter((row) => row.kind === 'squad.disbanded').length;
    const disbandsBefore = await disbands();

    game.squads = [];
    for (const p of game.players) {
      p.squad = null;
      p.leader = false;
    }
    await refresh();
    expect(await disbands()).toBe(disbandsBefore);

    game.players.push(dana);
    game.squads.push({ team: 1, id: 1, name: 'Charlie', creator: dana });
    await refresh();
    expect(
      (await squadEvents()).some((row) => row.kind === 'squad.created' && row.actorId === dana.eos),
    ).toBe(true);
  });

  it('clears crowns at match start and takes the squads it finds as a baseline', async () => {
    const erik = gamePlayer('Erik', 1);
    game.players.push(erik);
    await refresh();
    dana.leader = false;
    erik.leader = true;
    await refresh();
    expect((await crown(dana.eos))?.color).toBe('grey');

    const felix = gamePlayer('Felix', 2, true);
    game.players.push(felix);
    game.squads.push({ team: 1, id: 2, name: 'Echo', creator: felix });
    const eventsBefore = (await squadEvents()).length;
    await refresh('match.started');
    expect(await redis.exists(squadCrownsKey(serverId))).toBe(0);
    expect(await squadEvents()).toHaveLength(eventsBefore);

    const gleb = gamePlayer('Gleb', 3, true);
    game.players.push(gleb);
    game.squads.push({ team: 1, id: 3, name: 'Foxtrot', creator: gleb });
    await refresh();
    const created = (await squadEvents()).filter((row) => row.kind === 'squad.created');
    expect(created.some((row) => row.actorId === gleb.eos)).toBe(true);
    expect(created.some((row) => row.actorId === felix.eos)).toBe(false);
  });
});
