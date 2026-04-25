import type { DatabaseClient } from '@squad/db';
import {
  organizationMembers,
  organizations,
  playerRoleAssignments,
  players,
  roles,
} from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type ClaimResult = 'claimed' | 'already_claimed' | 'no_owner_role';

export interface SentinelBridge {
  fileRead(args: { path: string }): Promise<unknown>;
  fileAtomicWrite(args: { path: string; content: string; mode?: number }): Promise<unknown>;
}

const SENTINEL_PATH = '/var/lib/squad-panel/.first-owner-claimed';

function stubName(steamId64: bigint): string {
  return `Player ${String(steamId64).slice(-4)}`;
}

export async function claimFirstOwner(
  db: DatabaseClient,
  bridge: SentinelBridge,
  steamId64: bigint,
): Promise<ClaimResult> {
  try {
    await bridge.fileRead({ path: SENTINEL_PATH });
    return 'already_claimed';
  } catch {
    // sentinel absent or bridge error — proceed to transactional path
  }

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('first_owner'))`);

    const orgs = await tx.select().from(organizations).limit(1);
    const org = orgs[0];
    if (!org) throw new Error('no_organization_yet');

    const settings = (org.settings as Record<string, unknown>) ?? {};
    if (settings.first_owner_claimed === true) return 'already_claimed';

    const ownerRoleRows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, org.id), eq(roles.name, 'Owner')))
      .limit(1);
    const ownerRole = ownerRoleRows[0];
    if (!ownerRole) return 'no_owner_role';

    const stub = stubName(steamId64);
    await tx
      .insert(players)
      .values({
        steamId64,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
      })
      .onConflictDoNothing();

    await tx
      .insert(playerRoleAssignments)
      .values({ steamId64, roleId: ownerRole.id, assignedBy: null })
      .onConflictDoNothing();

    await tx
      .insert(organizationMembers)
      .values({ steamId64, orgId: org.id, primaryRoleId: ownerRole.id })
      .onConflictDoNothing();

    await tx
      .update(organizations)
      .set({ settings: { ...settings, first_owner_claimed: true } })
      .where(eq(organizations.id, org.id));

    await bridge.fileAtomicWrite({
      path: SENTINEL_PATH,
      content: JSON.stringify({
        steam_id64: String(steamId64),
        claimed_at: new Date().toISOString(),
      }),
    });

    return 'claimed';
  });
}
