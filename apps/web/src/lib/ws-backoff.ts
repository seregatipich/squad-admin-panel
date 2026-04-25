const BASE_MS = 1000;
const CAP_MS = 30_000;

export function nextBackoffMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 0) return BASE_MS;
  const exp = BASE_MS * 2 ** Math.trunc(attempts);
  return Math.min(exp, CAP_MS);
}
