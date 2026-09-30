/**
 * seed-demo.ts — populates a LOCAL dev database with example data so the
 * panel isn't empty, and mints a session that logs you in as an Owner
 * without going through real Steam OAuth.
 *
 * Idempotent: safe to rerun (upserts by steam_id64 / slug, mints a fresh
 * session token each time).
 *
 * Local dev only, and enforced: the script refuses to run under
 * `NODE_ENV=production` or against a database host other than localhost,
 * 127.0.0.1, ::1 or the compose service `postgres` (set
 * `SEED_DEMO_ALLOW_REMOTE=1` for a disposable remote dev database). It is also
 * excluded from the package build (`tsconfig.build.json`), so it never reaches
 * `dist/` or the API image — run it from source with tsx.
 *
 * Usage: DATABASE_URL=postgres://... pnpm --filter @squad/db seed:demo
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/** Database hosts the seeder accepts without `SEED_DEMO_ALLOW_REMOTE=1`. */
const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'postgres',
]);

/**
 * The demo Owner's SteamID. It sits below 76561197960265728, the first
 * individual Steam64 ID, so no real Steam account can ever sign in as it.
 */
export const DEMO_ADMIN_STEAM_ID = 76561190000000001n;
const DEMO_PLAYERS: Array<{ steamId: bigint; name: string }> = [
  { steamId: 76561190000000002n, name: 'PineappleOnPizza' },
  { steamId: 76561190000000003n, name: 'GrumpyMedic' },
  { steamId: 76561190000000004n, name: 'SlowLoris_RU' },
  { steamId: 76561190000000005n, name: 'НочнойДозор' },
  { steamId: 76561190000000006n, name: 'xX_Sniper_Xx' },
];

/**
 * Decides whether the seeder may run against the environment it was given.
 *
 * @param env The process environment (`DATABASE_URL`, `NODE_ENV`, `SEED_DEMO_ALLOW_REMOTE`).
 * @returns `null` when seeding is allowed, otherwise the reason it is refused.
 */
export function seedDemoRefusal(env: NodeJS.ProcessEnv): string | null {
  const url = env.DATABASE_URL;
  if (!url) return 'DATABASE_URL is required';
  if (env.NODE_ENV === 'production') {
    return 'NODE_ENV=production: demo data and an Owner bypass session never belong in production';
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'DATABASE_URL is not a valid URL';
  }
  if (!LOCAL_DATABASE_HOSTS.has(host) && env.SEED_DEMO_ALLOW_REMOTE !== '1') {
    return `database host "${host}" is not local; set SEED_DEMO_ALLOW_REMOTE=1 if it is a disposable dev database`;
  }
  return null;
}

async function main(url: string) {
  const sql = postgres(url, { max: 1 });

  const ownerRole = await sql`
    SELECT id FROM roles WHERE name = 'Owner' AND is_system_role = true LIMIT 1
  `;
  if (!ownerRole[0]) {
    console.error('Owner role not found — run `pnpm db:migrate` first');
    process.exit(1);
  }
  const ownerRoleId = ownerRole[0].id as string;

  const adminRows = await sql`
    INSERT INTO players (
      steam_id64, canonical_name, canonical_name_normalized,
      role_id, role_expires_at, role_comment
    )
    VALUES (
      ${DEMO_ADMIN_STEAM_ID.toString()}, 'Local Test Admin', 'local test admin',
      ${ownerRoleId}, NULL, NULL
    )
    ON CONFLICT (steam_id64) DO UPDATE SET
      role_id = ${ownerRoleId},
      role_expires_at = NULL,
      role_comment = NULL
    RETURNING id
  `;
  if (!adminRows[0]) throw new Error('admin player upsert returned no row');
  const adminId = adminRows[0].id as string;

  await sql`
    UPDATE panel_meta
    SET first_owner_claimed = true,
        setup_completed = true,
        organization_name = CASE WHEN organization_name = '' THEN 'Local Dev Squad'
                                 ELSE organization_name END
    WHERE id = 1
  `;

  for (const p of DEMO_PLAYERS) {
    await sql`
      INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized)
      VALUES (${p.steamId.toString()}, ${p.name}, ${p.name.toLowerCase()})
      ON CONFLICT (steam_id64) DO NOTHING
    `;
  }

  // status stays 'pending' — a fake "healthy" row would be misleading, and
  // most server-management code paths assume a live host-bridge connection.
  await sql`
    INSERT INTO servers (id, display_name, slug, status)
    VALUES (${randomUUID()}, 'Demo Server EU#1', 'demo-server-eu-1', 'pending')
    ON CONFLICT (slug) WHERE deleted_at IS NULL DO NOTHING
  `;

  const token = `s_${randomUUID()}_${randomBytes(24).toString('base64url')}`;
  const tokenId = createHash('sha256').update(token).digest('base64url');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await sql`
    INSERT INTO sessions (id, player_id, expires_at, last_activity_at, ip, user_agent, scope)
    VALUES (${tokenId}, ${adminId}, ${expiresAt}, now(), '127.0.0.1', 'seed-demo', 'panel')
  `;

  console.log('');
  console.log('✓ Demo data seeded.');
  console.log(`  Admin: Local Test Admin (Owner role), steam_id64=${DEMO_ADMIN_STEAM_ID}`);
  console.log(`  + ${DEMO_PLAYERS.length} example players, 1 pending demo server.`);
  console.log('');
  console.log('To log in without Steam, add a cookie manually in your browser');
  console.log('(DevTools → Application → Storage → Cookies → your panel origin):');
  console.log('  name:    __Host-sid');
  console.log(`  value:   ${token}`);
  console.log('  path:    /');
  console.log('  HttpOnly + Secure: both checked');
  console.log('');
  console.log('Reload the page — you are now logged in as the Owner.');
  console.log('Session expires in 24h; rerun this script for a fresh one.');

  await sql.end();
}

function isMainEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  const refusal = seedDemoRefusal(process.env);
  if (refusal) {
    console.error(`seed-demo: refusing to seed demo data — ${refusal}`);
    process.exit(1);
  }
  main(process.env.DATABASE_URL as string).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
