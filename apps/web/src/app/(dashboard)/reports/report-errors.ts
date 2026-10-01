import { ApiError, describeHttpError } from '@/lib/api';

/** Caption for a failed report action: `HTTP <status>: <API error code>`. */
export function describeReportError(error: unknown): string {
  if (!(error instanceof ApiError)) return describeHttpError(error);
  return `HTTP ${error.status}: ${error.jsonBody<{ error?: unknown }>()?.error ?? 'unknown'}`;
}
