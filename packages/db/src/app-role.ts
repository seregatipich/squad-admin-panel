/**
 * Least-privilege Postgres login for the api and the workers (#47).
 *
 * The schema is owned by the role the migrator connects as (`admin`, the
 * `POSTGRES_USER` of the postgres image, a superuser). A process connected as
 * that role can disable the append-only triggers on `audit_log` and
 * `config_versions`, drop tables, or run `COPY ... TO PROGRAM`. The migrator
 * therefore provisions a separate login role for everything else: it may read
 * and write the application tables, may only SELECT and INSERT on the
 * append-only tables, and owns nothing, so it can neither change the schema nor
 * switch a trigger off.
 *
 * `worker-event-partition` still connects as the owner: it creates and drops
 * partitions, which only the owner of the partitioned tables may do.
 */
import type { Sql } from 'postgres';

/** Tables whose rows may never change once written; the app role gets SELECT and INSERT only. */
export const APPEND_ONLY_TABLES = ['audit_log', 'config_versions'] as const;

/** Name and password of the application login role. */
export interface AppRoleOptions {
  /** Lowercase SQL identifier, e.g. `panel_app`. */
  role: string;
  /** Embedded verbatim in `DATABASE_URL`, so it is restricted to URL-safe characters. */
  password: string;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const PASSWORD = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Reads the application role from `PANEL_DB_USER` / `PANEL_DB_PASSWORD`.
 *
 * @param env - The process environment (or a test stand-in).
 * @returns The role to provision, or `null` when neither variable is set, in
 *   which case the stack keeps connecting as the schema owner.
 * @throws Error when only one of the two is set, the role is not a plain
 *   lowercase identifier, or the password is shorter than 16 characters or
 *   contains a character outside `[A-Za-z0-9_-]`.
 */
export function appRoleFromEnv(env: NodeJS.ProcessEnv): AppRoleOptions | null {
  const role = env.PANEL_DB_USER ?? '';
  const password = env.PANEL_DB_PASSWORD ?? '';
  if (role === '' && password === '') return null;
  if (role === '') throw new Error('PANEL_DB_PASSWORD is set but PANEL_DB_USER is not');
  if (password === '') throw new Error('PANEL_DB_USER is set but PANEL_DB_PASSWORD is not');
  if (!ROLE_NAME.test(role)) {
    throw new Error('PANEL_DB_USER must be a lowercase SQL identifier ([a-z_][a-z0-9_]*)');
  }
  if (!PASSWORD.test(password)) {
    throw new Error(
      'PANEL_DB_PASSWORD must be 16-256 characters of [A-Za-z0-9_-] (generate: openssl rand -hex 32)',
    );
  }
  return { role, password };
}

/**
 * Creates or updates the application login role and (re)applies its grants.
 *
 * Idempotent: every migrator run re-applies the grants, so tables added by
 * later migrations are covered, and a changed password is rotated in place.
 * Default privileges cover tables the connected owner creates afterwards.
 *
 * @param sql - A connection as the schema owner (the migrator's connection).
 * @param options - The role to provision; validated as in {@link appRoleFromEnv}.
 * @throws Error when the role is the connected owner itself or an existing
 *   superuser, which this function refuses to demote.
 */
export async function provisionAppRole(sql: Sql, options: AppRoleOptions): Promise<void> {
  const { role, password } = appRoleFromEnv({
    PANEL_DB_USER: options.role,
    PANEL_DB_PASSWORD: options.password,
  }) as AppRoleOptions;

  const [owner] = await sql<{ name: string }[]>`SELECT current_user AS name`;
  if (owner?.name === role) {
    throw new Error(`PANEL_DB_USER must differ from the schema owner "${role}"`);
  }
  const [existing] = await sql<{ rolsuper: boolean }[]>`
    SELECT rolsuper FROM pg_roles WHERE rolname = ${role}`;
  const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (existing?.rolsuper) {
    throw new Error(`refusing to demote the existing superuser "${role}"`);
  }

  // Utility statements take no bind parameters. The role and password were
  // validated against [a-z0-9_] / [A-Za-z0-9_-], so quoting cannot be escaped.
  const ident = `"${role}"`;
  const attributes = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  const verb = existing ? 'ALTER' : 'CREATE';
  await sql.begin(async (tx) => {
    await tx.unsafe(`${verb} ROLE ${ident} WITH ${attributes} PASSWORD '${password}'`);
    const databaseIdent = `"${String(database?.name).replaceAll('"', '""')}"`;
    await tx.unsafe(`GRANT CONNECT ON DATABASE ${databaseIdent} TO ${ident}`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${ident}`);
    await tx.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident}`,
    );
    await tx.unsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ident}`);
    for (const table of APPEND_ONLY_TABLES) {
      await tx.unsafe(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM ${ident}`);
    }
    await tx.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident}`,
    );
    await tx.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${ident}`,
    );
  });
}
