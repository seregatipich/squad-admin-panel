import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROLE_NAME = 'QueuePriority';
const TIER_NAME = 'BSS VIP';
const LOCK_NAME = 'vip-lifecycle-writer-fence';

export async function provisionSiteVipTier(sql) {
  return sql.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0))
    `;

    const roles = await transaction`
      SELECT id, name, panel_access, is_system_role
      FROM roles
      WHERE name = ${ROLE_NAME}
      ORDER BY id
      LIMIT 2
      FOR UPDATE
    `;
    if (roles.length !== 1) {
      throw new Error('Требуется ровно одна штатная роль QueuePriority.');
    }
    const role = roles[0];
    const permissions = await transaction`
      SELECT squad_permission_key
      FROM role_squad_permissions
      WHERE role_id = ${role.id}
      ORDER BY squad_permission_key
    `;
    if (
      role.panel_access !== false ||
      role.is_system_role !== false ||
      permissions.length !== 1 ||
      permissions[0]?.squad_permission_key !== 'reserve'
    ) {
      throw new Error('Роль QueuePriority небезопасна для автоматической привязки.');
    }

    const active = await transaction`
      SELECT
        tier.id,
        tier.name,
        tier.role_id,
        tier.default_days,
        tier.price_bonuses,
        role.panel_access,
        role.is_system_role
      FROM vip_tiers tier
      JOIN roles role ON role.id = tier.role_id
      WHERE tier.is_active = true
      ORDER BY tier.id
      LIMIT 2
      FOR UPDATE OF tier
    `;
    if (active.length > 0) {
      const current = active[0];
      if (
        active.length !== 1 ||
        current.role_id !== role.id ||
        current.name !== TIER_NAME ||
        current.default_days !== null ||
        current.price_bonuses !== null ||
        current.panel_access !== false ||
        current.is_system_role !== false
      ) {
        throw new Error('Активный VIP-тариф уже использует другую роль или назначение.');
      }
      return { status: 'unchanged', roleId: role.id, tierCode: current.id };
    }

    const collisions = await transaction`
      SELECT id
      FROM vip_tiers
      WHERE role_id = ${role.id} OR name = ${TIER_NAME}
      ORDER BY id
      LIMIT 1
      FOR UPDATE
    `;
    if (collisions.length > 0) {
      throw new Error('Выключенная VIP-привязка требует решения владельца.');
    }

    const tierCode = randomUUID();
    await transaction`
      INSERT INTO vip_tiers (
        id,
        name,
        role_id,
        description,
        default_days,
        price_bonuses,
        sort_order,
        is_active
      ) VALUES (
        ${tierCode},
        ${TIER_NAME},
        ${role.id},
        'Внешняя покупка на bss.games; панель владеет только серверной ролью.',
        NULL,
        NULL,
        0,
        true
      )
    `;
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
        'provision-site-vip-tier',
        'site.vip_tier.provision',
        'vip_tier',
        ${tierCode},
        ${transaction.json({ role: ROLE_NAME, state: 'active', source: 'bss.games' })},
        ${transaction.json({ source: 'operator-command' })},
        200,
        ${Buffer.alloc(0)}
      )
    `;

    return { status: 'changed', roleId: role.id, tierCode };
  });
}

async function runCli() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL не задан.');

  const requireFromDatabasePackage = createRequire(
    path.resolve(process.cwd(), '../../packages/db/package.json'),
  );
  const postgres = requireFromDatabasePackage('postgres');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const result = await provisionSiteVipTier(sql);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await sql.end();
  }
}

if (process.env.BSS_PROVISION_SITE_VIP_TIER_RUN === '1') {
  runCli().catch((error) => {
    const knownMessages = new Set([
      'DATABASE_URL не задан.',
      'Требуется ровно одна штатная роль QueuePriority.',
      'Роль QueuePriority небезопасна для автоматической привязки.',
      'Активный VIP-тариф уже использует другую роль или назначение.',
      'Выключенная VIP-привязка требует решения владельца.',
    ]);
    const message =
      error instanceof Error && knownMessages.has(error.message)
        ? error.message
        : 'Не удалось безопасно подготовить VIP-привязку сайта.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
