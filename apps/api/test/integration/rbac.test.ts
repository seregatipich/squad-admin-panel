import { roles, userRoleAssignments } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasPermission,
  hasServerPermission,
  invalidatePermissionCache,
  loadUserPermissions,
} from '../../src/lib/rbac.js';
import { buildIntegrationApp, type IntegrationHarness } from './harness.js';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { email: 'owner@test.local', password: 'correct-horse-battery-staple' },
  });
});

afterEach(async () => {
  // Every test should invalidate its own user to prevent cache leaks between
  // tests; the rbac cache is a module-level Map.
  if (h.seed.ownerUserId) invalidatePermissionCache(h.seed.ownerUserId);
  await h.cleanup();
});

describe('loadUserPermissions', () => {
  it('returns full Owner permissions + clearance=1000 for the seeded owner', async () => {
    const ctx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    expect(ctx.clearance).toBe(1000);
    expect(ctx.permissions.has('server:view')).toBe(true);
    expect(ctx.permissions.has('server:create')).toBe(true);
    expect(ctx.permissions.has('audit:view')).toBe(true);
    expect(ctx.roleIds).toHaveLength(1);
  });

  it('returns empty permissions + clearance=0 for a user with no roles', async () => {
    // Remove the Owner's role assignment.
    await h.db
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, h.seed.ownerUserId!));
    invalidatePermissionCache(h.seed.ownerUserId!);
    const ctx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    expect(ctx.permissions.size).toBe(0);
    expect(ctx.clearance).toBe(0);
    expect(ctx.roleIds).toEqual([]);
  });

  it('unions permissions across multiple roles and takes the max clearance', async () => {
    // Assign a Viewer role ALONGSIDE Owner; clearance should stay at 1000.
    const viewer = await h.db.query.roles.findFirst({
      where: (r, { and: _a, eq: _e }) => _a(_e(r.orgId, h.seed.orgId!), _e(r.name, 'Viewer')),
    });
    if (!viewer) throw new Error('viewer missing');
    await h.db.insert(userRoleAssignments).values({
      userId: h.seed.ownerUserId!,
      roleId: viewer.id,
    });
    invalidatePermissionCache(h.seed.ownerUserId!);
    const ctx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    expect(ctx.roleIds).toHaveLength(2);
    expect(ctx.clearance).toBe(1000);
    // Owner perms are a superset; Viewer perms are contained.
    expect(ctx.permissions.has('audit:view')).toBe(true);
  });

  it('caches the result: a second call returns the same PermissionContext instance', async () => {
    const a = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    const b = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    expect(a).toBe(b);
  });

  it('invalidatePermissionCache forces a re-read', async () => {
    const a = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    invalidatePermissionCache(h.seed.ownerUserId!);
    const b = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    expect(a).not.toBe(b);
    expect(b.clearance).toBe(1000);
  });
});

describe('hasPermission', () => {
  it('requires ALL of the passed keys to be present', async () => {
    const ctx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    expect(hasPermission(ctx, ['server:view'])).toBe(true);
    expect(hasPermission(ctx, ['server:view', 'server:create'])).toBe(true);
    // Viewer-only user missing server:create.
    const viewer = await h.db.query.roles.findFirst({
      where: (r, { and: _a, eq: _e }) => _a(_e(r.orgId, h.seed.orgId!), _e(r.name, 'Viewer')),
    });
    if (!viewer) throw new Error('viewer missing');
    await h.db
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, h.seed.ownerUserId!));
    await h.db
      .insert(userRoleAssignments)
      .values({ userId: h.seed.ownerUserId!, roleId: viewer.id });
    invalidatePermissionCache(h.seed.ownerUserId!);
    const viewerCtx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    expect(hasPermission(viewerCtx, ['server:view'])).toBe(true);
    expect(hasPermission(viewerCtx, ['server:create'])).toBe(false);
  });
});

describe('hasServerPermission', () => {
  it('returns false when the permission is absent, even if server exists', async () => {
    const viewer = await h.db.query.roles.findFirst({
      where: (r, { and: _a, eq: _e }) => _a(_e(r.orgId, h.seed.orgId!), _e(r.name, 'Viewer')),
    });
    if (!viewer) throw new Error('viewer missing');
    await h.db
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, h.seed.ownerUserId!));
    await h.db
      .insert(userRoleAssignments)
      .values({ userId: h.seed.ownerUserId!, roleId: viewer.id });
    invalidatePermissionCache(h.seed.ownerUserId!);
    const ctx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    const allowed = await hasServerPermission(h.db, ctx, 'any-server-id', ['server:create']);
    expect(allowed).toBe(false);
  });

  it('returns false when the server row does not exist, even with permission', async () => {
    const ctx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    const allowed = await hasServerPermission(h.db, ctx, '019e0000-0000-7000-8000-ffffffffffff', [
      'server:view',
    ]);
    expect(allowed).toBe(false);
  });

  it('returns true when permission is present AND server row exists', async () => {
    const ctx = await loadUserPermissions(h.db, h.seed.ownerUserId!);
    const serverId = '019e0000-0000-7000-8000-ab0000000000';
    await h.db.insert((await import('@squad/db/schema')).servers).values({
      id: serverId,
      orgId: h.seed.orgId!,
      displayName: 'x',
      slug: 'x-slug',
    });
    void roles; // silence unused-import
    const allowed = await hasServerPermission(h.db, ctx, serverId, ['server:view']);
    expect(allowed).toBe(true);
  });
});
