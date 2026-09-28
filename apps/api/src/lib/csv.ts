/**
 * Leading characters that make a spreadsheet (Excel, LibreOffice, Google
 * Sheets) evaluate a cell as a formula. See
 * https://owasp.org/www-community/attacks/CSV_Injection.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Characters that force a cell to be quoted; `;` covers semicolon-locale Excel. */
const NEEDS_QUOTING = /[",;\r\n]/;

/**
 * Serialises one value as an RFC 4180 CSV cell that is safe to open in a
 * spreadsheet.
 *
 * Strings are attacker-influenced in every panel export (player names come
 * from Steam and the game, layers and end reasons from server logs), so a
 * string starting with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`
 * and the spreadsheet shows it as text instead of running it as a formula.
 * Numbers and booleans are written as-is, so negative numbers stay numeric.
 *
 * @param value - Cell value; `null`/`undefined` become an empty cell.
 * @returns The escaped cell text, quoted when it contains `"`, `,`, `;`, CR or LF.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
