/**
 * Pure line-surgery helper for the panel-managed `Bans.cfg`: removing every
 * ban line for a given player on unban/revert. Kept free of bridge/I-O
 * concerns so it can be unit-tested directly; callers own reading the file
 * via the bridge, calling this, and writing the result back through
 * `writeVersion`.
 */

// Grammar copied verbatim from
// `apps/workers/ban-sync/src/adapters/squad-bans-cfg.ts` (CBAN-2): optional
// "[admin prefix] " (anything up to "Banned:"), then
// "Banned:<17-digit SteamID64>:<unix-expiry>", then an optional
// "// comment" trailer used as the ban reason.
const LINE_PATTERN =
  /^(?<prefix>.*?)Banned:(?<steamId>\d{17}):(?<expiry>\d+)\s*(?:\/\/\s*(?<comment>.*))?$/;

/** Result of {@link removeBanLines}. */
export interface RemoveBanLinesResult {
  /** The file content with every matching ban line removed. */
  content: string;
  /** The removed lines, verbatim and in their original order. */
  removed: string[];
  /** The line-ending style detected in the input and reused in the output. */
  eol: '\n' | '\r\n';
}

/**
 * Removes every `Banned:<steamId64>:...` line for `steamId64` from a Squad
 * `Bans.cfg` body.
 *
 * All lines whose SteamID64 matches are removed (Squad appends a fresh line
 * on every `AdminBan` rather than replacing an existing one, so a player can
 * accumulate more than one line; leaving any of them would keep the player
 * blocked). Blank lines, `//`-only comment lines, and lines for other
 * players are preserved verbatim, including their original order.
 *
 * The line-ending style is detected from the first `\r\n` occurrence in
 * `content` (defaulting to `\n` when none is found) and reused for the
 * output, so a CRLF file round-trips byte-for-byte instead of being
 * normalized to LF.
 *
 * @param content - The current `Bans.cfg` file body.
 * @param steamId64 - The 17-digit SteamID64 whose ban lines should be removed.
 * @returns The updated content, the removed lines, and the detected EOL.
 */
export function removeBanLines(content: string, steamId64: string): RemoveBanLinesResult {
  const eol: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r\n|\n/);
  const removed: string[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    const match = line.match(LINE_PATTERN);
    if (match?.groups?.steamId === steamId64) {
      removed.push(line);
      continue;
    }
    kept.push(line);
  }

  return { content: kept.join(eol), removed, eol };
}
