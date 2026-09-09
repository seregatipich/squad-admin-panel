import { randomBytes, randomUUID } from 'node:crypto';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { playerSessions, players, servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const EOS_A = randomBytes(16).toString('hex');
const EOS_B = randomBytes(16).toString('hex');
const STEAM_A = '76561198012345671';
const STEAM_B = '76561198012345672';

function playerLine(rconId: number, eos: string, steam: string, name: string): string {
  return `ID: ${rconId} | Online IDs: EOS: ${eos} steam: ${steam} | Name: ${name} | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: USA_Rifleman_01`;
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

function makeRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(0),
    xadd: vi.fn().mockResolvedValue('0-0'),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xautoclaim: vi.fn().mockResolvedValue(['0-0', [], []]),
    get: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
  } as never;
}

/** Fake Squad RCON server whose `ListPlayers` roster the test can rewrite. */
function makeRconServer(roster: { lines: string[] }): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      const stream = new RconPacketStream();
      const write = (id: number, body: string, type = SERVERDATA_RESPONSE_VALUE) => {
        if (!sock.destroyed) sock.write(encodePacket({ id, type, body }));
      };
      sock.on('error', () => undefined);
      sock.on('data', (chunk) => {
        for (const packet of stream.push(chunk)) {
          if (packet.type === SERVERDATA_AUTH) {
            write(packet.id, '');
            write(packet.id, '', SERVERDATA_AUTH_RESPONSE);
            continue;
          }
          if (packet.type !== SERVERDATA_EXECCOMMAND) continue;
          if (packet.body === '') {
            write(packet.id, '');
            continue;
          }
          if (packet.body === 'ListPlayers') {
            write(
              packet.id,
              [
                '----- Active Players -----',
                ...roster.lines,
                '----- Recently Disconnected Players [Max of 15] -----',
              ].join('\n'),
            );
            continue;
          }
          write(packet.id, '');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;
let serverId: string;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 4, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
  serverId = randomUUID();
  await db.insert(servers).values({
    id: serverId,
    displayName: 'Supervisor Sessions Test Server',
    slug: `supervisor-sessions-${randomBytes(4).toString('hex')}`,
  });
});

afterAll(async () => {
  if (sql) await sql.end();
});

async function openSessions() {
  return db
    .select({ playerId: playerSessions.playerId })
    .from(playerSessions)
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)));
}

async function sessionRows() {
  return db.select().from(playerSessions).where(eq(playerSessions.serverId, serverId));
}

async function waitFor<T>(probe: () => Promise<T>, ok: (value: T) => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  let last = await probe();
  while (Date.now() < deadline && !ok(last)) {
    await sleep(100);
    last = await probe();
  }
  return last;
}

describeIfDb('RconSupervisor player_sessions wiring', () => {
  it('opens a session per polled player, closes one who leaves, and closes the rest on stop', async () => {
    const roster = {
      lines: [playerLine(0, EOS_A, STEAM_A, 'SessionA'), playerLine(1, EOS_B, STEAM_B, 'SessionB')],
    };
    const { server, port } = await makeRconServer(roster);
    const supervisor = new RconSupervisor({
      db,
      redis: makeRedis(),
      log: makeLogger(),
      pollIntervalMs: 200,
      rosterIntervalMs: 600_000,
    });
    const liveTarget: Target = {
      serverId,
      host: '127.0.0.1',
      port,
      queryPort: port + 1000,
      password: 'testpass',
      // Two players are already "live" — keeps the seeding state machine out of
      // this test, which is about the poll-driven session reconcile only.
      seedLiveAt: 1,
    };

    try {
      await supervisor.reconcile([liveTarget]);

      const opened = await waitFor(openSessions, (rows) => rows.length === 2);
      expect(opened).toHaveLength(2);

      // B leaves the roster: its session must close, A's must stay open.
      roster.lines = [playerLine(0, EOS_A, STEAM_A, 'SessionA')];
      const afterLeave = await waitFor(openSessions, (rows) => rows.length === 1);
      expect(afterLeave).toHaveLength(1);

      const [playerA] = await db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.eosId, EOS_A));
      expect(afterLeave[0]?.playerId).toBe(playerA?.id);

      await supervisor.stop();

      const all = await waitFor(sessionRows, (rows) =>
        rows.every((r) => r.disconnectedAt !== null),
      );
      expect(all).toHaveLength(2);
      expect(await openSessions()).toHaveLength(0);
      for (const row of all) {
        expect(row.durationSeconds).not.toBeNull();
      }
    } finally {
      await supervisor.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }, 30_000);
});
