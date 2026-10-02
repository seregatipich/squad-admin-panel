/**
 * Narrows `value` to a defined, non-null value or throws, so a test that reads
 * `rows[0]` fails with a clear message when the row is missing instead of a
 * `TypeError` further down (and type-checks under `noUncheckedIndexedAccess`).
 */
export function defined<T>(value: T | null | undefined, what = 'row'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
}
