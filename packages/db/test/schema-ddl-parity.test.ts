import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { describeIfDb } from './helpers/describe-if.js';

/**
 * Issue #78 (finding 1123): the TypeScript schema must describe the indexes and
 * CHECK constraints the migrations really create, so the next
 * `drizzle-kit generate` does not drop or recreate them and reviewers read the
 * true index from the schema file.
 */
const DATABASE_URL = process.env.DATABASE_URL;

let sql: postgres.Sql;

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const tables = Object.values(schema).filter((value): value is PgTable => is(value, PgTable));

describeIfDb('TypeScript schema vs migrated database', () => {
  it('declares only indexes that exist, with the same uniqueness and partial predicate', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`;
    const defs = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    const problems: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const index of config.indexes) {
        const name = index.config.name;
        const def = defs.get(name);
        if (!def) {
          problems.push(`${config.name}.${name}: missing in database`);
          continue;
        }
        if (index.config.unique !== def.startsWith('CREATE UNIQUE')) {
          problems.push(`${config.name}.${name}: uniqueness differs`);
        }
        if (Boolean(index.config.where) !== / WHERE /.test(def)) {
          problems.push(`${config.name}.${name}: partial predicate differs`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('declares only CHECK constraints that exist', async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'c'`;
    const names = new Set(rows.map((row) => row.conname));

    const missing: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const check of config.checks) {
        if (!names.has(check.name)) missing.push(`${config.name}.${check.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('declares every non-constraint database index of a declared table', async () => {
    const rows = await sql<{ tablename: string; indexname: string }[]>`
      SELECT i.tablename, i.indexname FROM pg_indexes i
      WHERE i.schemaname = current_schema()
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class ic ON ic.oid = c.conindid
          WHERE ic.relname = i.indexname AND ic.relnamespace = current_schema()::regnamespace)`;
    const declaredTables = new Set(tables.map((table) => getTableConfig(table).name));
    const declared = new Set(
      tables.flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name)),
    );
    const undeclared = rows
      .filter((row) => declaredTables.has(row.tablename) && !declared.has(row.indexname))
      .map((row) => `${row.tablename}.${row.indexname}`)
      // Monthly partitions carry their own copies of the parent's indexes.
      .filter((name) => !/_p\d{4}_\d{2}|_default/.test(name));
    expect(undeclared).toEqual([]);
  });

  it('declares every CHECK constraint of a declared table, except the known gaps', async () => {
    const rows = await sql<{ tablename: string; conname: string }[]>`
      SELECT conrelid::regclass::text AS tablename, conname FROM pg_constraint
      WHERE contype = 'c' AND connamespace = current_schema()::regnamespace`;
    const declaredTables = new Set(tables.map((table) => getTableConfig(table).name));
    const declared = new Set(
      tables.flatMap((table) => getTableConfig(table).checks.map((check) => check.name)),
    );
    const undeclared = rows
      .filter((row) => declaredTables.has(row.tablename) && !declared.has(row.conname))
      .map((row) => `${row.tablename}.${row.conname}`)
      .sort();
    // Shrink this list as the checks get declared; a new entry means a
    // migration added a CHECK the schema file does not describe.
    expect(undeclared).toEqual([
      'role_squad_permissions.role_squad_permissions_key_enum',
      'roles.roles_color_format',
      'roles.roles_flag_dependency',
      'server_settings.server_settings_map_vote_selection_check',
    ]);
  });
});

describeIfDb('discord_message_templates keeps one template per event type (#1127)', () => {
  it('rejects a second locale for the same event type', async () => {
    await expect(
      sql`INSERT INTO discord_message_templates (event_type, locale, template)
          VALUES ('kick', 'ru', '{}'::jsonb)`,
    ).rejects.toThrow(/discord_message_templates_event_type_key/);
  });

  it('rejects a locale outside the supported set and an unknown event type', async () => {
    await expect(
      sql`UPDATE discord_message_templates SET locale = 'de' WHERE event_type = 'kick'`,
    ).rejects.toThrow(/discord_message_templates_locale_chk/);
    await expect(
      sql`INSERT INTO discord_message_templates (event_type, template)
          VALUES ('no_such_event', '{}'::jsonb)`,
    ).rejects.toThrow(/discord_message_templates_event_type_chk/);
  });
});
