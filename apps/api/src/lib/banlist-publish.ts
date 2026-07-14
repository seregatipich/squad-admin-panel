/**
 * Pure helpers for CBAN-5 outbound banlist federation: turning
 * `moderation_actions` ban rows into the public `squad_cfg`/`json` banlist
 * views served by `GET /api/v1/public/banlist`. Kept free of DB/Fastify
 * concerns so they can be unit-tested directly.
 */

export type BanlistPublishScope = 'all_active' | 'permanent_only';

/** Matches the RCON-worker `AdminBan` duration syntax (see commands.ts). */
const BAN_LENGTH_PATTERN = /^(\d+)([smhdwMy])?$/;

const UNIT_MILLISECONDS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  // Calendar-approximate: matches the RCON-worker's "M"/"y" convention closely
  // enough for federation purposes (exact calendar arithmetic is not needed
  // to decide whether a ban has expired).
  M: 2_592_000_000,
  y: 31_536_000_000,
};

/**
 * Resolves a Squad `AdminBan` duration string (see `buildAdminBanCommand` in
 * `apps/workers/rcon/src/commands.ts`) to an absolute expiry `Date`, or
 * `null` for a permanent ban.
 *
 * Grammar: a bare number of days, or a number followed by a unit suffix
 * (`s`/`m`/`h`/`d`/`w`/`M`/`y`); `0` (with or without a unit) means
 * permanent. A missing, empty, or malformed value is also treated as
 * permanent — this matches `AdminBan`'s own `'0'` default and errs on the
 * side of not under-publishing an enforcement action.
 */
export function parseBanLengthToExpiry(
  banLength: string | null | undefined,
  issuedAt: Date,
): Date | null {
  const trimmed = (banLength ?? '').trim();
  if (trimmed.length === 0) return null;

  const match = BAN_LENGTH_PATTERN.exec(trimmed);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount === 0) return null;

  const unit = match[2] ?? 'd';
  const unitMs = UNIT_MILLISECONDS[unit] ?? UNIT_MILLISECONDS.d ?? 86_400_000;
  return new Date(issuedAt.getTime() + amount * unitMs);
}

/** A single `moderation_actions` ban row as read from the database. */
export interface ModerationBanRow {
  /** Groups rows that target the same player for dedup purposes. */
  playerId: string;
  steamId64: string | null;
  eosId: string | null;
  nickname: string | null;
  reason: string | null;
  /** `context.ban_length` from the moderation_actions row. */
  banLength: string | null;
  issuedAt: Date;
  revertedAt: Date | null;
  admin: string | null;
}

/** One player's entry in the published banlist, in either output format. */
export interface BanlistEntry {
  steamId64: string | null;
  eosId: string | null;
  nickname: string | null;
  reason: string | null;
  issuedAt: Date;
  /** `null` means permanent. */
  expiresAt: Date | null;
  admin: string | null;
}

function toEntry(row: ModerationBanRow): BanlistEntry & { expiresAtMs: number | null } {
  const expiresAt = parseBanLengthToExpiry(row.banLength, row.issuedAt);
  return {
    steamId64: row.steamId64,
    eosId: row.eosId,
    nickname: row.nickname,
    reason: row.reason,
    issuedAt: row.issuedAt,
    expiresAt,
    admin: row.admin,
    expiresAtMs: expiresAt ? expiresAt.getTime() : null,
  };
}

/**
 * Builds the deduplicated, filtered list of ban entries to publish.
 *
 * - Reverted bans (`revertedAt` set) are dropped — this is how "unban" is
 *   currently observable, since no route sets it yet (MOD-2 leftover).
 * - Expired temporary bans (`expiresAt <= now`) are dropped.
 * - `scope === 'permanent_only'` additionally drops every temporary ban.
 * - Multiple ban rows for the same player are deduplicated, keeping the
 *   permanent one if any exists, otherwise the one with the latest expiry.
 */
export function buildBanlistEntries(
  rows: readonly ModerationBanRow[],
  scope: BanlistPublishScope,
  now: Date,
): BanlistEntry[] {
  const nowMs = now.getTime();
  const byPlayer = new Map<string, ModerationBanRow[]>();

  for (const row of rows) {
    if (row.revertedAt != null) continue;
    const existing = byPlayer.get(row.playerId);
    if (existing) existing.push(row);
    else byPlayer.set(row.playerId, [row]);
  }

  const out: BanlistEntry[] = [];
  for (const playerRows of byPlayer.values()) {
    const candidates = playerRows
      .map(toEntry)
      .filter((entry) => entry.expiresAtMs === null || entry.expiresAtMs > nowMs)
      .filter((entry) => scope !== 'permanent_only' || entry.expiresAtMs === null);

    if (candidates.length === 0) continue;

    const permanent = candidates.find((entry) => entry.expiresAtMs === null);
    const chosen =
      permanent ??
      candidates.reduce((latest, entry) =>
        (entry.expiresAtMs ?? 0) > (latest.expiresAtMs ?? 0) ? entry : latest,
      );

    const { expiresAtMs: _expiresAtMs, ...entry } = chosen;
    out.push(entry);
  }

  return out;
}

function singleLine(value: string | null): string {
  if (!value) return '';
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Formats entries as a Squad `Bans.cfg`-style body: one line per ban,
 * `Banned:<SteamID64>:<unix-expiry>` (`0` for permanent) followed by an
 * optional `// <reason>` trailer. Consumed by `parseSquadBansCfg` on the
 * subscribing side (CBAN-2, `apps/workers/ban-sync/src/adapters/squad-bans-cfg.ts`).
 * Entries without a `steam_id64` cannot be represented in this format and
 * are skipped (they remain visible in `format=json`).
 */
export function formatSquadBansCfg(entries: readonly BanlistEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.steamId64) continue;
    const unixExpiry = entry.expiresAt ? Math.floor(entry.expiresAt.getTime() / 1000) : 0;
    const reason = singleLine(entry.reason);
    const line = reason
      ? `Banned:${entry.steamId64}:${unixExpiry} // ${reason}`
      : `Banned:${entry.steamId64}:${unixExpiry}`;
    lines.push(line);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
