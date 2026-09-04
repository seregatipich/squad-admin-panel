import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createIsolatedSchema } from '../apps/api/test/integration/isolated-db.ts';
import { provisionSiteVipTier } from './provision-site-vip-tier.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const requireFromApi = createRequire(path.join(REPOSITORY_ROOT, 'apps/api/package.json'));
const postgres = requireFromApi('postgres');
const WORKFLOW = readFileSync(
  path.join(REPOSITORY_ROOT, '.github/workflows/deploy-tk104.yml'),
  'utf8',
);
const databases: Array<{ drop: () => Promise<void> }> = [];

async function database() {
  const isolated = await createIsolatedSchema();
  databases.push(isolated);
  return postgres(isolated.url, { max: 1, onnotice: () => undefined });
}

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('provision-site-vip-tier', () => {
  it('операторская операция привязана к точному master и закреплённому SSH-доверию', () => {
    assert.match(WORKFLOW, /options: \[[^\]]*site-vip-tier[^\]]*\]/);
    const section = WORKFLOW.slice(
      WORKFLOW.indexOf('  provision-site-vip-tier:'),
      WORKFLOW.indexOf('  revoke-sessions-for-sso-cutover:'),
    );
    assert.match(section, /github\.event\.inputs\.target == 'site-vip-tier'/);
    assert.match(section, /"\$\{GITHUB_REF\}" != "refs\/heads\/master"/);
    assert.match(section, /"\$\{EXPECTED_SHA\}" != "\$\{GITHUB_SHA\}"/);
    assert.match(section, /StrictHostKeyChecking=yes/);
    assert.match(section, /BSS_PROVISION_SITE_VIP_TIER_RUN=1/);
    assert.match(section, /api\/v1\/integrations\/vip\/tier-role/);
    assert.doesNotMatch(section, /ssh-keyscan|accept-new/);
  });

  it('связывает сайт только со штатной ролью QueuePriority без второго магазина', async () => {
    const sql = await database();
    try {
      const result = await provisionSiteVipTier(sql);
      const rows = await sql`
        SELECT
          tier.id,
          tier.name,
          tier.default_days,
          tier.price_bonuses,
          tier.is_active,
          role.id AS role_id,
          role.name AS role_name,
          role.panel_access,
          role.is_system_role
        FROM vip_tiers tier
        JOIN roles role ON role.id = tier.role_id
      `;
      const audit = await sql`
        SELECT actor_system_label, action_type, target_type, target_id, after_snapshot, context
        FROM audit_log
        WHERE action_type = 'site.vip_tier.provision'
      `;

      assert.equal(result.status, 'changed');
      assert.equal(result.roleId, rows[0]?.role_id);
      assert.equal(result.tierCode, rows[0]?.id);
      assert.deepEqual(rows[0], {
        id: result.tierCode,
        name: 'BSS VIP',
        default_days: null,
        price_bonuses: null,
        is_active: true,
        role_id: result.roleId,
        role_name: 'QueuePriority',
        panel_access: false,
        is_system_role: false,
      });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.actor_system_label, 'provision-site-vip-tier');
      assert.equal(audit[0]?.action_type, 'site.vip_tier.provision');
      assert.equal(audit[0]?.target_type, 'vip_tier');
      assert.equal(audit[0]?.target_id, result.tierCode);
      assert.deepEqual(audit[0]?.after_snapshot, {
        role: 'QueuePriority',
        state: 'active',
        source: 'bss.games',
      });
      assert.deepEqual(audit[0]?.context, { source: 'operator-command' });
    } finally {
      await sql.end();
    }
  });

  it('повтор не меняет каталог и не дублирует аудит', async () => {
    const sql = await database();
    try {
      const first = await provisionSiteVipTier(sql);
      const second = await provisionSiteVipTier(sql);
      const [{ tiers }] = await sql`SELECT count(*)::int AS tiers FROM vip_tiers`;
      const [{ audits }] = await sql`
        SELECT count(*)::int AS audits
        FROM audit_log
        WHERE action_type = 'site.vip_tier.provision'
      `;

      assert.deepEqual(second, { ...first, status: 'unchanged' });
      assert.equal(tiers, 1);
      assert.equal(audits, 1);
    } finally {
      await sql.end();
    }
  });

  it('закрывается при конкурирующем активном VIP-тарифе', async () => {
    const sql = await database();
    try {
      const roleId = randomUUID();
      await sql`
        INSERT INTO roles (id, name, panel_access, is_system_role)
        VALUES (${roleId}, 'Другой безопасный VIP', false, false)
      `;
      await sql`
        INSERT INTO vip_tiers (id, name, role_id, is_active)
        VALUES (${randomUUID()}, 'Другой VIP', ${roleId}, true)
      `;

      await assert.rejects(
        () => provisionSiteVipTier(sql),
        /активный VIP-тариф уже использует другую роль/i,
      );
      const [{ audits }] = await sql`
        SELECT count(*)::int AS audits
        FROM audit_log
        WHERE action_type = 'site.vip_tier.provision'
      `;
      assert.equal(audits, 0);
    } finally {
      await sql.end();
    }
  });

  it('не использует роль QueuePriority с расширенными правами', async () => {
    const sql = await database();
    try {
      await sql`UPDATE roles SET panel_access = true WHERE name = 'QueuePriority'`;
      await assert.rejects(() => provisionSiteVipTier(sql), /роль QueuePriority небезопасна/i);
      const [{ tiers }] = await sql`SELECT count(*)::int AS tiers FROM vip_tiers`;
      assert.equal(tiers, 0);
    } finally {
      await sql.end();
    }
  });
});
