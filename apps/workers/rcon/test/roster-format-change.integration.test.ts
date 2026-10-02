/**
 * #126 end to end: Squad build 25594911 changed the `ListPlayers` and
 * `ListSquads` layouts and the strict parsers read nothing, so every server
 * showed 0 players and 0 squads. A fake Squad server whose reply layout the
 * test switches, a real supervisor, real Redis and Postgres: the new layout
 * must be read, and an unreadable one must be flagged in `rcon:status` rather
 * than published as an empty roster, closing sessions or disbanding squads.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { events, servers } from '@squad/db/schema';
import { STREAM_NAME } from '@squad/shared-types';
import { and, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';
import { RconSupervisor, type Target } from '../src/supervisor.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

type Layout = 'old' | 'new' | 'unreadable';

interface GamePlayer {
  eos: string;
  steam: string;
  name: string;
  squad: number | null;
  leader: boolean;
}

function gamePlayer(name: string, squad: number | null, leader = false): GamePlayer {
  return {
    eos: randomBytes(16).toString('hex'),
    steam: `7656119${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`,
    name,
    squad,
    leader,
  };
}

const anna = gamePlayer('Anna', 1, true);
const boris = gamePlayer('Boris', 1);
const game: { layout: Layout; players: GamePlayer[]; squads: GamePlayer[] } = {
  layout: 'new',
  players: [],
  squads: [],
};
const commands: string[] = [];

function listPlayers(): string {
  const rows = game.players.map((p, i) => {
    const ids = `Online IDs: EOS: ${p.eos} steam: ${p.steam}`;
    const squad = p.squad ?? 'N/A';
    const leader = p.leader ? 'True' : 'False';
    if (game.layout === 'old') {
      return `ID: ${i} | ${ids} | Name: ${p.name} | Team ID: 1 | Squad ID: ${squad} | Is Leader: ${leader} | Role: USA_Rifleman_01`;
    }
    if (game.layout === 'new') {
      return `ID: ${i} | ${ids} | Name: ${p.name} | Team ID: 1 | Party ID: N/A | Squad ID: ${squad} | Is Leader: ${leader} | Role: USA_Rifleman_01 | Vehicle: N/A`;
    }
    return `ID: ${i} | ${ids} | Name: ${p.name} | Faction: 1 | Group: ${squad} | Role: USA_Rifleman_01`;
  });
  return [
    '----- Active Players -----',
    ...rows,
    '----- Recently Disconnected Players [Max of 15] -----',
  ].join('\n');
}

function listSquads(): string {
  const lines = [
    game.layout === 'new'
      ? 'Team ID: 1 (United States Army) - Tickets: 169'
      : 'Team ID: 1 (United States Army)',
  ];
  for (const creator of game.squads) {
    const ids = `Creator Online IDs: EOS: ${creator.eos} steam: ${creator.steam}`;
    if (game.layout === 'unreadable') {
      lines.push(`ID: ${creator.squad} | Name: Alpha | Members: 1 | Owner: ${creator.name}`);
    } else {
      lines.push(
        `ID: ${creator.squad} | Name: Alpha | Size: 1 | Locked: False | Creator Name: ${creator.name} | ${ids}`,
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

const warn = vi.fn();
const log = {
  info: vi.fn(),
  warn,
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as never;

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
let gameServer: Server;
let target: Target;
let supervisor: RconSupervisor;
const serverId = randomUUID();

/** One hinted roster + info refresh, finished once server info was read. */
async function refresh(): Promise<void> {
  const before = count('ShowServerInfo');
  expect(supervisor.hint(serverId, ['roster', 'info'])).toBe(true);
  await waitFor(() => count('ShowServerInfo') > before);
}

async function status(): Promise<Record<string, unknown>> {
  return JSON.parse((await redis.get(`rcon:status:${serverId}`)) ?? '{}') as Record<
    string,
    unknown
  >;
}

async function cached(kind: 'roster' | 'squads'): Promise<Record<string, unknown>> {
  return JSON.parse((await redis.get(`rcon:${kind}:${serverId}`)) ?? '{}') as Record<
    string,
    unknown
  >;
}

