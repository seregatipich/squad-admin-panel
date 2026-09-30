/**
 * Reads a positive integer setting from the environment.
 *
 * @param name - Environment variable name, used in the error message.
 * @param fallback - Value returned when the variable is unset or blank.
 * @param env - Environment to read from; defaults to `process.env`.
 * @returns The parsed integer, or `fallback` when the variable is not set.
 * @throws Error when the variable is set to anything other than a positive
 *   integer, so a typo fails startup instead of turning into `NaN` (which
 *   disables size limits and timeouts and makes `setInterval` fire every ms).
 */
export function positiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
