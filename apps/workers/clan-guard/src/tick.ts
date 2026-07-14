import type { Diag } from '@squad/diag';

/** A protected clan (`is_tag_protected = true`, not soft-deleted) with its member set. */
export interface ProtectedClan {
  id: string;
  name: string;
  tags: string[];
  memberPlayerIds: Set<string>;
}

/** An online player as seen from an open `player_sessions` row (mode='online'). */
export interface OnlinePlayer {
  playerId: string;
  serverId: string;
  eosId: string | null;
  name: string;
  connectedAt: Date;
  hasPanelAccess: boolean;
}

export interface ClanGuardSettings {
  enabled: boolean;
  gracePeriodSeconds: number;
}

export interface LastWarn {
  createdAt: Date;
}

export interface ImpostorMatch {
  clanId: string;
  clanName: string;
  tag: string;
}

export interface RecordModerationActionInput {
  playerId: string;
  serverId: string;
  phase: 'warn' | 'kick';
  clanId: string;
  tag: string;
  matchedName: string;
  message: string;
}

export interface WriteClanGuardAuditInput {
  playerId: string;
  serverId: string;
  clanId: string;
  message: string;
}

export interface SendRconCommandInput {
  serverId: string;
  command: 'AdminWarn' | 'AdminKick';
  args: string[];
}

export interface ClanGuardTickDeps {
  now?: Date;
  loadSettings(): Promise<ClanGuardSettings>;
  loadProtectedClans(): Promise<ProtectedClan[]>;
  loadOnlinePlayers(): Promise<OnlinePlayer[]>;
  findLastWarn(playerId: string, serverId: string, connectedAt: Date): Promise<LastWarn | null>;
  sendRconCommand(input: SendRconCommandInput): Promise<void>;
  recordModerationAction(input: RecordModerationActionInput): Promise<void>;
  writeAuditEntry(input: WriteClanGuardAuditInput): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface ClanGuardTickResult {
  skipped: boolean;
  warned: number;
  kicked: number;
  errors: number;
}

const WRAPPER_PAIRS: readonly [string, string][] = [
  ['[', ']'],
  ['(', ')'],
  ['<', '>'],
  ['{', '}'],
];

/**
 * Case-insensitive PREFIX match of a clan tag against a raw (un-normalized)
 * player name. Handles both storage conventions for `clans.tags` — the tag
 * stored with its own wrapper characters (e.g. `[ABC]`, matched as a direct
 * prefix) and the tag stored bare (e.g. `ABC`, matched by re-wrapping it in
 * `[]`/`()`/`<>`/`{}` and checking that wrapped form as a prefix). A tag that
 * merely occurs elsewhere in the name (e.g. `Player [ABC]`) does NOT match —
 * only the start of the (trimmed) name is considered.
 */
export function matchProtectedTag(rawName: string, tag: string): boolean {
  const name = rawName.trim().toLowerCase();
  const candidate = tag.trim().toLowerCase();
  if (candidate.length === 0) return false;
  if (name.startsWith(candidate)) return true;
  return WRAPPER_PAIRS.some(([open, close]) => name.startsWith(`${open}${candidate}${close}`));
}

/**
 * Finds the first protected clan whose tag prefix-matches `rawName`, among
 * clans the player is NOT a member of. A clan whose tag the player is
 * entitled to wear (they are a member of it) never counts as impostor.
 */
export function findImpostorMatch(
  rawName: string,
  clans: readonly ProtectedClan[],
  playerId: string,
): ImpostorMatch | null {
  for (const clan of clans) {
    if (clan.memberPlayerIds.has(playerId)) continue;
    for (const tag of clan.tags) {
      if (matchProtectedTag(rawName, tag)) {
        return { clanId: clan.id, clanName: clan.name, tag };
      }
    }
  }
  return null;
}

function sanitizeForMessage(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Single-line Russian warn/kick message (must satisfy `assertSafeSingleLineText`). */
export function buildClanGuardMessage(tag: string, clanName: string): string {
  return `Тег ${sanitizeForMessage(tag)} защищён кланом ${sanitizeForMessage(clanName)}. Смените ник.`;
}

const COMPONENT = 'worker-clan-guard';

export async function runClanGuardTick(deps: ClanGuardTickDeps): Promise<ClanGuardTickResult> {
  const now = deps.now ?? new Date();
  const settings = await deps.loadSettings();

  if (!settings.enabled) {
    await deps.diag.emit({
      component: COMPONENT,
      kind: 'clan_guard.skipped_disabled',
      severity: 'info',
      message: 'clan tag protection disabled by kill-switch',
      payload: {},
    });
    return { skipped: true, warned: 0, kicked: 0, errors: 0 };
  }

  const protectedClans = await deps.loadProtectedClans();
  if (protectedClans.length === 0) {
    return { skipped: false, warned: 0, kicked: 0, errors: 0 };
  }

  const online = await deps.loadOnlinePlayers();

  let warned = 0;
  let kicked = 0;
  let errors = 0;

  for (const player of online) {
    if (!player.eosId) continue;

    const impostor = findImpostorMatch(player.name, protectedClans, player.playerId);
    if (!impostor) continue;

    try {
      const lastWarn = await deps.findLastWarn(
        player.playerId,
        player.serverId,
        player.connectedAt,
      );
      const message = buildClanGuardMessage(impostor.tag, impostor.clanName);

      if (!lastWarn) {
        await deps.sendRconCommand({
          serverId: player.serverId,
          command: 'AdminWarn',
          args: [player.eosId, message],
        });
        await deps.recordModerationAction({
          playerId: player.playerId,
          serverId: player.serverId,
          phase: 'warn',
          clanId: impostor.clanId,
          tag: impostor.tag,
          matchedName: player.name,
          message,
        });
        warned += 1;
        continue;
      }

      const elapsedSeconds = (now.getTime() - lastWarn.createdAt.getTime()) / 1000;
      if (elapsedSeconds < settings.gracePeriodSeconds) continue;

      if (player.hasPanelAccess) {
        // Admin self-lockout protection: never kick a panel-access holder,
        // only keep re-warning. No ledger row per repeat to keep the
        // moderation history readable.
        await deps.sendRconCommand({
          serverId: player.serverId,
          command: 'AdminWarn',
          args: [player.eosId, message],
        });
        warned += 1;
        continue;
      }

      await deps.sendRconCommand({
        serverId: player.serverId,
        command: 'AdminKick',
        args: [player.eosId, message],
      });
      await deps.recordModerationAction({
        playerId: player.playerId,
        serverId: player.serverId,
        phase: 'kick',
        clanId: impostor.clanId,
        tag: impostor.tag,
        matchedName: player.name,
        message,
      });
      await deps.writeAuditEntry({
        playerId: player.playerId,
        serverId: player.serverId,
        clanId: impostor.clanId,
        message,
      });
      kicked += 1;
    } catch (err) {
      errors += 1;
      const errorMessage = err instanceof Error ? err.message : String(err);
      await deps.diag.emit({
        component: COMPONENT,
        kind: 'clan_guard.player_failed',
        severity: 'error',
        message: `clan guard enforcement failed for player: ${errorMessage}`,
        payload: { playerId: player.playerId, serverId: player.serverId, err: errorMessage },
      });
    }
  }

  return { skipped: false, warned, kicked, errors };
}