function squadEvents() {
  return db
    .select()
    .from(events)
    .where(and(eq(events.serverId, serverId), like(events.kind, 'squad.%')));
}

beforeAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  sql = postgres(DATABASE_URL, { max: 4, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await db.insert(servers).values({
    id: serverId,
    displayName: 'Roster Format Test Server',
    slug: `roster-format-${randomBytes(4).toString('hex')}`,
  });
  const started = await startGameServer();
  gameServer = started.server;
  target = {
    serverId,
    host: '127.0.0.1',
    port: started.port,
    queryPort: started.port + 1000,
    password: 'pw',
  };
  game.layout = 'new';
  game.players = [anna, boris];
  game.squads = [anna];
  supervisor = new RconSupervisor({
    db,
    redis,
    log,
    pollIntervalMs: 600_000,
    rosterIntervalMs: 600_000,
    infoIntervalMs: 600_000,
    hintDebounceMs: 5,
    hintFollowUpMs: 600_000,
  });
  await supervisor.reconcile([target]);
  await waitFor(() => count('ShowServerInfo') > 0);
});

afterAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  await supervisor?.stop();
  await new Promise<void>((resolve) => gameServer.close(() => resolve()));
  await redis.del(
    `rcon:status:${serverId}`,
    `rcon:roster:${serverId}`,
    `rcon:squads:${serverId}`,
    `rcon:commands:${serverId}`,
    STREAM_NAME.eventsServer(serverId),
  );
  await db.delete(servers).where(eq(servers.id, serverId));
  await redis.quit();
  await sql.end();
});

describeIfDbAndRedis('roster parsing across Squad reply layouts (#126)', () => {
  it('reads the build 25594911 layout: the roster, squads and counts are published', async () => {
    const current = await status();
    expect(current).toMatchObject({
      state: 'connected',
      player_count: 2,
      squad_count: 1,
      roster_parse_error: null,
    });
    expect((await cached('roster')).players).toHaveLength(2);
    expect((await cached('squads')).squads).toMatchObject([
      { team_id: 1, team_name: 'United States Army', squad_id: 1, name: 'Alpha' },
    ]);
  });

  it('still reads the old layout', async () => {
    game.layout = 'old';
    await refresh();
    expect(await status()).toMatchObject({ player_count: 2, squad_count: 1 });
    game.layout = 'new';
    await refresh();
  });

  it('flags an unreadable reply instead of publishing zero players and disbanding squads', async () => {
    const rosterBefore = await cached('roster');
    game.layout = 'unreadable';
    await refresh();

    expect(await status()).toMatchObject({
      state: 'connected',
      player_count: null,
      squad_count: null,
      roster_parse_error: ['players', 'squads'],
    });
    // The last good roster and squads stay; nothing was overwritten with [].
    expect((await cached('roster')).players).toHaveLength(2);
    expect((await cached('roster')).polled_at).toBe(rosterBefore.polled_at);
    expect((await cached('squads')).squads).toHaveLength(1);
    expect(await squadEvents()).toEqual([]);

    const problems = warn.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields.problem === 'players' || fields.problem === 'squads');
    expect(problems.map((fields) => fields.problem).sort()).toEqual(['players', 'squads']);
    const logged = JSON.stringify(problems);
    expect(logged).not.toContain(anna.eos);
    expect(logged).not.toContain(anna.steam);
    expect(logged).not.toContain('Anna');
  });

  it('clears the flag once the reply is readable again, with no squad events', async () => {
    game.layout = 'new';
    await refresh();
    expect(await status()).toMatchObject({
      player_count: 2,
      squad_count: 1,
      roster_parse_error: null,
    });
    expect(await squadEvents()).toEqual([]);
  });

  it('still reports a squad that really disbanded', async () => {
    game.squads = [];
    anna.squad = null;
    anna.leader = false;
    boris.squad = null;
    await refresh();
    expect(await status()).toMatchObject({
      player_count: 2,
      squad_count: 0,
      roster_parse_error: null,
    });
    const disbanded = await squadEvents();
    expect(disbanded.map((event) => event.kind)).toEqual(['squad.disbanded']);
  });
});
