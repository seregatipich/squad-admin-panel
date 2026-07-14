import type { ParsedBan, ParseResult } from './index.js';

// Matches: optional "[admin prefix] " (anything up to "Banned:"), then
// "Banned:<17-digit SteamID64>:<unix-expiry>", then an optional
// "// comment" trailer used as the ban reason. Confirmed by decomposition
// correction #4 (see AGENTS.md / issue CBAN-2).
const LINE_PATTERN =
  /^(?<prefix>.*?)Banned:(?<steamId>\d{17}):(?<expiry>\d+)\s*(?:\/\/\s*(?<comment>.*))?$/;

function extractAdminName(prefix: string): string | null {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return null;
  // Strip common bracket/paren wrappers, e.g. "[AdminX] " -> "AdminX".
  const bracketed = trimmed.match(/^[[(](.+)[\])]$/);
  return (bracketed?.[1] ?? trimmed).trim() || null;
}

/**
 * Parses a Squad `Bans.cfg`-format ban list: one ban per line as
 * `Banned:<SteamID64>:<unix-expiry>`, expiry `0` meaning a permanent ban.
 * Blank lines and comment-only lines are ignored; lines that don't match
 * the pattern (or whose SteamID64 isn't exactly 17 digits) are counted in
 * `skipped` rather than throwing, so one malformed line never aborts a sync.
 */
export function parseSquadBansCfg(text: string): ParseResult {
  const records: ParsedBan[] = [];
  let skipped = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('//') || line.startsWith('#')) continue;

    const match = line.match(LINE_PATTERN);
    if (!match?.groups) {
      skipped++;
      continue;
    }

    const { prefix, steamId, expiry, comment } = match.groups;
    if (!steamId || !expiry) {
      skipped++;
      continue;
    }
    const expiryNum = Number(expiry);
    if (!Number.isFinite(expiryNum)) {
      skipped++;
      continue;
    }

    records.push({
      steamId64: steamId,
      eosId: null,
      nickname: null,
      reason: comment?.trim() || null,
      adminName: extractAdminName(prefix ?? ''),
      issuedAt: null,
      expiresAt: expiryNum === 0 ? null : new Date(expiryNum * 1000),
      raw: { line },
    });
  }

  return { records, skipped };
}
