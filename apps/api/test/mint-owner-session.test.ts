import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/tools/mint-owner-session.js';
import { type CreatedSchema, createIsolatedSchema } from './integration/isolated-db.js';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_PLAYER_STEAM_ID = '76561199925900001';
const EXISTING_PLAYER_STEAM_ID = '76561199925900002';

type SqlClient = ReturnType<typeof postgres>;

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Runs the command in-process through the same `main` the CLI calls. The
// leading `--` is what `pnpm mint:owner-session -- …` hands the script.
async function runCommand(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  const status = await main(['--', ...args], env, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { status, stdout, stderr };
}

// Starts the real entry point the way the package script does (tsx with the
// development export condition), minus the pnpm wrapper's own startup cost.
function spawnCli(args: string[], env: NodeJS.ProcessEnv): CommandResult {
  return spawnSync(
    process.execPath,
    ['--conditions=development', '--import', 'tsx', 'src/tools/mint-owner-session.ts', ...args],
    { cwd: API_ROOT, env, encoding: 'utf8', timeout: 15_000 },
  );
}

function tokenId(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('base64url');
}

describe('mint-owner-session operator command', () => {
  let sql: SqlClient;
  let isolatedDatabase: CreatedSchema;
  let databaseUrl: string;
  let ownerRoleId: string;
  const serverId = randomUUID();

  beforeAll(async () => {
    isolatedDatabase = await createIsolatedSchema();
    databaseUrl = isolatedDatabase.url;
    sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const [ownerRole] = await sql<{ id: string }[]>`
      SELECT id
      FROM roles
      WHERE name = 'Owner' AND is_system_role = true
    `;
    if (!ownerRole) throw new Error('Owner role missing from migrated test database');
    ownerRoleId = ownerRole.id;

    await sql`
      INSERT INTO servers (id, display_name, slug)
      VALUES (${serverId}, 'Mint session test', ${`mint-session-${randomBytes(6).toString('hex')}`})
    `;

    // Migration 0107 prevents deleting the last Owner. This guard keeps target
    // rows disposable while the isolated worker database exists.
    await sql`
      INSERT INTO players (
        canonical_name,
        canonical_name_normalized,
        role_id
      ) VALUES (
        ${`Mint owner guard ${randomBytes(6).toString('hex')}`},
        ${`mint owner guard ${randomBytes(6).toString('hex')}`},
        ${ownerRoleId}
      )
    `;
  });

  afterAll(async () => {
    await sql?.end();
    await isolatedDatabase?.drop();
  });

  it('resolves workspace sources in a fresh checkout before packages are built', () => {
    const manifest = JSON.parse(readFileSync(path.join(API_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['mint:owner-session']).toContain('--conditions=development');
  });

  it('prints help without requiring a database connection', async () => {
    const result = await runCommand(['--help'], { DATABASE_URL: '' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--confirm-steam-id64 <same 17 digits>');
  });

  it('rejects an invalid SteamID64 before trying to connect', async () => {
    const result = await runCommand(
      ['--steam-id64', '123', '--confirm-steam-id64', '123', '--name', 'Owner'],
      { DATABASE_URL: '' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('SteamID64 must contain exactly 17 digits');
  });

  it('rejects a confirmation mismatch before trying to connect', async () => {
    const result = await runCommand(
      [
        '--steam-id64',
        NEW_PLAYER_STEAM_ID,
        '--confirm-steam-id64',
        EXISTING_PLAYER_STEAM_ID,
        '--name',
        'Owner',
      ],
      { DATABASE_URL: '' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--confirm-steam-id64 must exactly match --steam-id64');
  });

  it('requires DATABASE_URL after validating the explicit confirmation', async () => {
    const result = await runCommand(
      [
        '--steam-id64',
        NEW_PLAYER_STEAM_ID,
        '--confirm-steam-id64',
        NEW_PLAYER_STEAM_ID,
        '--name',
        'Owner',
      ],
      { DATABASE_URL: '' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('mint-owner-session: DATABASE_URL is required\n');
  });

  it('does not echo database credentials when a connection fails', async () => {
    const credential = `mint-secret-${randomBytes(8).toString('hex')}`;
    const result = await runCommand(
      [
        '--steam-id64',
        NEW_PLAYER_STEAM_ID,
        '--confirm-steam-id64',
        NEW_PLAYER_STEAM_ID,
        '--name',
        'Owner',
      ],
      { DATABASE_URL: `postgres://admin:${credential}@127.0.0.1:1/admin` },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^mint-owner-session: /u);
    expect(result.stderr).not.toContain(credential);
  });

  // The one case that still starts a process: it proves the entry point wires
  // argv, stdout and the exit code the way an operator's shell sees them.
  it('creates a new Owner player and a six-hour panel session through player_id', async () => {
    await sql`DELETE FROM players WHERE steam_id64 = ${NEW_PLAYER_STEAM_ID}`;
    const startedAt = Date.now();

    const result = spawnCli(
      [
        '--steam-id64',
        NEW_PLAYER_STEAM_ID,
        '--confirm-steam-id64',
        NEW_PLAYER_STEAM_ID,
        '--name',
        '[MDC] New Owner',
      ],
      { ...process.env, DATABASE_URL: databaseUrl },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const rawToken = result.stdout.trim();
    expect(rawToken).toMatch(/^s_[0-9a-f-]{36}_[A-Za-z0-9_-]{32}$/u);

    const [row] = await sql<
      {
        player_id: string;
        steam_id64: string;
        canonical_name: string;
        canonical_name_normalized: string;
        role_id: string;
        scope: string;
        session_id: string;
        expires_at: Date;
      }[]
    >`
      SELECT
        p.id AS player_id,
        p.steam_id64::text AS steam_id64,
        p.canonical_name,
        p.canonical_name_normalized,
        p.role_id,
        s.scope,
        s.id AS session_id,
        s.expires_at
      FROM players p
      JOIN sessions s ON s.player_id = p.id
      WHERE p.steam_id64 = ${NEW_PLAYER_STEAM_ID}
        AND s.id = ${tokenId(rawToken)}
    `;

    expect(row).toMatchObject({
      steam_id64: NEW_PLAYER_STEAM_ID,
      canonical_name: '[MDC] New Owner',
      canonical_name_normalized: 'new owner',
      role_id: ownerRoleId,
      scope: 'panel',
      session_id: tokenId(rawToken),
    });
    expect(row?.expires_at.getTime()).toBeGreaterThanOrEqual(
      startedAt + 6 * 60 * 60 * 1000 - 2_000,
    );
    expect(row?.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 6 * 60 * 60 * 1000 + 2_000);
    expect(row?.session_id).not.toBe(rawToken);

    const [effects] = await sql<
      {
        first_owner_claimed: boolean;
        outbox_count: number;
        audit_count: number;
        audit_hash_bytes: number;
      }[]
    >`
      SELECT
        (SELECT first_owner_claimed FROM panel_meta WHERE id = 1) AS first_owner_claimed,
        (
          SELECT count(*)::int
          FROM admins_cfg_sync_outbox
          WHERE server_id = ${serverId}
            AND payload->>'reason' = 'owner.session.recovery'
        ) AS outbox_count,
        (
          SELECT count(*)::int
          FROM audit_log
          WHERE action_type = 'owner.session.recovery'
            AND target_id = ${row?.player_id}
        ) AS audit_count,
        (
          SELECT octet_length(row_hash)::int
          FROM audit_log
          WHERE action_type = 'owner.session.recovery'
            AND target_id = ${row?.player_id}
          ORDER BY id DESC
          LIMIT 1
        ) AS audit_hash_bytes
    `;
    expect(effects).toEqual({
      first_owner_claimed: true,
      outbox_count: 1,
      audit_count: 1,
      audit_hash_bytes: 32,
    });
    const [publicEvidence] = await sql<{ contains_raw_token: boolean }[]>`
      SELECT (
        coalesce((SELECT string_agg(payload::text, '') FROM admins_cfg_sync_outbox), '') ||
        coalesce((SELECT string_agg(context::text || coalesce(after_snapshot::text, ''), '') FROM audit_log), '')
      ) LIKE ${`%${rawToken}%`} AS contains_raw_token
    `;
    expect(publicEvidence?.contains_raw_token).toBe(false);
  });

  it('reuses an existing player without overwriting identity and clears a stale role expiry', async () => {
    const [existing] = await sql<{ id: string }[]>`
      INSERT INTO players (
        steam_id64,
        canonical_name,
        canonical_name_normalized,
        role_id,
        role_expires_at,
        role_comment
      ) VALUES (
        ${EXISTING_PLAYER_STEAM_ID},
        'Old name',
        'old name',
        NULL,
        now() + interval '1 hour',
        'stale assignment'
      )
      ON CONFLICT (steam_id64) DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        canonical_name_normalized = EXCLUDED.canonical_name_normalized,
        role_id = EXCLUDED.role_id,
        role_expires_at = EXCLUDED.role_expires_at,
        role_comment = EXCLUDED.role_comment
      RETURNING id
    `;
    if (!existing) throw new Error('failed to seed existing player');

    const result = await runCommand(
      [
        '--steam-id64',
        EXISTING_PLAYER_STEAM_ID,
        '--confirm-steam-id64',
        EXISTING_PLAYER_STEAM_ID,
        '--name',
        '  <MDC> Operator supplied name  ',
      ],
      { DATABASE_URL: databaseUrl },
    );

    expect(result.status, result.stderr).toBe(0);
    const [player] = await sql<
      {
        id: string;
        canonical_name: string;
        canonical_name_normalized: string;
        role_id: string;
        role_expires_at: Date | null;
        role_comment: string | null;
        session_count: number;
      }[]
    >`
      SELECT
        p.id,
        p.canonical_name,
        p.canonical_name_normalized,
        p.role_id,
        p.role_expires_at,
        p.role_comment,
        count(s.id)::int AS session_count
      FROM players p
      JOIN sessions s ON s.player_id = p.id
      WHERE p.steam_id64 = ${EXISTING_PLAYER_STEAM_ID}
      GROUP BY p.id
    `;

    expect(player).toEqual({
      id: existing.id,
      canonical_name: 'Old name',
      canonical_name_normalized: 'old name',
      role_id: ownerRoleId,
      role_expires_at: null,
      role_comment: null,
      session_count: 1,
    });
  });
});
