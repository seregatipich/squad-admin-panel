import { chatFlagRules, chatMessages, players, roles, servers } from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_FLAG_REINDEX_LOCK_KEY, reindexChatFlags } from '../../src/lib/chat-flags.js';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { auditLogMark, expectAuditRowSince } from '../helpers/audit-since.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000044551n;

let h: IntegrationHarness;
let ownerRoleId: string;
let auditMark: bigint;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, seedOwnerGuard: true });
  const [ownerRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role missing');
  ownerRoleId = ownerRole.id;
});

beforeEach(async () => {
  // asRole() moves the seeded owner onto a narrower custom role; every case
  // starts back on Owner.
  await h.db
    .update(players)
    .set({ roleId: ownerRoleId })
    .where(eq(players.steamId64, OWNER_STEAM_ID));
  auditMark = await auditLogMark(h.db);
});

afterEach(() => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
});

afterAll(async () => {
  await h?.cleanup();
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
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded in beforeAll
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded in beforeAll
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

    await expectAuditRowSince(h.db, auditMark, {
      action: 'chat_flag_rule.reindex',
      resource: 'chat_flag_rule',
    });
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

  it('updates rows across keyset batch boundaries in one pass (#36 finding 18)', async () => {
    const cookie = await loginAsOwner(h);
    const { serverId, playerId } = await seedMessage('warm-up line');
    const base = Date.now() - 60_000;
    // More than one REINDEX batch (500), with identical sent_at ties at the boundary.
    await h.db.insert(chatMessages).values(
      Array.from({ length: 1_203 }, (_, i) => ({
        playerId,
        serverId,
        sentAt: new Date(base + Math.floor(i / 3)),
        scope: 'all',
        message: i % 2 === 0 ? `batchword number ${i}` : `clean number ${i}`,
        source: 'log',
        isFlagged: false,
      })),
    );
    await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: 'batchword',
      pattern_type: 'word',
      locale: 'all',
    });

    const res = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 1 });
    expect(res.statusCode).toBe(200);
    const flaggedCount = (await h.db.execute(sql`
      SELECT count(*)::int AS n FROM chat_messages
       WHERE player_id = ${playerId} AND is_flagged AND message LIKE 'batchword%'
    `)) as unknown as Array<{ n: number }>;
    expect(flaggedCount[0]?.n).toBe(602);
    const wrong = (await h.db.execute(sql`
      SELECT count(*)::int AS n FROM chat_messages
       WHERE player_id = ${playerId} AND is_flagged AND message NOT LIKE 'batchword%'
    `)) as unknown as Array<{ n: number }>;
    expect(wrong[0]?.n).toBe(0);
  });

  it('refuses a second reindex while one is running (#36 finding 18)', async () => {
    const cookie = await loginAsOwner(h);
    await h.redis.set(CHAT_FLAG_REINDEX_LOCK_KEY, 'other-run', 'PX', 60_000);
    try {
      const res = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 1 });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'reindex_in_progress' });
    } finally {
      await h.redis.del(CHAT_FLAG_REINDEX_LOCK_KEY);
    }
    const again = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 1 });
    expect(again.statusCode).toBe(200);
    expect(await h.redis.get(CHAT_FLAG_REINDEX_LOCK_KEY)).toBeNull();
  });

  it('walks the keyset on a (sent_at, id) btree index present on every partition', async () => {
    const rows = (await h.db.execute(sql`
      SELECT c.relname AS partition,
             EXISTS (
               SELECT 1 FROM pg_index i
                 JOIN pg_class ic ON ic.oid = i.indexrelid
                WHERE i.indrelid = c.oid
                  AND pg_get_indexdef(i.indexrelid) LIKE '%btree (sent_at, id)%'
             ) AS has_index
        FROM pg_inherits inh
        JOIN pg_class c ON c.oid = inh.inhrelid
       WHERE inh.inhparent = 'chat_messages'::regclass
    `)) as unknown as Array<{ partition: string; has_index: boolean }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.has_index)).toEqual([]);
  });
});

