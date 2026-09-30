import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoleFromEnv, provisionAppRole } from '../src/app-role.js';

// #47 (#1250): api and workers must not reach Postgres as the superuser that
// owns the schema. The migrator provisions a least-privilege login role; these
// tests connect AS that role and prove what it can and cannot do.

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// Roles are cluster-wide, so every run gets its own name and drops it again.
const ROLE = `panel_app_t${process.pid}_${Date.now().toString(36)}`;
const PASSWORD = 'AppRoleTestPassword_0123456789';
const ROTATED_PASSWORD = 'AppRoleTestPassword_rotated_9876';

function urlAs(role: string, password: string): string {
  const url = new URL(DATABASE_URL ?? '');
  url.username = role;
  url.password = password;
  return url.toString();
}

async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('appRoleFromEnv', () => {
  it('returns null when no application role is configured (the stack keeps its owner login)', () => {
    expect(appRoleFromEnv({})).toBeNull();
    expect(appRoleFromEnv({ PANEL_DB_USER: '', PANEL_DB_PASSWORD: '' })).toBeNull();
  });

  it('reads the role and password when both are set', () => {
    expect(appRoleFromEnv({ PANEL_DB_USER: 'panel_app', PANEL_DB_PASSWORD: PASSWORD })).toEqual({
      role: 'panel_app',
      password: PASSWORD,
    });
  });

  it('refuses a role without a password and a password without a role', () => {
    expect(() => appRoleFromEnv({ PANEL_DB_USER: 'panel_app' })).toThrow(/PANEL_DB_PASSWORD/);
    expect(() => appRoleFromEnv({ PANEL_DB_PASSWORD: PASSWORD })).toThrow(/PANEL_DB_USER/);
  });

  it('refuses role names that are not plain lowercase identifiers', () => {
    for (const role of ['Panel', 'panel-app', 'panel app', '1panel', 'a"; DROP ROLE admin; --']) {
      expect(() => appRoleFromEnv({ PANEL_DB_USER: role, PANEL_DB_PASSWORD: PASSWORD })).toThrow(
        /PANEL_DB_USER/,
      );
    }
  });

  it('refuses short or URL-unsafe passwords, since the password is embedded in DATABASE_URL', () => {
    for (const password of [
      'short',
      'has space in it 12345',
      'slash/in/the/password/1234',
      "quote'inside_password_1234",
    ]) {
      expect(() =>
        appRoleFromEnv({ PANEL_DB_USER: 'panel_app', PANEL_DB_PASSWORD: password }),
      ).toThrow(/PANEL_DB_PASSWORD/);
    }
  });
});

describeIfDb('provisionAppRole against the migrated schema', () => {
  let owner: ReturnType<typeof postgres>;
  let app: ReturnType<typeof postgres>;

  beforeAll(async () => {
    owner = postgres(DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
    await provisionAppRole(owner, { role: ROLE, password: PASSWORD });
    app = postgres(urlAs(ROLE, PASSWORD), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end();
    if (!owner) return;
    await owner.unsafe(`DROP OWNED BY "${ROLE}"`);
    await owner.unsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
    await owner.end();
  });

  it('creates a login role that is not a superuser and cannot create roles or databases', async () => {
    const [row] = await owner`
      SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin
      FROM pg_roles WHERE rolname = ${ROLE}`;
    expect(row).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    const [me] = await app`SELECT current_user AS name`;
    expect(me?.name).toBe(ROLE);
  });

  it('reads and writes ordinary tables', async () => {
    const id = crypto.randomUUID();
    const name = `app-role-test-${ROLE}`;
    await app`INSERT INTO issue_labels (id, name, color) VALUES (${id}, ${name}, '#000000')`;
    await app`UPDATE issue_labels SET color = '#ffffff' WHERE id = ${id}`;
    const [row] = await app`SELECT color FROM issue_labels WHERE id = ${id}`;
    expect(row?.color).toBe('#ffffff');
    await app`DELETE FROM issue_labels WHERE id = ${id}`;
  });

  it('appends to audit_log through its sequence and hash-chain trigger', async () => {
    const [row] = await app`
      INSERT INTO audit_log (actor_kind, actor_system_label, action_type)
      VALUES ('system', 'app-role-test', 'app_role.test')
      RETURNING id, row_hash IS NOT NULL AS hashed`;
    expect(row?.hashed).toBe(true);
    const [read] = await app`SELECT action_type FROM audit_log WHERE id = ${row?.id}`;
    expect(read?.action_type).toBe('app_role.test');
  });

  it('is denied UPDATE, DELETE and TRUNCATE on the append-only tables by privilege, not only by trigger', async () => {
    for (const table of ['audit_log', 'config_versions']) {
      expect(await sqlState(() => app.unsafe(`UPDATE ${table} SET id = id WHERE false`))).toBe(
        '42501',
      );
      expect(await sqlState(() => app.unsafe(`DELETE FROM ${table} WHERE false`))).toBe('42501');
      expect(await sqlState(() => app.unsafe(`TRUNCATE ${table}`))).toBe('42501');
    }
  });

  it('cannot disable the append-only triggers, change the schema, or run server programs', async () => {
    expect(await sqlState(() => app.unsafe('ALTER TABLE audit_log DISABLE TRIGGER USER'))).toBe(
      '42501',
    );
    expect(await sqlState(() => app.unsafe('DROP TABLE panel_meta'))).toBe('42501');
    expect(await sqlState(() => app.unsafe('CREATE TABLE app_role_probe (id int)'))).toBe('42501');
    expect(await sqlState(() => app.unsafe("COPY (SELECT 1) TO PROGRAM 'true'"))).toBe('42501');
  });

  it('is idempotent and rotates the password on re-provisioning', async () => {
    await provisionAppRole(owner, { role: ROLE, password: ROTATED_PASSWORD });
    const rotated = postgres(urlAs(ROLE, ROTATED_PASSWORD), { max: 1, onnotice: () => {} });
    try {
      const [row] = await rotated`SELECT 1 AS ok`;
      expect(row?.ok).toBe(1);
    } finally {
      await rotated.end();
    }
  });

  it('grants the role access to tables that later migrations create', async () => {
    const table = `app_role_future_${process.pid}`;
    await owner.unsafe(`CREATE TABLE ${table} (id int)`);
    try {
      await app.unsafe(`INSERT INTO ${table} VALUES (1)`);
      const rows = await app.unsafe(`SELECT id FROM ${table}`);
      expect(rows).toHaveLength(1);
    } finally {
      await owner.unsafe(`DROP TABLE ${table}`);
    }
  });

  it('refuses to provision the connected owner role itself', async () => {
    const [me] = await owner`SELECT current_user AS name`;
    await expect(
      provisionAppRole(owner, { role: String(me?.name), password: PASSWORD }),
    ).rejects.toThrow(/owner/);
  });
});
