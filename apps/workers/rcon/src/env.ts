/** A positive integer from the environment, or `undefined` to keep the supervisor default. */
export function positiveIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
