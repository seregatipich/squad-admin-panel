import { bannedNameRules, players, roleSquadPermissions, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000009103n;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function asViewer(): Promise<string> {
  const viewerRows = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Viewer'))
    .limit(1);
  const viewerRoleId = viewerRows[0]?.id;
  if (!viewerRoleId || !h.seed.ownerSteamId64) throw new Error('Viewer role missing');
  await h.db
    .update(players)
    .set({ roleId: viewerRoleId })
    .where(eq(players.steamId64, h.seed.ownerSteamId64));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

async function asBanOnlyRole(): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: 'Bannerman',
      color: 'red',
      isSystemRole: false,
      panelAccess: true,
    });
    await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: 'ban' });
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded above
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

async function createRule(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/banned-names',
    headers: { cookie },
    payload,
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('GET /api/v1/banned-names', () => {
  it('401 without cookie', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/banned-names' });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty list initially with can_mutate=true for owner', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number; can_mutate: boolean };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.can_mutate).toBe(true);
  });

  it('lists rules with author name and hits, filters by search/match_type/is_active', async () => {
    const cookie = await loginAsOwner(h);
    await createRule(cookie, { pattern: 'AdolfHitler', match_type: 'exact' });
    await createRule(cookie, { pattern: 'nigger', match_type: 'substring', is_active: false });
    await createRule(cookie, { pattern: '^\\[ISIS\\]', match_type: 'regex' });

    const all = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names',
      headers: { cookie },
    });
    const allBody = all.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(allBody.total).toBe(3);
    expect(allBody.items[0]?.author_name).toBe('Owner');

    const search = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names?search=isis',
      headers: { cookie },
    });
    expect((search.json() as { total: number }).total).toBe(1);

    const byType = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names?match_type=exact',
      headers: { cookie },
    });
    expect((byType.json() as { total: number }).total).toBe(1);

    const inactive = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names?is_active=false',
      headers: { cookie },
    });
    const inactiveBody = inactive.json() as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(inactiveBody.total).toBe(1);
    expect(inactiveBody.items[0]?.pattern).toBe('nigger');
  });

  it('paginates via page/page_size', async () => {
    const cookie = await loginAsOwner(h);
    for (let i = 0; i < 5; i++) {
      await createRule(cookie, { pattern: `rule-${i}`, match_type: 'exact' });
    }
    const page1 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names?page=1&page_size=2',
      headers: { cookie },
    });
    const body1 = page1.json() as { items: unknown[]; total: number };
    expect(body1.items).toHaveLength(2);
    expect(body1.total).toBe(5);
  });
});

describe('POST /api/v1/banned-names — three match types + audit', () => {
  it('creates an exact rule with audit_log row', async () => {
    const cookie = await loginAsOwner(h);
    const { statusCode, body } = await createRule(cookie, {
      pattern: 'BannedGuy',
      match_type: 'exact',
      reason: 'impersonation',
    });
    expect(statusCode).toBe(201);
    expect(body.match_type).toBe('exact');
    expect(body.action).toBe('kick');
    expect(body.is_active).toBe(true);
    expect(body.author_name).toBe('Owner');
    const audit = await assertAuditRow(h, {
      action: 'banned_name.create',
      resource: 'banned_name',
      targetId: body.id as string,
    });
    expect(audit.beforeSnapshot).toBeNull();
    expect((audit.afterSnapshot as { pattern: string }).pattern).toBe('BannedGuy');
  });

  it('creates a substring rule with audit_log row', async () => {
    const cookie = await loginAsOwner(h);
    const { statusCode, body } = await createRule(cookie, {
      pattern: 'clan',
      match_type: 'substring',
      action: 'alert',
    });
    expect(statusCode).toBe(201);
    expect(body.match_type).toBe('substring');
    expect(body.action).toBe('alert');
    await assertAuditRow(h, { action: 'banned_name.create', targetId: body.id as string });
  });

  it('creates a regex rule with audit_log row', async () => {
    const cookie = await loginAsOwner(h);
    const { statusCode, body } = await createRule(cookie, {
      pattern: '^\\[?ISIS\\]?',
      match_type: 'regex',
    });
    expect(statusCode).toBe(201);
    expect(body.match_type).toBe('regex');
    await assertAuditRow(h, { action: 'banned_name.create', targetId: body.id as string });
  });

  it('rejects empty pattern with 422', async () => {
    const cookie = await loginAsOwner(h);
    const { statusCode, body } = await createRule(cookie, { pattern: '', match_type: 'exact' });
    expect(statusCode).toBe(422);
    expect(body.error).toBe('invalid_pattern');
  });

  it('rejects whitespace-only pattern with 422', async () => {
    const cookie = await loginAsOwner(h);
    const { statusCode } = await createRule(cookie, { pattern: '   ', match_type: 'substring' });
    expect(statusCode).toBe(422);
  });

  it('rejects invalid regex with 422 and error detail', async () => {
    const cookie = await loginAsOwner(h);
    const { statusCode, body } = await createRule(cookie, {
      pattern: '([a-z',
      match_type: 'regex',
    });
    expect(statusCode).toBe(422);
    expect(body.error).toBe('invalid_pattern');
    expect(typeof body.detail).toBe('string');
    expect((body.detail as string).length).toBeGreaterThan(0);
  });

  it('rejects a pattern longer than 256 chars with 422', async () => {
    const cookie = await loginAsOwner(h);
    const { statusCode } = await createRule(cookie, {
      pattern: 'a'.repeat(257),
      match_type: 'substring',
    });
    expect(statusCode).toBe(422);
  });

  it('rejects duplicate (pattern, match_type) with 409', async () => {
    const cookie = await loginAsOwner(h);
    const first = await createRule(cookie, { pattern: 'dupe', match_type: 'exact' });
    expect(first.statusCode).toBe(201);
    const second = await createRule(cookie, { pattern: 'dupe', match_type: 'exact' });
    expect(second.statusCode).toBe(409);
    // same pattern, different match_type is allowed
    const third = await createRule(cookie, { pattern: 'dupe', match_type: 'substring' });
    expect(third.statusCode).toBe(201);
  });
});

