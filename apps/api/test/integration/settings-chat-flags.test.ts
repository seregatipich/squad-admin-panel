import { chatFlagRules, chatMessages, players, roles, servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000044551n;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, seedOwnerGuard: true });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function asRole(flags: { panelAccess: boolean; canEditRoles: boolean }): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `Custom-${roleId}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: flags.panelAccess,
    canEditRoles: flags.canEditRoles,
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded in beforeEach
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded in beforeEach
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

function post(cookie: string, path: string, payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: path,
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });
}

describe('GET /api/v1/settings/chat-flag-rules', () => {
  it('returns the seeded default rules for a panel admin', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/chat-flag-rules',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; can_mutate: boolean };
    expect(body.items.length).toBeGreaterThanOrEqual(12);
    expect(body.can_mutate).toBe(true);
  });

  it('rejects a user without panel access', async () => {
    const cookie = await asRole({ panelAccess: false, canEditRoles: false });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/chat-flag-rules',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a panel viewer to list but marks can_mutate false', async () => {
    const cookie = await asRole({ panelAccess: true, canEditRoles: false });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/chat-flag-rules',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { can_mutate: boolean }).can_mutate).toBe(false);
  });
});

describe('chat-flag-rules mutations', () => {
  it('creates a rule and writes an audit entry with before/after', async () => {
    const cookie = await loginAsOwner(h);
    const res = await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: 'skibidi',
      pattern_type: 'word',
      locale: 'en',
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string; pattern: string };
    expect(created.pattern).toBe('skibidi');

    const audit = await assertAuditRow(h, {
      action: 'chat_flag_rule.create',
      resource: 'chat_flag_rule',
      targetId: created.id,
    });
    expect(audit.beforeSnapshot).toBeNull();
    expect((audit.afterSnapshot as { pattern: string }).pattern).toBe('skibidi');
  });

  it('records before/after snapshots on update', async () => {
    const cookie = await loginAsOwner(h);
    const create = await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: 'gyatt',
      pattern_type: 'word',
    });
    const ruleId = (create.json() as { id: string }).id;

    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/settings/chat-flag-rules/${ruleId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);

    const audit = await assertAuditRow(h, {
      action: 'chat_flag_rule.update',
      resource: 'chat_flag_rule',
      targetId: ruleId,
    });
    expect((audit.beforeSnapshot as { enabled: boolean }).enabled).toBe(true);
    expect((audit.afterSnapshot as { enabled: boolean }).enabled).toBe(false);
  });

  it('rejects a catastrophic-backtracking regex with 422', async () => {
    const cookie = await loginAsOwner(h);
    const res = await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: '(a+)+$',
      pattern_type: 'regex',
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('invalid_pattern');
  });

  it('rejects duplicate rules with 409', async () => {
    const cookie = await loginAsOwner(h);
    const first = await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: 'dupword',
      pattern_type: 'word',
      locale: 'all',
    });
    expect(first.statusCode).toBe(201);
    const second = await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: 'dupword',
      pattern_type: 'word',
      locale: 'all',
    });
    expect(second.statusCode).toBe(409);
  });

  it('forbids mutations for a panel viewer without can_edit_roles', async () => {
    const cookie = await asRole({ panelAccess: true, canEditRoles: false });
    const res = await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: 'nope',
      pattern_type: 'word',
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { required: string }).required).toBe('can_edit_roles');
  });
});

describe('POST /api/v1/settings/chat-flag-rules/reindex', () => {
  async function seedMessage(message: string): Promise<{ serverId: string; playerId: string }> {
    const serverId = uuidv7();
    const playerId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Reindex Server',
      slug: `reindex-${serverId}`,
    });
    await h.db.insert(players).values({
      id: playerId,
      canonicalName: 'Reindex Player',
      canonicalNameNormalized: 'reindex player',
    });
    await h.db.insert(chatMessages).values({
      playerId,
      serverId,
      sentAt: new Date(),
      scope: 'all',
      message,
      source: 'log',
      isFlagged: false,
    });
    return { serverId, playerId };
  }

  it('flags existing messages and is idempotent on a second run', async () => {
    const cookie = await loginAsOwner(h);
    const { playerId } = await seedMessage('please stop the frobnicate spam');
    await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: 'frobnicate',
      pattern_type: 'word',
      locale: 'all',
    });

    const first = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 30 });
    expect(first.statusCode).toBe(200);
    const firstSummary = first.json() as { scanned: number; flagged: number; changed: number };
    expect(firstSummary.changed).toBeGreaterThanOrEqual(1);
    expect(firstSummary.flagged).toBeGreaterThanOrEqual(1);

    const flaggedRows = await h.db
      .select({ isFlagged: chatMessages.isFlagged, ruleId: chatMessages.matchedRuleId })
      .from(chatMessages)
      .where(eq(chatMessages.playerId, playerId));
    expect(flaggedRows[0]?.isFlagged).toBe(true);
    expect(flaggedRows[0]?.ruleId).not.toBeNull();

    const second = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 30 });
    const secondSummary = second.json() as { changed: number; flagged: number };
    expect(secondSummary.changed).toBe(0);
    expect(secondSummary.flagged).toBe(firstSummary.flagged);

    await assertAuditRow(h, { action: 'chat_flag_rule.reindex', resource: 'chat_flag_rule' });
  });

  it('reconciles a message flagged by a since-deleted rule back to unflagged', async () => {
    const cookie = await loginAsOwner(h);
    const { playerId } = await seedMessage('totally clean chatter here');
    const orphanRuleId = uuidv7();
    await h.db.insert(chatFlagRules).values({
      id: orphanRuleId,
      pattern: 'obsolete-token',
      patternType: 'word',
      locale: 'all',
      enabled: true,
    });
    await h.db
      .update(chatMessages)
      .set({ isFlagged: true, matchedRuleId: orphanRuleId })
      .where(eq(chatMessages.playerId, playerId));
    await h.db.delete(chatFlagRules).where(eq(chatFlagRules.id, orphanRuleId));

    const res = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 30 });
    expect(res.statusCode).toBe(200);
    const rows = await h.db
      .select({ isFlagged: chatMessages.isFlagged, ruleId: chatMessages.matchedRuleId })
      .from(chatMessages)
      .where(and(eq(chatMessages.playerId, playerId)));
    expect(rows[0]?.isFlagged).toBe(false);
    expect(rows[0]?.ruleId).toBeNull();
  });
});
