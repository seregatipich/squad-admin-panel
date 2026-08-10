/**
 * Pure helpers for the BANNAME-3 «Ник забанен» badge / quick-add flow on the
 * player card. Kept dependency-free (no fetch, no React) so they're testable
 * in isolation from {@link NickBanSection}.
 */

export interface NickBanCheckRule {
  id: string;
  pattern: string;
  match_type: string;
  action: string;
  reason: string | null;
  is_active: boolean;
}

export interface NickBanCheckResponse {
  matched: boolean;
  rule: NickBanCheckRule | null;
  can_mutate: boolean;
}

/** Builds the `/api/v1/banned-names/check?nick=` URL, encoding the nickname safely. */
export function buildCheckUrl(nick: string): string {
  return `/api/v1/banned-names/check?nick=${encodeURIComponent(nick)}`;
}

/** Deep-links to the matched rule's row on `/banned-names` (highlighted there via `?rule=`). */
export function ruleHref(ruleId: string): string {
  return `/banned-names?rule=${encodeURIComponent(ruleId)}`;
}