describe('PATCH /api/v1/banned-names/:id', () => {
  it('edits a rule and writes audit before/after', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createRule(cookie, { pattern: 'oldpat', match_type: 'exact' });
    const id = created.body.id as string;
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/banned-names/${id}`,
      headers: { cookie },
      payload: { pattern: 'newpat', action: 'alert', is_active: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.pattern).toBe('newpat');
    expect(body.action).toBe('alert');
    expect(body.is_active).toBe(false);
    const audit = await assertAuditRow(h, { action: 'banned_name.update', targetId: id });
    expect((audit.beforeSnapshot as { pattern: string }).pattern).toBe('oldpat');
    expect((audit.afterSnapshot as { pattern: string }).pattern).toBe('newpat');
  });

  it('rejects switching to an invalid regex with 422', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createRule(cookie, { pattern: 'safe', match_type: 'exact' });
    const id = created.body.id as string;
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/banned-names/${id}`,
      headers: { cookie },
      payload: { pattern: '(unterminated', match_type: 'regex' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for unknown id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/banned-names/01939a8b-0000-7000-8000-000000000000',
      headers: { cookie },
      payload: { is_active: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/banned-names/:id', () => {
  it('deletes a rule and writes audit before/after', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createRule(cookie, { pattern: 'killme', match_type: 'exact' });
    const id = created.body.id as string;
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/banned-names/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const remaining = await h.db.select().from(bannedNameRules).where(eq(bannedNameRules.id, id));
    expect(remaining).toHaveLength(0);
    const audit = await assertAuditRow(h, { action: 'banned_name.delete', targetId: id });
    expect((audit.beforeSnapshot as { pattern: string }).pattern).toBe('killme');
    expect(audit.afterSnapshot).toBeNull();
  });

  it('returns 404 for unknown id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/banned-names/01939a8b-0000-7000-8000-000000000001',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('RBAC — squad-permission "ban" gate', () => {
  it('user without ban sees the list but is 403 on mutations', async () => {
    const ownerCookie = await loginAsOwner(h);
    const seeded = await createRule(ownerCookie, { pattern: 'seeded', match_type: 'exact' });
    const ruleId = seeded.body.id as string;

    const viewerCookie = await asViewer();

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names',
      headers: { cookie: viewerCookie },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { total: number; can_mutate: boolean };
    expect(listBody.total).toBe(1);
    expect(listBody.can_mutate).toBe(false);

    const post = await h.app.inject({
      method: 'POST',
      url: '/api/v1/banned-names',
      headers: { cookie: viewerCookie },
      payload: { pattern: 'nope', match_type: 'exact' },
    });
    expect(post.statusCode).toBe(403);

    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/banned-names/${ruleId}`,
      headers: { cookie: viewerCookie },
      payload: { is_active: false },
    });
    expect(patch.statusCode).toBe(403);

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/banned-names/${ruleId}`,
      headers: { cookie: viewerCookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it('non-owner role holding the ban squad-permission can mutate', async () => {
    const cookie = await asBanOnlyRole();
    const { statusCode, body } = await createRule(cookie, {
      pattern: 'ban-holder',
      match_type: 'exact',
    });
    expect(statusCode).toBe(201);
    expect(body.pattern).toBe('ban-holder');
  });
});

describe('GET /api/v1/banned-names/check — BANNAME-3 nick badge check', () => {
  it('401 without a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/banned-names/check?nick=x' });
    expect(res.statusCode).toBe(401);
  });

  it('matched:false with can_mutate=true for owner when no rule matches', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=CleanNick',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { matched: boolean; rule: unknown; can_mutate: boolean };
    expect(body.matched).toBe(false);
    expect(body.rule).toBeNull();
    expect(body.can_mutate).toBe(true);
  });

  it('matches an exact rule case-insensitively', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createRule(cookie, { pattern: 'AdolfHitler', match_type: 'exact' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=adolfhitler',
      headers: { cookie },
    });
    const body = res.json() as { matched: boolean; rule: { id: string; match_type: string } };
    expect(body.matched).toBe(true);
    expect(body.rule.id).toBe(created.body.id);
    expect(body.rule.match_type).toBe('exact');
  });

  it('matches a substring rule', async () => {
    const cookie = await loginAsOwner(h);
    await createRule(cookie, { pattern: 'isis', match_type: 'substring' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=xX_ISIS_Xx',
      headers: { cookie },
    });
    const body = res.json() as { matched: boolean; rule: { match_type: string } };
    expect(body.matched).toBe(true);
    expect(body.rule.match_type).toBe('substring');
  });

  it('matches a regex rule case-insensitively (parity with worker enforcement)', async () => {
    const cookie = await loginAsOwner(h);
    await createRule(cookie, { pattern: '^admin', match_type: 'regex' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=ADMIN_Bob',
      headers: { cookie },
    });
    const body = res.json() as { matched: boolean; rule: { match_type: string } };
    expect(body.matched).toBe(true);
    expect(body.rule.match_type).toBe('regex');
  });

  it('applies tier precedence: an exact rule wins over a substring rule on the same nick', async () => {
    const cookie = await loginAsOwner(h);
    await createRule(cookie, { pattern: 'bad', match_type: 'substring' });
    const exactRule = await createRule(cookie, { pattern: 'BadPlayer', match_type: 'exact' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=BadPlayer',
      headers: { cookie },
    });
    const body = res.json() as { matched: boolean; rule: { id: string } };
    expect(body.matched).toBe(true);
    expect(body.rule.id).toBe(exactRule.body.id);
  });

  it('ignores an inactive rule', async () => {
    const cookie = await loginAsOwner(h);
    await createRule(cookie, { pattern: 'Deactivated', match_type: 'exact', is_active: false });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=Deactivated',
      headers: { cookie },
    });
    const body = res.json() as { matched: boolean };
    expect(body.matched).toBe(false);
  });

  it('can_mutate is false for a role without the ban squad-permission', async () => {
    const viewerCookie = await asViewer();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=whatever',
      headers: { cookie: viewerCookie },
    });
    const body = res.json() as { can_mutate: boolean };
    expect(body.can_mutate).toBe(false);
  });

  it('badge lifecycle: create -> matched:true -> deactivate via PATCH -> matched:false, audited', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createRule(cookie, { pattern: 'LifecycleNick', match_type: 'exact' });
    const ruleId = created.body.id as string;

    const before = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=LifecycleNick',
      headers: { cookie },
    });
    expect((before.json() as { matched: boolean }).matched).toBe(true);

    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/banned-names/${ruleId}`,
      headers: { cookie },
      payload: { is_active: false },
    });
    expect(patch.statusCode).toBe(200);
    await assertAuditRow(h, { action: 'banned_name.update', targetId: ruleId });

    const after = await h.app.inject({
      method: 'GET',
      url: '/api/v1/banned-names/check?nick=LifecycleNick',
      headers: { cookie },
    });
    expect((after.json() as { matched: boolean }).matched).toBe(false);
  });
});
