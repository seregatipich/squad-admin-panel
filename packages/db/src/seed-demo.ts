/**
 * seed-demo.ts — populates a LOCAL dev database with example data so the
 * panel isn't empty, and mints a session that logs you in as an Owner
 * without going through real Steam OAuth.
 *
 * Idempotent: safe to rerun (upserts by steam_id64 / slug, mints a fresh
 * session token each time).
 *
 * NEVER point this at a production DATABASE_URL — it inserts fabricated
 * players and a bypass session. Local dev only.
 *
 * Usage: DATABASE_URL=postgres://... pnpm --filter @squad/db seed:demo
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const ADMIN_STEAM_ID = 76561198000000001n;
const DEMO_PLAYERS: Array<{ steamId: bigint; name: string }> = [
  { steamId: 76561198000000002n, name: 'PineappleOnPizza' },
  { steamId: 76561198000000003n, name: 'GrumpyMedic' },
  { steamId: 76561198000000004n, name: 'SlowLoris_RU' },
  { steamId: 76561198000000005n, name: 'НочнойДозор' },
  { steamId: 76561198000000006n, name: 'xX_Sniper_Xx' },
];

async function main() {
  const sql = postgres(url as string, { max: 1 });

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
      ${ADMIN_STEAM_ID.toString()}, 'Local Test Admin', 'local test admin',
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
    SET first_owner_claimed = true, setup_completed = true, organization_name = 'Local Dev Squad'
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
  console.log(`  Admin: Local Test Admin (Owner role), steam_id64=${ADMIN_STEAM_ID}`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
