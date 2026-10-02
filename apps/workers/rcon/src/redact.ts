/**
 * Redaction for RCON reply samples that end up in logs. An unparsed
 * `ListPlayers` row carries a player's EOS id, SteamID64 and name, and a row
 * in a layout we do not know yet may carry them under field names we do not
 * know either. The sample therefore keeps field NAMES (what a parser fix needs)
 * and drops every value except plain numbers, booleans and `N/A`.
 */

/** Values that identify nobody: ids of squads and teams, flags, `N/A`, `#0` party numbers. */
const SAFE_VALUE = /^(?:\d{1,6}|N\/A|True|False|#\d{1,6})$/;
const FIELD = /^([^:|]{1,40}):\s*(.*)$/;

/** Longest line kept in a sample; a reply line is a few hundred characters at most. */
const MAX_LINE_CHARS = 400;

/**
 * Reduces one RCON reply line to its field layout: `ID: 60 | Online IDs: <str> |
 * Name: <str> | Team ID: 2 | ...`. Nothing that could identify a player survives.
 *
 * @param line - a raw reply line
 * @returns the line with every non-trivial value replaced by `<str>`, cut to 400 characters
 */
export function redactRconLine(line: string): string {
  return line
    .split(' | ')
    .map((segment) => {
      const field = FIELD.exec(segment.trim());
      if (!field) return '<str>';
      const value = (field[2] as string).trim();
      return `${field[1]}: ${SAFE_VALUE.test(value) ? value : '<str>'}`;
    })
    .join(' | ')
    .slice(0, MAX_LINE_CHARS);
}

/**
 * Redacts the first `limit` lines of a reply for a log sample.
 *
 * @param lines - raw reply lines
 * @param limit - how many lines to keep
 * @returns the redacted lines
 */
export function redactRconSample(lines: readonly string[], limit = 2): string[] {
  return lines.slice(0, limit).map(redactRconLine);
}
