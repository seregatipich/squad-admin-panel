import type { DatabaseClient } from '@squad/db';
import {
  DISCORD_INTEGRATION_SINGLETON_ID,
  discordIntegration,
  discordRoleMappings,
  playerDiscordLinks,
  players,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { decryptString, deserialize } from './crypto.js';
import {
  addGuildMemberRole,
  type DiscordFailure,
  type DiscordRestDeps,
  fetchGuildMemberRoles,
  removeGuildMemberRole,
} from './discord-rest.js';

export interface RoleSyncDeps extends DiscordRestDeps {
  db: DatabaseClient;
}

export interface DiscordBotContext {
  guildId: string;
  botToken: string;
}

/**
 * Resolves the Discord bot credentials from `discord_integration`, or `null`
 * when the sync cannot run — the integration row is missing, disabled, has no
 * guild id, or has no stored bot token.
 *
 * Returning `null` rather than throwing is the same degraded-idle gate
 * `apps/api/src/lib/steam-profile.ts` uses for its missing API key: an operator
 * who has not finished configuring Discord gets a quiet no-op, not a
 * crash-looping worker. Re-read on every cycle so configuring the bot takes
 * effect without a restart.
 */
export async function loadDiscordBotContext(
  db: DatabaseClient,
  encryptionKey: Buffer,
): Promise<DiscordBotContext | null> {
  const rows = await db
    .select()
    .from(discordIntegration)
    .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return null;
  if (!row.guildId || row.botTokenEncrypted == null) return null;
  const botToken = decryptString(
    encryptionKey,
    deserialize(Buffer.from(row.botTokenEncrypted as unknown as Buffer)),
  );
  return { guildId: row.guildId, botToken };
}

export type SyncOutcome = 'synced' | 'not_linked' | 'not_a_guild_member' | 'error';

export interface PlayerSyncResult {
  outcome: SyncOutcome;
  added: string[];
  removed: string[];
  error?: DiscordFailure;
}

interface MappingSet {
  /** Every Discord role the panel manages (enabled mappings only). */
  managed: Set<string>;
  /** Discord roles the given panel role grants, keyed by panel role id. */
  byPanelRole: Map<string, Set<string>>;
}

async function loadMappings(deps: RoleSyncDeps): Promise<MappingSet> {
  const rows = await deps.db.select().from(discordRoleMappings);
  const managed = new Set<string>();
  const byPanelRole = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.enabled) continue;
    managed.add(row.discordRoleId);
    const bucket = byPanelRole.get(row.roleId) ?? new Set<string>();
    bucket.add(row.discordRoleId);
    byPanelRole.set(row.roleId, bucket);
  }
  return { managed, byPanelRole };
}

async function loadPanelRoleId(deps: RoleSyncDeps, playerId: string): Promise<string | null> {
  const rows = await deps.db.select().from(players).where(eq(players.id, playerId)).limit(1);
  return rows[0]?.roleId ?? null;
}

async function loadDiscordUserId(deps: RoleSyncDeps, playerId: string): Promise<string | null> {
  const rows = await deps.db
    .select()
    .from(playerDiscordLinks)
    .where(eq(playerDiscordLinks.playerId, playerId))
    .limit(1);
  return rows[0]?.discordUserId ?? null;
}

/** One linked player with everything the sync needs, loaded up front. */
interface LinkedMember {
  playerId: string;
  discordUserId: string;
  panelRoleId: string | null;
}

/**
 * Reads the member's current Discord roles and applies the difference between
 * them and what `mappings` says the member's panel role should grant. Shared
 * by the per-player sync and the reconcile sweep so both follow the same rules.
 */
async function syncLinkedMember(
  deps: RoleSyncDeps,
  member: LinkedMember,
  mappings: MappingSet,
): Promise<PlayerSyncResult> {
  const { playerId, discordUserId, panelRoleId } = member;
  const { managed, byPanelRole } = mappings;
  const desired: ReadonlySet<string> =
    (panelRoleId ? byPanelRole.get(panelRoleId) : undefined) ?? new Set<string>();

  const guildMember = await fetchGuildMemberRoles(deps, discordUserId);
  if (!guildMember.ok && guildMember.notAMember) {
    deps.log.debug({ playerId, discordUserId }, 'discord role sync: not a guild member');
    return { outcome: 'not_a_guild_member', added: [], removed: [] };
  }
  if (!guildMember.ok) {
    return { outcome: 'error', added: [], removed: [], error: guildMember.failure };
  }

  const current = new Set(guildMember.roles);
  const toAdd = [...desired].filter((roleId) => !current.has(roleId));
  const toRemove = [...current].filter((roleId) => managed.has(roleId) && !desired.has(roleId));

  const added: string[] = [];
  const removed: string[] = [];
  for (const roleId of toAdd) {
    const res = await addGuildMemberRole(deps, discordUserId, roleId);
    if (!res.ok) return { outcome: 'error', added, removed, error: res.failure };
    added.push(roleId);
  }
  for (const roleId of toRemove) {
    const res = await removeGuildMemberRole(deps, discordUserId, roleId);
    if (!res.ok) return { outcome: 'error', added, removed, error: res.failure };
    removed.push(roleId);
  }

  if (added.length > 0 || removed.length > 0) {
    deps.log.info({ playerId, discordUserId, added, removed }, 'discord roles synced');
  }
  return { outcome: 'synced', added, removed };
}

