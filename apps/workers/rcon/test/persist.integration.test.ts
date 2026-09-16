import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { playerNameHistory, players } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import { upsertPlayers } from '../src/persist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../../packages/db/drizzle');

const HOST_DB_URL = process.env.DATABASE_URL;
const describeIfDb = HOST_DB_URL ? describe : describe.skip;

function baseDbUrl(url: string): string {
  return url.replace(/\?.*$/, '');
}

async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe('SET client_min_messages = WARNING');
    // Several trigger functions pin `search_path = pg_catalog, public`, so
    // validating their bodies here would resolve `%ROWTYPE` against the shared
    // public schema instead of this test schema — and fail once a later
    // migration has dropped that table there. The bodies are validated by the
    // real migration run; this replay only needs the objects to exist.
    await sql.unsafe('SET check_function_bodies = off');
    const files = readdirSync(MIGRATIONS_FOLDER)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      // Strip both spellings of the schema qualifier: a quoted `"public".` left in
      // place would point a foreign key at the shared public schema.
      const contents = readFileSync(path.join(MIGRATIONS_FOLDER, file), 'utf-8').replace(
        /(?:"public"|\bpublic)\./gi,
        '',
      );
      const statements = contents
        .split(/-->\s*statement-breakpoint\s*/i)
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    }
  } finally {
    await sql.end();
  }
}

function makePlayer(overrides: Partial<RconPlayer>): RconPlayer {
  return {
    rcon_id: 1,
    eos_id: 'eos-persist-integration-00000000',
    steam_id64: '76561199000000001',
    name: 'BaseName',
    team_id: 1,
    squad_id: 1,
    is_leader: false,
    role: 'USA_Rifleman_01',
    ...overrides,
  };
}

async function historyFor(db: DatabaseClient, playerId: string) {
  return db.select().from(playerNameHistory).where(eq(playerNameHistory.playerId, playerId));
}

async function playerIdByEos(db: DatabaseClient, eosId: string): Promise<string> {
  const [row] = await db.select({ id: players.id }).from(players).where(eq(players.eosId, eosId));
  if (!row) throw new Error(`no player for eos_id=${eosId}`);
  return row.id;
}

describeIfDb('upsertPlayers integration', () => {
  const schemaName = `test_rcon_${randomBytes(6).toString('hex')}`;
  const base = baseDbUrl(HOST_DB_URL ?? '');
  const schemaUrl = `${base}?search_path=${schemaName}%2Cpublic`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let db: DatabaseClient;

  beforeAll(async () => {
    admin = postgres(base, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await runMigrations(schemaUrl);
    sql = postgres(schemaUrl, { max: 2, onnotice: () => undefined });
    db = drizzle(sql, { schema }) as unknown as DatabaseClient;
  }, 60_000);

  afterAll(async () => {
    await sql?.end().catch(() => undefined);
    await admin?.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  }, 30_000);

  it('collapses 50 same-name logins in a day into a single history row', async () => {
    const eosId = 'eos-dedup-000000000000000000000001';
    for (let login = 0; login < 50; login += 1) {
      await upsertPlayers(db, [
        makePlayer({ eos_id: eosId, steam_id64: '76561199000000011', name: 'SteadyGamer' }),
      ]);
    }
    const playerId = await playerIdByEos(db, eosId);
    const rows = await historyFor(db, playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nameNormalized).toBe('steadygamer');
    expect(rows[0]?.observationCount).toBe(50);
  });

  it('records a new history row when the nickname changes', async () => {
    const eosId = 'eos-change-00000000000000000000002';
    await upsertPlayers(db, [
      makePlayer({ eos_id: eosId, steam_id64: '76561199000000012', name: 'FirstAlias' }),
    ]);
    await upsertPlayers(db, [
      makePlayer({ eos_id: eosId, steam_id64: '76561199000000012', name: 'SecondAlias' }),
    ]);
    const playerId = await playerIdByEos(db, eosId);
    const rows = await historyFor(db, playerId);
    const normalizedNames = rows.map((row) => row.nameNormalized).sort();
    expect(normalizedNames).toEqual(['firstalias', 'secondalias']);
  });

  it('stores clan-tag-stripped normalized names on both player and history', async () => {
    const eosId = 'eos-clantag-0000000000000000000003';
    await upsertPlayers(db, [
      makePlayer({ eos_id: eosId, steam_id64: '76561199000000013', name: '[MDC] Bob' }),
    ]);
    const playerId = await playerIdByEos(db, eosId);
    const [player] = await db
      .select({ normalized: players.canonicalNameNormalized })
      .from(players)
      .where(eq(players.id, playerId));
    expect(player?.normalized).toBe('bob');
    const [history] = await historyFor(db, playerId);
    expect(history?.nameNormalized).toBe('bob');
    expect(history?.name).toBe('[MDC] Bob');
  });

  it('dedupes a clan-tag change that leaves the base nickname unchanged', async () => {
    const eosId = 'eos-tagswap-0000000000000000000004';
    await upsertPlayers(db, [
      makePlayer({ eos_id: eosId, steam_id64: '76561199000000014', name: '[MDC] Rex' }),
    ]);
    await upsertPlayers(db, [
      makePlayer({ eos_id: eosId, steam_id64: '76561199000000014', name: '[TSF] Rex' }),
    ]);
    const playerId = await playerIdByEos(db, eosId);
    const rows = await historyFor(db, playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nameNormalized).toBe('rex');
    const [player] = await db
      .select({ canonicalName: players.canonicalName })
      .from(players)
      .where(and(eq(players.id, playerId)));
    expect(player?.canonicalName).toBe('[TSF] Rex');
  });
});