describe('chat-flag rule changes reconcile already-flagged history (#346)', () => {
  async function seedFlaggedMessage(ruleId: string): Promise<string> {
    const serverId = uuidv7();
    const playerId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Flag Cleanup Server',
      slug: `flag-cleanup-${serverId}`,
    });
    await h.db.insert(players).values({
      id: playerId,
      canonicalName: 'Flag Cleanup Player',
      canonicalNameNormalized: 'flag cleanup player',
    });
    await h.db.insert(chatMessages).values({
      playerId,
      serverId,
      sentAt: new Date(),
      scope: 'all',
      message: 'flagged by the rule under test',
      source: 'log',
      isFlagged: true,
      matchedRuleId: ruleId,
    });
    return playerId;
  }

  async function flagState(playerId: string) {
    const [row] = await h.db
      .select({ isFlagged: chatMessages.isFlagged, ruleId: chatMessages.matchedRuleId })
      .from(chatMessages)
      .where(eq(chatMessages.playerId, playerId));
    return row;
  }

  async function createRule(cookie: string, pattern: string): Promise<string> {
    const res = await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern,
      pattern_type: 'word',
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it('DELETE unflags the messages the rule had flagged', async () => {
    const cookie = await loginAsOwner(h);
    const ruleId = await createRule(cookie, `cleanup-delete-${uuidv7()}`);
    const playerId = await seedFlaggedMessage(ruleId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/chat-flag-rules/${ruleId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(await flagState(playerId)).toEqual({ isFlagged: false, ruleId: null });
  });

  it('PATCH enabled=false unflags the messages the rule had flagged', async () => {
    const cookie = await loginAsOwner(h);
    const ruleId = await createRule(cookie, `cleanup-disable-${uuidv7()}`);
    const playerId = await seedFlaggedMessage(ruleId);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/settings/chat-flag-rules/${ruleId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(await flagState(playerId)).toEqual({ isFlagged: false, ruleId: null });
  });

  it('PATCH of the pattern unflags the messages matched by the old pattern', async () => {
    const cookie = await loginAsOwner(h);
    const ruleId = await createRule(cookie, `cleanup-repattern-${uuidv7()}`);
    const playerId = await seedFlaggedMessage(ruleId);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/settings/chat-flag-rules/${ruleId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { pattern: `cleanup-new-${uuidv7()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(await flagState(playerId)).toEqual({ isFlagged: false, ruleId: null });
  });

  it('PATCH of the locale alone leaves existing flags untouched', async () => {
    const cookie = await loginAsOwner(h);
    const ruleId = await createRule(cookie, `cleanup-locale-${uuidv7()}`);
    const playerId = await seedFlaggedMessage(ruleId);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/settings/chat-flag-rules/${ruleId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { locale: 'ru' },
    });
    expect(res.statusCode).toBe(200);
    expect(await flagState(playerId)).toEqual({ isFlagged: true, ruleId });
  });

  it('indexes chat_messages.matched_rule_id so the rule FK action is not a full scan', async () => {
    const rows = (await h.db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'chat_messages' AND indexname = 'chat_messages_matched_rule_idx'
    `)) as unknown as Array<{ indexdef: string }>;
    expect(rows[0]?.indexdef).toMatch(/\(matched_rule_id\) WHERE \(matched_rule_id IS NOT NULL\)/);
  });
});

describe('reindex concurrency guard (#345)', () => {
  it('answers 409 while another reindex holds the lock, and runs once it is released', async () => {
    const cookie = await loginAsOwner(h);
    await h.redis.set(CHAT_FLAG_REINDEX_LOCK_KEY, 'other-run', 'EX', 60);
    try {
      const blocked = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 1 });
      expect(blocked.statusCode).toBe(409);
      expect((blocked.json() as { error: string }).error).toBe('reindex_in_progress');
      expect(await h.redis.get(CHAT_FLAG_REINDEX_LOCK_KEY)).toBe('other-run');
    } finally {
      await h.redis.del(CHAT_FLAG_REINDEX_LOCK_KEY);
    }

    const ok = await post(cookie, '/api/v1/settings/chat-flag-rules/reindex', { days: 1 });
    expect(ok.statusCode).toBe(200);
    expect(await h.redis.get(CHAT_FLAG_REINDEX_LOCK_KEY)).toBeNull();
  });

  it('rewrites every changed row across several batches', async () => {
    const cookie = await loginAsOwner(h);
    const token = `batchword${uuidv7().replace(/-/g, '')}`;
    const serverId = uuidv7();
    const playerId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Batch Server',
      slug: `batch-${serverId}`,
    });
    await h.db.insert(players).values({
      id: playerId,
      canonicalName: 'Batch Player',
      canonicalNameNormalized: 'batch player',
    });
    const base = Date.now();
    await h.db.insert(chatMessages).values(
      Array.from({ length: 7 }, (_, index) => ({
        playerId,
        serverId,
        sentAt: new Date(base - index * 1000),
        scope: 'all',
        message: index % 2 === 0 ? `say ${token} now` : 'clean line',
        source: 'log',
        isFlagged: false,
      })),
    );
    await post(cookie, '/api/v1/settings/chat-flag-rules', {
      pattern: token,
      pattern_type: 'word',
    });

    const summary = await reindexChatFlags(h.db, { days: 1, batchSize: 2 });
    expect(summary.changed).toBeGreaterThanOrEqual(4);
    const rows = await h.db
      .select({ isFlagged: chatMessages.isFlagged, message: chatMessages.message })
      .from(chatMessages)
      .where(eq(chatMessages.playerId, playerId));
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.isFlagged).toBe(row.message.includes(token));
  });
});