/**
 * Drives one player's Discord roles to what the panel says they should be.
 *
 * The panel is the source of truth, but only over the Discord roles that
 * appear in an enabled `discord_role_mappings` row: a role outside that set is
 * never added and never removed, so operators keep full manual control of
 * everything the panel does not manage.
 *
 * The same rules serve both the reactive stream request and the hourly
 * reconcile — it always reads the member's current Discord roles first, which
 * makes it idempotent and makes drift repair fall out for free.
 */
export async function syncPlayerDiscordRoles(
  deps: RoleSyncDeps,
  playerId: string,
): Promise<PlayerSyncResult> {
  const discordUserId = await loadDiscordUserId(deps, playerId);
  if (!discordUserId) return { outcome: 'not_linked', added: [], removed: [] };

  const mappings = await loadMappings(deps);
  const panelRoleId = await loadPanelRoleId(deps, playerId);
  return syncLinkedMember(deps, { playerId, discordUserId, panelRoleId }, mappings);
}

export interface ReconcileSummary {
  /** Linked players examined. */
  checked: number;
  added: number;
  removed: number;
  /** Players skipped because their Discord account is not in the guild. */
  skipped: number;
  errors: number;
  lastError: DiscordFailure | null;
}

export interface ReconcileOptions {
  /** Checked before each player; once it returns `true` the sweep ends early. */
  shouldStop?: () => boolean;
}

/**
 * Hourly drift repair: walks every `player_discord_links` row and re-derives
 * its Discord roles. Restores a role an admin removed by hand in Discord and
 * strips a managed role an admin granted by hand — the panel wins either way.
 *
 * Iterates the link table rather than listing guild members on purpose: the
 * batch member listing needs the privileged `GUILD_MEMBERS` intent, and an
 * unlinked guild member is not the panel's business anyway.
 *
 * The mappings and every link joined with its player's panel role are loaded
 * once up front (two queries per sweep, not three per player); the Discord
 * calls stay sequential. `shouldStop` is checked between players so a
 * shutdown does not wait for a full sweep.
 */
export async function reconcileLinkedPlayers(
  deps: RoleSyncDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const shouldStop = options.shouldStop ?? (() => false);
  const summary: ReconcileSummary = {
    checked: 0,
    added: 0,
    removed: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
  };
  const mappings = await loadMappings(deps);
  const members: LinkedMember[] = await deps.db
    .select({
      playerId: playerDiscordLinks.playerId,
      discordUserId: playerDiscordLinks.discordUserId,
      panelRoleId: players.roleId,
    })
    .from(playerDiscordLinks)
    .leftJoin(players, eq(players.id, playerDiscordLinks.playerId));
  for (const member of members) {
    if (shouldStop()) {
      deps.log.info({ ...summary }, 'discord role reconcile interrupted by shutdown');
      return summary;
    }
    summary.checked++;
    let result: PlayerSyncResult;
    try {
      result = await syncLinkedMember(deps, member, mappings);
    } catch (err) {
      summary.errors++;
      summary.lastError = {
        reason: 'network_error',
        message: `Ошибка синхронизации: ${(err as Error).message}`,
      };
      deps.log.error(
        { playerId: member.playerId, err: (err as Error).message },
        'discord role reconcile failed for one player; continuing',
      );
      continue;
    }
    if (result.outcome === 'not_a_guild_member') {
      summary.skipped++;
      continue;
    }
    summary.added += result.added.length;
    summary.removed += result.removed.length;
    if (result.outcome === 'error' && result.error) {
      summary.errors++;
      summary.lastError = result.error;
    }
  }
  deps.log.info({ ...summary }, 'discord role reconcile finished');
  return summary;
}
