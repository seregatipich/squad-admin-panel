import { ru } from './dictionaries/ru';
import type { TranslationKey, Translator } from './translate';

/**
 * Shape of the error envelope the API returns for failed requests, e.g.
 * `{ error: { code: 'rate_limited', message: '…' } }`.
 */
export interface ApiErrorEnvelope {
  error?: { code?: string | null; message?: string | null } | null;
}

const KNOWN_KEYS = new Set<string>(Object.keys(ru));

/**
 * Extracts the machine-readable `code` from an API error response body,
 * tolerating any non-conforming shape by returning `null`.
 */
export function extractApiErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as ApiErrorEnvelope).error;
  if (typeof error !== 'object' || error === null) return null;
  return typeof error.code === 'string' ? error.code : null;
}

/**
 * Maps an API error `code` to a localized message via the `errors.<code>`
 * translation key. Unknown or missing codes fall back to `errors.unknown`, so
 * the UI never leaks a raw backend code or an untranslated English string.
 */
export function localizeApiError(t: Translator, code: string | null | undefined): string {
  const key = `errors.${code}`;
  if (code && KNOWN_KEYS.has(key)) {
    return t(key as TranslationKey);
  }
  return t('errors.unknown');
}
