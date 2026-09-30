/**
 * Narrowing guards for decoded JSON bodies. The panel reads API responses
 * without a schema library, so a section parses its body with these instead of
 * casting it with `as`: a malformed or drifted response then renders as an
 * error rather than crashing the page on the first missing field.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

/** An array whose every element satisfies `guard`. */
export function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

/**
 * Checks the `GET /api/v1/setup/status` body the dashboard layout dereferences.
 *
 * @param body Decoded JSON response.
 * @throws {TypeError} `setup_completed` is not a boolean.
 */
export function parseSetupStatus(body: unknown): { setup_completed: boolean } {
  if (!isRecord(body) || typeof body.setup_completed !== 'boolean') {
    throw new TypeError('setup_completed must be a boolean');
  }
  return { setup_completed: body.setup_completed };
}
