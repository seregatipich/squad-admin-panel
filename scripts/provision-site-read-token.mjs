import { createHash } from 'node:crypto';

const TOKEN_NAME = 'bss.games: проверка доступа';
const TOKEN_SCOPES = ['user:view', 'role:view'];
const TOKEN_PATTERN =
  /^sqp_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{16,})$/i;
const LOCK_NAME = 'provision-site-read-token';

export function parseSiteReadToken(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.trim() !== plaintext) {
    throw new Error('Неверный формат ключа чтения сайта.');
  }
  const match = plaintext.match(TOKEN_PATTERN);
  if (!match) throw new Error('Неверный формат ключа чтения сайта.');
  return {
    id: match[1].toLowerCase(),
    tokenHash: createHash('sha256').update(plaintext).digest('base64url'),
  };
}

export async function provisionSiteReadToken(sql, plaintext) {
  const token = parseSiteReadToken(plaintext);

  return sql.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0))
    `;

    const owners = await transaction`
      SELECT p.id
      FROM players p
      JOIN roles r ON r.id = p.role_id
      WHERE r.name = 'Owner'
        AND r.is_system_role = true
        AND (p.role_expires_at IS NULL OR p.role_expires_at > now())
      ORDER BY p.id
      LIMIT 2
      FOR UPDATE OF p
    `;
    if (owners.length !== 1) {
      throw new Error('Для выпуска ключа требуется ровно один действующий Owner.');
    }

    const ownerId = owners[0].id;
    const [current] = await transaction`
      SELECT id, player_id, name, token_hash, scopes, revoked_at
      FROM player_api_tokens
      WHERE id = ${token.id}
      FOR UPDATE
    `;
    if (
      current &&
      (current.player_id !== ownerId ||
        current.name !== TOKEN_NAME ||
        current.token_hash !== token.tokenHash ||
        JSON.stringify(current.scopes) !== JSON.stringify(TOKEN_SCOPES))
    ) {
      throw new Error('Идентификатор ключа уже занят другим назначением.');
    }

    const revoked = await transaction`
      UPDATE player_api_tokens
      SET revoked_at = now()
      WHERE name = ${TOKEN_NAME}
        AND revoked_at IS NULL
        AND id <> ${token.id}
      RETURNING id
    `;

    let changed = revoked.length > 0;
    if (!current) {
      await transaction`
        INSERT INTO player_api_tokens (
          id,
          player_id,
          name,
          token_hash,
          scopes
        ) VALUES (
          ${token.id},
          ${ownerId},
          ${TOKEN_NAME},
          ${token.tokenHash},
          ${transaction.array(TOKEN_SCOPES)}
        )
      `;
      changed = true;
    } else if (current.revoked_at !== null) {
      await transaction`
        UPDATE player_api_tokens
        SET revoked_at = NULL
        WHERE id = ${token.id}
      `;
      changed = true;
    }

    if (changed) {
      await transaction`
        INSERT INTO audit_log (
          actor_kind,
          actor_system_label,
          action_type,
          target_type,
          target_id,
          after_snapshot,
          context,
          status_code,
          row_hash
        ) VALUES (
          'system',
          'provision-site-read-token',
          'site.read_token.provision',
          'api_token',
          ${token.id},
          ${transaction.json({ scopes: TOKEN_SCOPES, status: 'active' })},
          ${transaction.json({
            revoked_tokens: revoked.length,
            source: 'operator-command',
          })},
          200,
          ${Buffer.alloc(0)}
        )
      `;
    }

    return {
      status: changed ? 'changed' : 'unchanged',
      revokedTokens: revoked.length,
    };
  });
}

async function runCli() {
  const plaintext = process.env.SITE_PANEL_READ_TOKEN ?? '';
  parseSiteReadToken(plaintext);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL не задан.');

  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const result = await provisionSiteReadToken(sql, plaintext);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await sql.end();
  }
}

if (process.env.BSS_PROVISION_SITE_READ_TOKEN_RUN === '1') {
  runCli().catch((error) => {
    const knownMessage =
      error instanceof Error &&
      [
        'Неверный формат ключа чтения сайта.',
        'Для выпуска ключа требуется ровно один действующий Owner.',
        'Идентификатор ключа уже занят другим назначением.',
        'DATABASE_URL не задан.',
      ].includes(error.message)
        ? error.message
        : 'Не удалось безопасно выпустить ключ чтения сайта.';
    process.stderr.write(`${knownMessage}\n`);
    process.exitCode = 1;
  });
}
