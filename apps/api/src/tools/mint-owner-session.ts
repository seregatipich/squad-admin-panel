import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { normalizePlayerName } from '@squad/shared-config';
import postgres from 'postgres';
import { mintSessionToken } from '../lib/sessions.js';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const STEAM_ID64_RE = /^\d{17}$/u;
const MAX_PLAYER_NAME_LENGTH = 128;

interface MintOwnerSessionInput {
  databaseUrl: string;
  steamId64: string;
  canonicalName: string;
}

type CliOptions = { help: true } | { help: false; steamId64: string; canonicalName: string };

export const MINT_OWNER_SESSION_USAGE = `Usage:
  pnpm --silent mint:owner-session -- --steam-id64 <17 digits> \\
    --confirm-steam-id64 <same 17 digits> --name <player name>

The command promotes the player to the system Owner role and prints a new
six-hour panel session token to stdout. DATABASE_URL must point at the target
database. Treat the printed token as a secret.`;

export function parseMintOwnerSessionArgs(args: string[]): CliOptions {
  // pnpm 9 preserves the conventional argument separator when invoking a
  // package script (`pnpm <script> -- --flag`). Node's parseArgs treats that
  // separator as the end of options, so remove exactly one leading marker.
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const { values } = parseArgs({
    args: normalizedArgs,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'steam-id64': { type: 'string' },
      'confirm-steam-id64': { type: 'string' },
      name: { type: 'string' },
    },
  });

  if (values.help) return { help: true };

  const steamId64 = values['steam-id64']?.trim();
  if (!steamId64 || !STEAM_ID64_RE.test(steamId64)) {
    throw new Error('SteamID64 must contain exactly 17 digits');
  }
  if (values['confirm-steam-id64']?.trim() !== steamId64) {
    throw new Error('--confirm-steam-id64 must exactly match --steam-id64');
  }

  const canonicalName = values.name?.trim();
  if (!canonicalName) throw new Error('player name must not be empty');
  if (canonicalName.length > MAX_PLAYER_NAME_LENGTH) {
    throw new Error(`player name must be at most ${MAX_PLAYER_NAME_LENGTH} characters`);
  }
  if (
    Array.from(canonicalName).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error('player name must not contain control characters');
  }

  return { help: false, steamId64, canonicalName };
}

export async function mintOwnerSession(input: MintOwnerSessionInput): Promise<string> {
  const sql = postgres(input.databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
  });

  try {
    const { token, tokenId } = mintSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const canonicalNameNormalized = normalizePlayerName(input.canonicalName);

    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext('panel_first_owner'))`;

      const [ownerRole] = await transaction<{ id: string }[]>`
        SELECT id
        FROM roles
        WHERE name = 'Owner' AND is_system_role = true
        LIMIT 1
      `;
      if (!ownerRole) {
        throw new Error('system Owner role is missing; apply database migrations first');
      }

      const [beforePlayer] = await transaction<
        {
          id: string;
          role_id: string | null;
          role_expires_at: Date | null;
          role_comment: string | null;
        }[]
      >`
        SELECT id, role_id, role_expires_at, role_comment
        FROM players
        WHERE steam_id64 = ${input.steamId64}
        FOR UPDATE
      `;

      const [player] = await transaction<{ id: string }[]>`
        INSERT INTO players (
          steam_id64,
          canonical_name,
          canonical_name_normalized,
          role_id,
          role_expires_at,
          role_comment,
          role_lifecycle_event_id
        ) VALUES (
          ${input.steamId64},
          ${input.canonicalName},
          ${canonicalNameNormalized},
          ${ownerRole.id},
          NULL,
          NULL,
          NULL
        )
        ON CONFLICT (steam_id64) DO UPDATE SET
          role_id = EXCLUDED.role_id,
          role_expires_at = NULL,
          role_comment = NULL,
          role_lifecycle_event_id = NULL,
          updated_at = now()
        RETURNING id
      `;
      if (!player) throw new Error('database did not return the promoted player');

      await transaction`
        UPDATE panel_meta
        SET first_owner_claimed = true
        WHERE id = 1
      `;

      await transaction`
        INSERT INTO admins_cfg_sync_outbox (server_id, payload)
        SELECT
          id,
          jsonb_build_object(
            'reason', 'owner.session.recovery',
            'actor_player_id', NULL,
            'enqueued_at', ${now.toISOString()}::text
          )
        FROM servers
        WHERE deleted_at IS NULL
      `;

      await transaction`
        INSERT INTO sessions (
          id,
          player_id,
          expires_at,
          last_activity_at,
          ip,
          user_agent,
          scope
        ) VALUES (
          ${tokenId},
          ${player.id},
          ${expiresAt},
          ${now},
          NULL,
          'mint-owner-session',
          'panel'
        )
      `;

      const beforeSnapshot = beforePlayer
        ? {
            role_id: beforePlayer.role_id,
            role_expires_at: beforePlayer.role_expires_at?.toISOString() ?? null,
            role_comment: beforePlayer.role_comment,
          }
        : null;
      const afterSnapshot = {
        role_id: ownerRole.id,
        role_expires_at: null,
        role_comment: null,
        session_expires_at: expiresAt.toISOString(),
      };

      await transaction`
        INSERT INTO audit_log (
          actor_kind,
          actor_system_label,
          action_type,
          target_type,
          target_id,
          before_snapshot,
          after_snapshot,
          context,
          status_code,
          row_hash
        ) VALUES (
          'system',
          'mint-owner-session',
          'owner.session.recovery',
          'player',
          ${player.id},
          ${transaction.json(beforeSnapshot)},
          ${transaction.json(afterSnapshot)},
          ${transaction.json({ source: 'operator-command' })},
          200,
          ${Buffer.alloc(0)}
        )
      `;
    });

    return token;
  } finally {
    await sql.end();
  }
}

export async function runMintOwnerSessionCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const options = parseMintOwnerSessionArgs(args);
  if (options.help) return null;

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  return mintOwnerSession({
    databaseUrl,
    steamId64: options.steamId64,
    canonicalName: options.canonicalName,
  });
}

async function main(): Promise<void> {
  try {
    const token = await runMintOwnerSessionCli(process.argv.slice(2));
    process.stdout.write(`${token ?? MINT_OWNER_SESSION_USAGE}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`mint-owner-session: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
