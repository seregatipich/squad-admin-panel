import type { DatabaseClient } from '@squad/db';
import { panelMeta, players, roles } from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type ClaimResult = 'claimed' | 'already_claimed' | 'no_owner_role';

export interface SentinelBridge {
  fileRead(args: { path: string }): Promise<unknown>;
  fileAtomicWrite(args: { path: string; content: string; mode?: number }): Promise<unknown>;
}

const SENTINEL_PATH = '/var/lib/squad-panel/.first-owner-claimed';

/**
 * Claim Owner role on first successful Steam login.
 *
 * The DB is the source of truth: `panel_meta.first_owner_claimed` decides
 * whether the trick fires. The host-side sentinel file is an informational
 * cache only — it survives DB resets, so trusting it as authoritative
 * caused a wedge after `docker compose down -v` + reinstall (sentinel from
 * the previous DB blocked every subsequent claim, leaving the panel without
 * an Owner). The sentinel is now written after a successful claim and read
 * only as a fast-path skip; if DB and sentinel disagree, DB wins and the
 * stale sentinel is overwritten.
 */
export async function claimFirstOwner(
  db: DatabaseClient,
  bridge: SentinelBridge,
  steamId64: bigint,
): Promise<ClaimResult> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('panel_first_owner'))`);

    const meta = await tx.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    if (meta[0]?.firstOwnerClaimed) return 'already_claimed' as const;

    const ownerRoleRows = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const ownerRoleId = ownerRoleRows[0]?.id;
    if (!ownerRoleId) return 'no_owner_role' as const;

    const ownerExists = await tx
      .select({ steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.roleId, ownerRoleId))
      .limit(1);
    if (ownerExists.length > 0) {
      await tx.update(panelMeta).set({ firstOwnerClaimed: true }).where(eq(panelMeta.id, 1));
      return 'already_claimed' as const;
    }

    await tx.update(players).set({ roleId: ownerRoleId }).where(eq(players.steamId64, steamId64));
    await tx.update(panelMeta).set({ firstOwnerClaimed: true }).where(eq(panelMeta.id, 1));
    return 'claimed' as const;
  });

  if (result === 'claimed') {
    try {
      await bridge.fileAtomicWrite({
        path: SENTINEL_PATH,
        content: JSON.stringify({
          steam_id64: String(steamId64),
          claimed_at: new Date().toISOString(),
        }),
      });
    } catch {
      // sentinel write failure is non-fatal — DB is the source of truth.
    }
  }
  return result;
}

/**
 * Read the sentinel file without affecting claim logic. Useful for the
 * `/no-access` page hint and ops diagnostics. Returns `null` if absent or
 * if the bridge call fails.
 */
export async function readSentinelHint(
  bridge: SentinelBridge,
): Promise<{ steam_id64: string; claimed_at: string } | null> {
  try {
    const result = (await bridge.fileRead({ path: SENTINEL_PATH })) as { content?: string };
    if (!result?.content) return null;
    return JSON.parse(result.content) as { steam_id64: string; claimed_at: string };
  } catch {
    return null;
  }
}
