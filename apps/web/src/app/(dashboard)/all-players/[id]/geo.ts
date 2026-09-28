/**
 * Regional-indicator flag emoji for an ISO 3166-1 alpha-2 country code
 * (`"RU"` → 🇷🇺), or the "no flag" placeholder for anything else.
 *
 * Shared between the player card's own IP-history rendering (`page.tsx`) and
 * `GeoAnomaliesSection` (#447) — both draw the same flag next to a country
 * name, and kept the identical implementation duplicated until now.
 */
export function flagEmoji(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return '🏳️';
  const base = 0x1f1e6;
  const upper = countryCode.toUpperCase();
  const first = upper.charCodeAt(0) - 65;
  const second = upper.charCodeAt(1) - 65;
  if (first < 0 || first > 25 || second < 0 || second > 25) return '🏳️';
  return String.fromCodePoint(base + first) + String.fromCodePoint(base + second);
}
