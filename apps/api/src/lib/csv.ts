/** Characters that make a spreadsheet read a cell as a formula (OWASP "CSV Injection"). */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
/** Signed numeric text such as a `numeric` column read as a string (`-12.5`). */
const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NEEDS_QUOTES = /[",;\r\n]/;

/**
 * Serialises one value as a CSV field for every panel export.
 *
 * - RFC 4180 quoting for separators (`,`, and `;` for spreadsheets set to
 *   it), double quotes and line breaks.
 * - Formula neutralisation (audit #137): exports carry player-chosen text —
 *   nicknames, kits, weapons — and Excel/LibreOffice evaluate a cell that
 *   starts with `=`, `+`, `-`, `@`, tab or CR. Such a string gets a leading
 *   apostrophe and is quoted, per the OWASP CSV Injection guidance. Typed
 *   numbers and booleans, and strings that are plain signed numbers, are left
 *   as they are so numeric columns stay numeric.
 *
 * @param value - The cell value; `null`/`undefined` become an empty field.
 * @returns The field, ready to be joined with `,`.
 */
export function csvCell(value: string | number | boolean | bigint | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const isFormula =
    typeof value === 'string' && FORMULA_TRIGGER.test(text) && !NUMERIC_TEXT.test(text);
  const safe = isFormula ? `'${text}` : text;
  if (isFormula || NEEDS_QUOTES.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}
